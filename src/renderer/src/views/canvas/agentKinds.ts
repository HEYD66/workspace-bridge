// 卡片背后是哪种 AI：内置的（工作台用 API Key 直接调模型）写模型名；外部的写它用哪个客户端连进来的。
// 数据从哪来：
// - 内置：window.bridge.getAgentModel(id) 有返回值就是内置，里面有模型名
// - 外部、在线：state.presence[].clientName（客户端连接时自己报的名字）
// - 外部、离线：后台不记上次是哪个客户端，这里把见过的名字存在界面本地，下次离线时还能写出来；从没见过的写「外部 AI」
import { useEffect, useMemo, useState } from 'react'
import type { AgentModel, BridgeState } from '../../../../shared/api'

export interface AgentKind {
  kind: 'builtin' | 'external'
  /** 卡片上写的短名字，如「DeepSeek deepseek-chat」「Claude」「外部 AI」 */
  label: string
  /** 鼠标停上去的完整说明 */
  title: string
}

const KEY = 'wb.canvas.clients'

/** 常见客户端报上来的名字 → 好认的叫法；认不出的原样显示 */
const CLIENTS: [RegExp, string][] = [
  [/claude[-_ ]?code/i, 'Claude Code'],
  [/claude/i, 'Claude'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/cline/i, 'Cline'],
  [/gemini/i, 'Gemini'],
  [/copilot|vscode|visual studio code/i, 'VS Code'],
  [/kiro/i, 'Kiro'],
  [/trae/i, 'Trae'],
  [/mcp-remote/i, '网页 AI（经 mcp-remote）'],
  [/inspector/i, 'MCP 调试工具']
]

export function clientLabel(clientName: string): string {
  for (const [re, label] of CLIENTS) if (re.test(clientName)) return label
  return clientName.length > 24 ? `${clientName.slice(0, 24)}…` : clientName
}

function loadSeen(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** 纯函数：按手上的数据算每个 AI 是哪种 */
export function agentKinds(agentIds: readonly string[], models: Readonly<Record<string, AgentModel | null>>, online: Readonly<Record<string, string>>, seen: Readonly<Record<string, string>>): Record<string, AgentKind> {
  const out: Record<string, AgentKind> = {}
  for (const id of agentIds) {
    const m = models[id]
    if (m) {
      out[id] = { kind: 'builtin', label: m.model, title: `内置 AI：工作台用你的 API Key 直接调模型 ${m.model}` }
      continue
    }
    const now = online[id]
    const before = seen[id]
    if (now) out[id] = { kind: 'external', label: clientLabel(now), title: `外部 AI：现在用「${now}」这个客户端连着` }
    else if (before) out[id] = { kind: 'external', label: clientLabel(before), title: `外部 AI：上次是用「${before}」这个客户端连进来的（现在没连着）` }
    else out[id] = { kind: 'external', label: '外部 AI', title: '外部 AI：用 token 接入的客户端。它还没在这台电脑的这个界面上连过，不知道是哪一种' }
  }
  return out
}

/** 每个 AI 是哪种；模型绑定变了（'providers'）会自己重读 */
export function useAgentKinds(state: BridgeState): Record<string, AgentKind> {
  const ids = useMemo(() => state.agents.map((a) => a.id), [state.agents])
  const idsKey = ids.join(',')
  const [models, setModels] = useState<Record<string, AgentModel | null>>({})
  const [seen, setSeen] = useState<Record<string, string>>(loadSeen)

  useEffect(() => {
    let live = true
    const read = (): void => {
      void Promise.all(ids.map((id) => window.bridge.getAgentModel(id).then((m) => [id, m] as const, () => [id, null] as const))).then((list) => {
        if (live) setModels(Object.fromEntries(list))
      })
    }
    read()
    const off = window.bridge.onChanged((kind) => kind === 'providers' && read())
    return () => {
      live = false
      off()
    }
    // ids 的内容变了才重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  const online = useMemo(() => {
    const o: Record<string, string> = {}
    for (const p of state.presence ?? []) if (p.clientName) o[p.agentId] = p.clientName
    return o
  }, [state.presence])

  // 见到一个新的客户端名字就记下来（离线以后还能写出来）
  useEffect(() => {
    const changed = Object.entries(online).filter(([id, name]) => seen[id] !== name)
    if (changed.length === 0) return
    const next = { ...seen, ...Object.fromEntries(changed) }
    setSeen(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // 存不了就只在这次打开期间记着
    }
  }, [online, seen])

  return useMemo(() => agentKinds(ids, models, online, seen), [ids, models, online, seen])
}
