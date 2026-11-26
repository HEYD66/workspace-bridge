// 内置 AI 的存储：数据目录/llm.json（提供方、AI 的模型绑定），数据目录/chats/<agentId>.json（对话）。
// apiKey 只在主进程里用，不发给界面；能加密时用主进程注入的 SecretBox（Electron safeStorage）加密
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { JsonStore } from '../jsonStore'
import type { AgentModel, ChatMessage, ChatToolCall, ModelProviderView, ProviderInput, ProviderKind } from '../types'
import { normalizeBaseUrl } from './providers'

/** 主进程注入的加密：seal 不可用时返回 null（退回明文存储）；open 解不开时抛错 */
export interface SecretBox {
  seal(plain: string): string | null
  open(sealed: string): string
}

interface StoredKey {
  /** safe：SecretBox 加密后的字符串；plain：明文（系统不支持加密时） */
  enc: 'safe' | 'plain'
  value: string
}

export interface StoredProvider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  models: string[]
  apiKey?: StoredKey
}

interface LlmFile {
  providers: StoredProvider[]
  /** agentId → 模型绑定 */
  agents: Record<string, AgentModel>
}

const MAX_MODELS = 500
const MAX_SYSTEM_PROMPT = 20_000
const MAX_STEPS_LIMIT = 200

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function cleanModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names = raw.map((m) => str(m).trim().slice(0, 200)).filter(Boolean)
  return [...new Set(names)].slice(0, MAX_MODELS)
}

/** 校验并规范化模型绑定（界面传来的和文件里读到的都过一遍） */
export function normalizeAgentModel(raw: unknown): AgentModel {
  const o = obj(raw)
  const providerId = str(o.providerId).trim()
  if (!providerId) throw new Error('请选择模型提供方')
  const model = str(o.model).trim().slice(0, 200)
  if (!model) throw new Error('请填写模型名')
  const out: AgentModel = { providerId, model }
  const prompt = str(o.systemPrompt).trim()
  if (prompt) out.systemPrompt = prompt.slice(0, MAX_SYSTEM_PROMPT)
  if (finite(o.temperature)) out.temperature = Math.round(Math.min(2, Math.max(0, o.temperature)) * 100) / 100
  if (finite(o.maxSteps)) out.maxSteps = Math.min(MAX_STEPS_LIMIT, Math.max(1, Math.round(o.maxSteps)))
  if (o.autoTasks === true) out.autoTasks = true
  return out
}

/** 读文件时只留结构对的提供方：手改过或旧版本的文件不至于让整个功能崩掉 */
function readProvider(raw: unknown): StoredProvider | undefined {
  const o = obj(raw)
  const kind = o.kind === 'anthropic' || o.kind === 'openai' ? o.kind : undefined
  if (!kind || !str(o.id) || !str(o.baseUrl)) return undefined
  const key = obj(o.apiKey)
  const apiKey: StoredKey | undefined =
    (key.enc === 'safe' || key.enc === 'plain') && str(key.value) ? { enc: key.enc, value: str(key.value) } : undefined
  return { id: str(o.id), name: str(o.name) || str(o.id), kind, baseUrl: str(o.baseUrl), models: cleanModels(o.models), ...(apiKey ? { apiKey } : {}) }
}

export class LlmStore {
  private readonly json: JsonStore<LlmFile>

  constructor(
    file: string,
    private readonly secrets: SecretBox | undefined,
    onChange?: () => void
  ) {
    this.json = new JsonStore<LlmFile>(file, () => ({ providers: [], agents: {} }), onChange)
  }

  private data(): LlmFile {
    const d = this.json.get()
    const providers = (Array.isArray(d.providers) ? d.providers : []).map(readProvider).filter((p): p is StoredProvider => !!p)
    const agents: Record<string, AgentModel> = {}
    for (const [id, m] of Object.entries(obj(d.agents))) {
      try {
        agents[id] = normalizeAgentModel(m)
      } catch {
        // 坏掉的绑定当作没绑定
      }
    }
    return { providers, agents }
  }

  private mutate(fn: (d: LlmFile) => void): void {
    const d = this.data()
    fn(d)
    this.json.set(d)
  }

  // ---------- 提供方 ----------

  private view(p: StoredProvider): ModelProviderView {
    return { id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, hasKey: !!p.apiKey, models: [...p.models] }
  }

  listProviders(): ModelProviderView[] {
    return this.data().providers.map((p) => this.view(p))
  }

