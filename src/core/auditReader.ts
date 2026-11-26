// 审计日志查看：读数据目录 audit/YYYY-MM-DD.jsonl（EventLog 写的，已脱敏），给工作台筛选、分页、统计、导出
// 文件按 UTC 日期命名、行按时间追加。查询从新到旧读，每次最多扫 MAX_SCAN_LINES 行，超出就返回 cursor 让界面接着翻
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { ActivityEvent } from './types'

export const MAX_SCAN_LINES = 200_000
export const MAX_EXPORT_ROWS = 50_000
const MAX_LIMIT = 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface AuditQuery {
  /** 毫秒时间戳，含；不传默认 7 天前 */
  from?: number
  /** 毫秒时间戳，不含；不传是现在 */
  to?: number
  agentId?: string
  tool?: string
  status?: 'ok' | 'error'
  workspaceId?: string
  /** 子串匹配（不分大小写）：工具名、AI 名、路径、摘要、错误、参数 */
  text?: string
  limit?: number
  /** 上一页返回的 nextCursor：只看早于它的记录 */
  cursor?: string
}

export interface AuditRow {
  id: string
  ts: number
  agentId: string
  agentName: string
  agentColor?: string
  tool: string
  status: string
  durationMs?: number
  workspaceId?: string
  path?: string
  summary?: string
  error?: string
  /** 参数 JSON，截到 2000 字 */
  args: string
}

export interface AuditPage {
  rows: AuditRow[]
  /** 还有更早的：带着它再查一次 */
  nextCursor?: string
  /** 扫描行数到上限就停了（结果可能不全） */
  truncated: boolean
  scannedLines: number
}

export interface AuditStats {
  total: number
  errors: number
  byTool: { tool: string; calls: number; errors: number }[]
  byAgent: { agentId: string; agentName: string; calls: number; errors: number }[]
  truncated: boolean
}

const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/** cursor = "<ts>:<id>"：比它旧（ts 更小，或 ts 相同且在它之前写入）的才要 */
function parseCursor(c: string | undefined): { ts: number; id: string } | null {
  if (!c) return null
  const i = c.indexOf(':')
  const ts = Number(c.slice(0, i))
  return Number.isFinite(ts) && i > 0 ? { ts, id: c.slice(i + 1) } : null
}

function toRow(ev: ActivityEvent): AuditRow {
  let args = ''
  try {
    args = JSON.stringify(ev.args ?? {})
  } catch {
    args = '{}'
  }
  if (args.length > 2000) args = `${args.slice(0, 2000)}…`
  return {
    id: ev.id,
    ts: ev.ts,
    agentId: ev.agentId,
    agentName: ev.agentName,
    ...(ev.agentColor ? { agentColor: ev.agentColor } : {}),
    tool: ev.tool,
    status: ev.status,
    ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
    ...(ev.workspaceId ? { workspaceId: ev.workspaceId } : {}),
    ...(ev.path ? { path: ev.path } : {}),
    ...(ev.summary ? { summary: ev.summary.slice(0, 1000) } : {}),
    ...(ev.error ? { error: ev.error.slice(0, 1000) } : {}),
    args
  }
}

export class AuditReader {
  constructor(
    private readonly auditDir: string,
    private readonly now: () => number = Date.now
  ) {}

