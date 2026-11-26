// 工具试用台：JSON Schema（工具的 inputSchema）↔ 表单。纯函数，不碰 DOM，测试直接导入

export type FieldKind = 'string' | 'text' | 'number' | 'integer' | 'boolean' | 'enum' | 'lines' | 'json'

export interface FormField {
  name: string
  kind: FieldKind
  required: boolean
  description?: string
  /** enum 的选项（原值，可能是数字） */
  options?: unknown[]
  /** lines：每一项的类型 */
  itemKind?: 'string' | 'number' | 'integer' | 'boolean'
  default?: unknown
}

type Schema = Record<string, unknown>

const isObj = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v)

/** 去掉 null 分支：{ type: ['string','null'] }、anyOf: [X, {type:'null'}] 都当 X */
function unwrap(s: Schema): Schema {
  if (Array.isArray(s.type)) {
    const t = (s.type as string[]).filter((x) => x !== 'null')
    if (t.length === 1) return { ...s, type: t[0] }
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const alts = s[key]
    if (!Array.isArray(alts)) continue
    const nonNull = alts.filter((a) => !(isObj(a) && a.type === 'null'))
    if (nonNull.length === 1 && isObj(nonNull[0])) return { ...nonNull[0], ...(s.description ? { description: s.description } : {}) }
    // 全是 const：当枚举
    if (nonNull.every((a) => isObj(a) && 'const' in a)) return { enum: nonNull.map((a) => (a as Schema).const), description: s.description }
  }
  return s
}

/** 长文本：参数名像正文，或者描述里说了多行 */
const LONG_NAMES = /^(content|text|body|patch|diff|command|script|code|query|prompt|message|description|input)$/i

function fieldOf(name: string, raw: Schema, required: boolean): FormField {
  const s = unwrap(raw)
  const base = { name, required, ...(typeof s.description === 'string' ? { description: s.description } : {}), ...('default' in s ? { default: s.default } : {}) }
  if (Array.isArray(s.enum)) return { ...base, kind: 'enum', options: s.enum }
  switch (s.type) {
    case 'string':
      return { ...base, kind: LONG_NAMES.test(name) || (typeof s.maxLength === 'number' && s.maxLength > 500) ? 'text' : 'string' }
    case 'number':
      return { ...base, kind: 'number' }
    case 'integer':
      return { ...base, kind: 'integer' }
    case 'boolean':
      return { ...base, kind: 'boolean' }
    case 'array': {
      const items = isObj(s.items) ? unwrap(s.items) : undefined
      const t = items?.type
      if (!items?.enum && (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean')) return { ...base, kind: 'lines', itemKind: t }
      return { ...base, kind: 'json' }
    }
    default:
      return { ...base, kind: 'json' }
  }
}

/** inputSchema → 表单字段，按 properties 的顺序；必填的排前面 */
export function schemaToFields(schema: unknown): FormField[] {
  if (!isObj(schema) || !isObj(schema.properties)) return []
  const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const fields = Object.entries(schema.properties).map(([k, v]) => fieldOf(k, isObj(v) ? v : {}, req.has(k)))
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)]
}

/** 表单里存的都是字符串（boolean 是 '' / 'true' / 'false'，enum 是选项下标） */
export type FormValues = Record<string, string>

function scalar(kind: 'string' | 'number' | 'integer' | 'boolean', v: string, label: string): unknown {
  if (kind === 'string') return v
  if (kind === 'boolean') {
    if (v === 'true') return true
    if (v === 'false') return false
    throw new Error(`${label}要填 true 或 false`)
  }
  const n = Number(v)
  if (!Number.isFinite(n) || v.trim() === '') throw new Error(`${label}不是数字：${v}`)
  if (kind === 'integer' && !Number.isInteger(n)) throw new Error(`${label}要填整数：${v}`)
  return n
}

/**
 * 表单 → 调用参数。空着的可选项不传；必填项空着、格式不对时抛错（message 给用户看）。
 * 必填的字符串空着时传 ''：空字符串是合法值（比如写一个空文件）
 */
export function valuesToArgs(fields: FormField[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = values[f.name] ?? ''
    const isStr = f.kind === 'string' || f.kind === 'text'
    const empty = f.kind === 'lines' ? v.split(/\r?\n/).every((l) => !l.trim()) : isStr ? v === '' : v.trim() === ''
    if (empty && !(isStr && f.required)) {
      if (f.required) throw new Error(`「${f.name}」是必填项`)
      continue
    }
    switch (f.kind) {
      case 'string':
      case 'text':
        out[f.name] = v
        break
      case 'number':
      case 'integer':
      case 'boolean':
        out[f.name] = scalar(f.kind, v.trim(), `「${f.name}」`)
        break
      case 'enum': {
        const i = Number(v)
        if (!f.options || !Number.isInteger(i) || i < 0 || i >= f.options.length) throw new Error(`「${f.name}」选项不对`)
        out[f.name] = f.options[i]
        break
      }
      case 'lines':
        out[f.name] = v
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l, i) => scalar(f.itemKind ?? 'string', l, `「${f.name}」第 ${i + 1} 行`))
        break
      case 'json':
        try {
          out[f.name] = JSON.parse(v)
        } catch (e) {
          throw new Error(`「${f.name}」不是合法的 JSON：${(e as Error).message}`)
        }
        break
    }
  }
  return out
}

/** 调用参数 → 表单（回填最近的调用、从原始 JSON 切回表单）。表单装不下的键不管（原始 JSON 里还在） */
export function argsToValues(fields: FormField[], args: Record<string, unknown>): FormValues {
  const out: FormValues = {}
  for (const f of fields) {
    if (!(f.name in args)) continue
    const v = args[f.name]
    switch (f.kind) {
      case 'enum': {
        const i = (f.options ?? []).findIndex((o) => o === v)
        if (i >= 0) out[f.name] = String(i)
        break
      }
      case 'lines':
        out[f.name] = Array.isArray(v) ? v.map(String).join('\n') : JSON.stringify(v)
        break
      case 'json':
        out[f.name] = JSON.stringify(v, null, 2)
        break
      default:
        out[f.name] = typeof v === 'string' ? v : JSON.stringify(v)
    }
  }
  return out
}

/** 表单的初始值：用 schema 里的 default */
export function defaultValues(fields: FormField[]): FormValues {
  const withDefault = fields.filter((f) => f.default !== undefined)
  return argsToValues(withDefault, Object.fromEntries(withDefault.map((f) => [f.name, f.default])))
}

/** 结果里的一段 text：是 JSON 就格式化，不是就原样 */
export function prettyText(text: string): { json: boolean; text: string } {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return { json: false, text }
  try {
    return { json: true, text: JSON.stringify(JSON.parse(t), null, 2) }
  } catch {
    return { json: false, text }
  }
}