  getProvider(id: string): StoredProvider | undefined {
    return this.data().providers.find((p) => p.id === id)
  }

  private seal(key: string): StoredKey {
    let sealed: string | null = null
    try {
      sealed = this.secrets?.seal(key) ?? null
    } catch {
      // 加密不可用（例如 Linux 没有密钥环）：退回明文，不让保存失败
      sealed = null
    }
    return sealed ? { enc: 'safe', value: sealed } : { enc: 'plain', value: key }
  }

  /** 取明文 apiKey 发请求用；没填返回 undefined（Ollama 等本地服务不需要） */
  apiKeyOf(p: StoredProvider): string | undefined {
    if (!p.apiKey) return undefined
    if (p.apiKey.enc === 'plain') return p.apiKey.value
    try {
      if (!this.secrets) throw new Error('no secret box')
      return this.secrets.open(p.apiKey.value)
    } catch {
      throw new Error(`「${p.name}」的 API Key 解不开（换了电脑或系统账号后会这样），请在设置里重新填写`)
    }
  }

  saveProvider(input: ProviderInput): ModelProviderView {
    const i = obj(input)
    const kind: ProviderKind | undefined = i.kind === 'anthropic' ? 'anthropic' : i.kind === 'openai' ? 'openai' : undefined
    if (!kind) throw new Error('不支持的接口类型')
    const name = str(i.name).trim().slice(0, 40)
    if (!name) throw new Error('名字不能为空')
    const baseUrl = normalizeBaseUrl(kind, str(i.baseUrl))
    const id = str(i.id)
    const existing = id ? this.getProvider(id) : undefined
    if (id && !existing) throw new Error('提供方不存在，可能已被删除')

    let apiKey = existing?.apiKey
    if (typeof i.apiKey === 'string') {
      // 复制粘贴常带空格；换行或 NUL 会让请求头非法，直接拒绝
      const k = i.apiKey.trim()
      if (/[\r\n\0]/.test(k)) throw new Error('API Key 里有换行或空字符，请重新复制')
      apiKey = k ? this.seal(k) : undefined
    }
    const p: StoredProvider = {
      id: existing?.id ?? 'p_' + crypto.randomBytes(6).toString('hex'),
      name,
      kind,
      baseUrl,
      models: Array.isArray(i.models) ? cleanModels(i.models) : (existing?.models ?? []),
      ...(apiKey ? { apiKey } : {})
    }
    this.mutate((d) => {
      d.providers = existing ? d.providers.map((x) => (x.id === p.id ? p : x)) : [...d.providers, p]
    })
    return this.view(p)
  }

  /** 删除提供方，并解除用到它的 AI 的绑定；返回被解绑的 agentId */
  removeProvider(id: string): string[] {
    const affected: string[] = []
    this.mutate((d) => {
      d.providers = d.providers.filter((p) => p.id !== id)
      for (const [agentId, m] of Object.entries(d.agents)) {
        if (m.providerId !== id) continue
        affected.push(agentId)
        delete d.agents[agentId]
      }
    })
    return affected
  }

  // ---------- 备份恢复（不含 API Key） ----------

  /** 导出提供方（不含 API Key，只标 hasKey）和模型绑定 */
  exportForBackup(): { providers: (Omit<StoredProvider, 'apiKey'> & { hasKey: boolean })[]; agents: Record<string, AgentModel> } {
    const d = this.data()
    return { providers: d.providers.map(({ apiKey, ...p }) => ({ ...p, models: [...p.models], hasKey: !!apiKey })), agents: { ...d.agents } }
  }

