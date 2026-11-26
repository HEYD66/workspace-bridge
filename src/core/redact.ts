// 写日志（活动事件、审计文件）前统一脱敏，令牌原值不落盘、不进工作台

export const REDACTED = '[REDACTED]'

/** 太短的值不当密钥替换，免得把普通文字误换掉 */
const MIN_SECRET_LEN = 8

export interface RedactOptions {
  /**
   * full（默认）：已知令牌原值 + Bearer、/mcp/<令牌> 路径段、token=xxx / "token": "xxx" 这类写法；
   * light：只换已知令牌原值和 Bearer，用于 diff 这类代码内容，免得把正常代码改得认不出
   */
  mode?: 'full' | 'light'
}

/** 把文本里的令牌换成 [REDACTED] */
export function redactText(text: string, secrets: readonly string[] = [], opts: RedactOptions = {}): string {
  let out = text
  // 长的先换，避免一个令牌是另一个的前缀时只换掉一半
  const known = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LEN))].sort((a, b) => b.length - a.length)
  for (const s of known) out = out.split(s).join(REDACTED)
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
  if (opts.mode === 'light') return out
  out = out.replace(/(\/mcp\/)(?!\[REDACTED\])[^/\s?#"'`<>]{8,}/g, `$1${REDACTED}`)
  out = out.replace(/\b([\w-]*token)=(?!\[REDACTED\])[^\s&"'`,;]{8,}/gi, `$1=${REDACTED}`)
  out = out.replace(/("[\w-]*token"\s*:\s*")(?!\[REDACTED\])[^"]{8,}"/gi, `$1${REDACTED}"`)
  return out
}

/** 递归脱敏：字符串逐个处理，对象和数组逐层处理，其他值原样返回 */
export function redactValue<T>(value: T, secrets: readonly string[] = [], opts: RedactOptions = {}, depth = 0): T {
  if (typeof value === 'string') return redactText(value, secrets, opts) as T
  if (depth > 20 || !value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, opts, depth + 1)) as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, secrets, opts, depth + 1)
  return out as T
}