  /** 范围内的日期文件，新的在前 */
  private files(from: number, to: number): string[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.auditDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    } catch {
      return []
    }
    const lo = dayOf(from)
    const hi = dayOf(to - 1)
    return names
      .map((n) => n.slice(0, 10))
      .filter((d) => d >= lo && d <= hi)
      .sort()
      .reverse()
      .map((d) => path.join(this.auditDir, `${d}.jsonl`))
  }

  /** 一个文件的全部行（倒序给出）。单个文件一般几 MB；超大文件也只按行读，不一次性读整块 */
  private async linesNewestFirst(file: string): Promise<string[]> {
    const out: string[] = []
    try {
      const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
      for await (const line of rl) if (line) out.push(line)
    } catch {
      // 读不了就当空的
    }
    return out.reverse()
  }

  private match(ev: ActivityEvent, q: AuditQuery, from: number, to: number, needle: string): boolean {
    if (typeof ev.ts !== 'number' || ev.ts < from || ev.ts >= to) return false
    if (q.agentId && ev.agentId !== q.agentId) return false
    if (q.tool && ev.tool !== q.tool) return false
    if (q.status && ev.status !== q.status) return false
    if (q.workspaceId && ev.workspaceId !== q.workspaceId) return false
    if (needle) {
      const hay = [ev.tool, ev.agentName, ev.path, ev.summary, ev.error, JSON.stringify(ev.args ?? {})].join('\n').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  }

  /** 遍历符合条件的记录（新到旧）；visit 返回 false 就停 */
  private async scan(q: AuditQuery, visit: (ev: ActivityEvent) => boolean, maxLines = MAX_SCAN_LINES): Promise<{ scanned: number; truncated: boolean }> {
    const to = q.to ?? this.now() + 1
    const from = q.from ?? to - 7 * DAY_MS
    const cur = parseCursor(q.cursor)
    const needle = (q.text ?? '').trim().toLowerCase()
    let scanned = 0
    for (const file of this.files(from, cur ? Math.min(to, cur.ts + 1) : to)) {
      const lines = await this.linesNewestFirst(file)
      // 带 cursor 时，先跳过 cursor 那一条和比它新的
      let skipping = !!cur
      for (const line of lines) {
        if (scanned >= maxLines) return { scanned, truncated: true }
        scanned++
        let ev: ActivityEvent
        try {
          ev = JSON.parse(line) as ActivityEvent
        } catch {
          continue
        }
        // 不是事件对象的行（坏行、手改过的）直接跳过：不能让它打断下面「跳过 cursor 之前」的判断
        if (!ev || typeof ev !== 'object' || typeof ev.ts !== 'number' || typeof ev.id !== 'string') continue
        if (skipping && cur) {
          if (ev.ts > cur.ts) continue
          if (ev.ts === cur.ts) {
            if (ev.id === cur.id) skipping = false
            continue
          }
          skipping = false
        }
        if (!this.match(ev, q, from, to, needle)) continue
        if (!visit(ev)) return { scanned, truncated: false }
      }
    }
    return { scanned, truncated: false }
  }

  async query(q: AuditQuery = {}): Promise<AuditPage> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(q.limit ?? 200)))
    const rows: AuditRow[] = []
    let more = false
    const r = await this.scan(q, (ev) => {
      if (rows.length >= limit) {
        more = true
        return false
      }
      rows.push(toRow(ev))
      return true
    })
    const last = rows[rows.length - 1]
    return {
      rows,
      ...((more || r.truncated) && last ? { nextCursor: `${last.ts}:${last.id}` } : {}),
      truncated: r.truncated,
      scannedLines: r.scanned
    }
  }

  async stats(q: Pick<AuditQuery, 'from' | 'to' | 'agentId' | 'workspaceId'> = {}): Promise<AuditStats> {
    const tools = new Map<string, { calls: number; errors: number }>()
    const agents = new Map<string, { agentName: string; calls: number; errors: number }>()
    let total = 0
    let errors = 0
    const r = await this.scan(q, (ev) => {
      total++
      const err = ev.status === 'error'
      if (err) errors++
      const t = tools.get(ev.tool) ?? { calls: 0, errors: 0 }
      t.calls++
      if (err) t.errors++
      tools.set(ev.tool, t)
      const a = agents.get(ev.agentId) ?? { agentName: ev.agentName, calls: 0, errors: 0 }
      a.calls++
      if (err) a.errors++
      agents.set(ev.agentId, a)
      return true
    })
    return {
      total,
      errors,
      byTool: [...tools].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
      byAgent: [...agents].map(([agentId, v]) => ({ agentId, ...v })).sort((a, b) => b.calls - a.calls),
      truncated: r.truncated
    }
  }

  /** 导出 CSV（UTF-8 带 BOM，Excel 直接打开不乱码）；最多 MAX_EXPORT_ROWS 行 */
  async exportCsv(q: AuditQuery = {}): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const header = ['时间', 'AI', '工具', '状态', '耗时毫秒', '工作区', '路径', '摘要', '错误', '参数']
    const lines = [header.map(csvCell).join(',')]
    let n = 0
    let capped = false
    const r = await this.scan(q, (ev) => {
      if (n >= MAX_EXPORT_ROWS) {
        capped = true
        return false
      }
      n++
      const row = toRow(ev)
      lines.push(
        [new Date(row.ts).toISOString(), row.agentName, row.tool, row.status, row.durationMs ?? '', row.workspaceId ?? '', row.path ?? '', row.summary ?? '', row.error ?? '', row.args]
          .map(csvCell)
          .join(',')
      )
      return true
    }, MAX_SCAN_LINES * 5)
    return { csv: '\ufeff' + lines.join('\r\n') + '\r\n', rows: n, truncated: capped || r.truncated }
  }
}

/** CSV 单元格：含逗号、引号、换行就加引号，引号双写；= + - @ 开头的加单引号前缀，防 Excel 公式注入 */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