  /**
   * 导入提供方和模型绑定：按 id 合并。已有的提供方保留本机的 API Key，只更新名字、类型、地址、模型；
   * 新的提供方没有 Key，要用户重新填。坏条目丢掉；绑定到不存在的提供方或 AI 的绑定丢掉
   */
  importFromBackup(input: { providers?: unknown; agents?: unknown }, agentExists: (id: string) => boolean): { added: string[]; updated: string[]; needKey: string[]; bindings: number; dropped: number } {
    const out = { added: [] as string[], updated: [] as string[], needKey: [] as string[], bindings: 0, dropped: 0 }
    this.mutate((d) => {
      for (const raw of Array.isArray(input.providers) ? input.providers : []) {
        const o = obj(raw)
        const kind: ProviderKind | undefined = o.kind === 'anthropic' ? 'anthropic' : o.kind === 'openai' ? 'openai' : undefined
        const id = str(o.id).trim()
        const name = str(o.name).trim().slice(0, 40)
        let baseUrl = ''
        try {
          baseUrl = kind ? normalizeBaseUrl(kind, str(o.baseUrl)) : ''
        } catch {
          baseUrl = ''
        }
        if (!kind || !/^[\w-]{1,64}$/.test(id) || !name || !baseUrl) {
          out.dropped++
          continue
        }
        const existing = d.providers.find((p) => p.id === id)
        const p: StoredProvider = { id, name, kind, baseUrl, models: cleanModels(o.models), ...(existing?.apiKey ? { apiKey: existing.apiKey } : {}) }
        if (existing) {
          d.providers = d.providers.map((x) => (x.id === id ? p : x))
          out.updated.push(name)
        } else {
          d.providers.push(p)
          out.added.push(name)
        }
        if (!p.apiKey && o.hasKey === true) out.needKey.push(name)
      }
      for (const [agentId, m] of Object.entries(obj(input.agents))) {
        try {
          const model = normalizeAgentModel(m)
          if (!agentExists(agentId) || !d.providers.some((p) => p.id === model.providerId)) {
            out.dropped++
            continue
          }
          d.agents[agentId] = model
          out.bindings++
        } catch {
          out.dropped++
        }
      }
    })
    return out
  }

  // ---------- 模型绑定 ----------

  agentModels(): Record<string, AgentModel> {
    return this.data().agents
  }

  getAgentModel(agentId: string): AgentModel | undefined {
    return this.data().agents[agentId]
  }

  setAgentModel(agentId: string, model: AgentModel | null): void {
    const next = model === null ? null : normalizeAgentModel(model)
    if (next && !this.getProvider(next.providerId)) throw new Error('模型提供方不存在，可能已被删除')
    this.mutate((d) => {
      if (next) d.agents[agentId] = next
      else delete d.agents[agentId]
    })
  }
}

// ---------- 对话 ----------

export interface SavedChat {
  messages: ChatMessage[]
  usage?: { input: number; output: number }
}

/** agentId 会拼进文件名，只允许 config 生成的那种 id，防止 ../ 越出目录 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

function readToolCall(raw: unknown): ChatToolCall | undefined {
  const o = obj(raw)
  if (!str(o.name)) return undefined
  const status = o.status === 'ok' || o.status === 'error' || o.status === 'running' ? o.status : 'error'
  return { id: str(o.id), name: str(o.name), args: obj(o.args), status, ...(typeof o.result === 'string' ? { result: o.result } : {}) }
}

function readMessage(raw: unknown): ChatMessage | undefined {
  const o = obj(raw)
  if ((o.role !== 'user' && o.role !== 'assistant') || typeof o.content !== 'string') return undefined
  const toolCalls = Array.isArray(o.toolCalls) ? o.toolCalls.map(readToolCall).filter((c): c is ChatToolCall => !!c) : []
  return {
    id: str(o.id) || crypto.randomUUID(),
    role: o.role,
    content: o.content,
    ts: finite(o.ts) ? o.ts : Date.now(),
    ...(typeof o.reasoning === 'string' && o.reasoning ? { reasoning: o.reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(typeof o.error === 'string' && o.error ? { error: o.error } : {})
  }
}

export class ChatFiles {
  constructor(private readonly dir: string) {}

  static validId(agentId: string): boolean {
    return AGENT_ID_RE.test(agentId)
  }

  private file(agentId: string): string {
    if (!ChatFiles.validId(agentId)) throw new Error('AI id 不合法')
    return path.join(this.dir, `${agentId}.json`)
  }

  load(agentId: string): SavedChat {
    const file = this.file(agentId)
    if (!fs.existsSync(file)) return { messages: [] }
    try {
      const j = obj(JSON.parse(fs.readFileSync(file, 'utf8')))
      const messages = (Array.isArray(j.messages) ? j.messages : []).map(readMessage).filter((m): m is ChatMessage => !!m)
      const u = obj(j.usage)
      return { messages, ...(finite(u.input) && finite(u.output) ? { usage: { input: u.input, output: u.output } } : {}) }
    } catch {
      // 不静默丢对话：损坏的文件留一份备份
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
      return { messages: [] }
    }
  }

  save(agentId: string, chat: SavedChat): void {
    const file = this.file(agentId)
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(chat), 'utf8')
    fs.renameSync(tmp, file)
  }

  remove(agentId: string): void {
    fs.rmSync(this.file(agentId), { force: true })
  }
}
