import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditReader, csvCell } from '../src/core/auditReader'

let dir: string
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0)
const H = 3600_000

function ev(i: number, ts: number, over: Record<string, unknown> = {}) {
  return { id: `e${i}`, ts, agentId: i % 2 ? 'a-maya' : 'a-arena', agentName: i % 2 ? 'Maya' : 'Arena', agentColor: '#fff', tool: i % 3 ? 'read_file' : 'write_file', args: { path: `f${i}.ts` }, status: i % 5 === 0 ? 'error' : 'ok', durationMs: i, ...over }
}
function writeDay(day: string, events: unknown[]) {
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-audit-'))
  // 前天、昨天、今天各几条；文件内按时间追加
  writeDay('2026-11-04', [ev(1, NOW - 50 * H), ev(2, NOW - 49 * H)])
  writeDay('2026-11-05', [ev(3, NOW - 30 * H), ev(4, NOW - 20 * H), ev(5, NOW - 13 * H, { summary: '写了 secret-ish 文件' })])
  writeDay('2026-11-06', [ev(6, NOW - 5 * H), ev(7, NOW - 2 * H), ev(8, NOW - H, { workspaceId: 'w1' }), 'not json'])
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const reader = () => new AuditReader(dir, () => NOW)

describe('AuditReader', () => {
  it('默认 7 天、新的在前，跨天读，坏行跳过', async () => {
    const r = await reader().query()
    expect(r.rows.map((x) => x.id)).toEqual(['e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e2', 'e1'])
    expect(r.truncated).toBe(false)
    expect(r.nextCursor).toBeUndefined()
  })

  it('按时间、AI、工具、状态、工作区、全文筛选', async () => {
    const q = reader()
    expect((await q.query({ from: NOW - 24 * H })).rows.map((x) => x.id)).toEqual(['e8', 'e7', 'e6', 'e5', 'e4'])
    expect((await q.query({ agentId: 'a-maya' })).rows.every((x) => x.agentName === 'Maya')).toBe(true)
    expect((await q.query({ tool: 'write_file' })).rows.map((x) => x.id)).toEqual(['e6', 'e3'])
    expect((await q.query({ status: 'error' })).rows.map((x) => x.id)).toEqual(['e5'])
    expect((await q.query({ workspaceId: 'w1' })).rows.map((x) => x.id)).toEqual(['e8'])
    expect((await q.query({ text: 'SECRET-ish' })).rows.map((x) => x.id)).toEqual(['e5'])
    expect((await q.query({ text: 'f7.ts' })).rows.map((x) => x.id)).toEqual(['e7'])
  })

  it('分页：limit + nextCursor 跨文件接着翻，不重不漏', async () => {
    const q = reader()
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const p = await q.query({ limit: 3, cursor })
      seen.push(...p.rows.map((x) => x.id))
      cursor = p.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(['e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e2', 'e1'])
  })

  it('统计按工具、按 AI', async () => {
    const s = await reader().stats()
    expect(s.total).toBe(8)
    expect(s.errors).toBe(1)
    expect(s.byTool[0]).toMatchObject({ tool: 'read_file', calls: 6 })
    expect(s.byAgent.map((a) => a.agentName).sort()).toEqual(['Arena', 'Maya'])
  })

  it('导出 CSV：带 BOM 和表头，逗号 / 引号 / 换行转义，防公式注入', async () => {
    const r = await reader().exportCsv({ tool: 'write_file' })
    expect(r.rows).toBe(2)
    expect(r.csv.startsWith('\ufeff时间,AI,工具')).toBe(true)
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
    expect(csvCell('=cmd()')).toBe("'=cmd()")
    expect(csvCell(undefined)).toBe('')
  })

  it('目录不存在时返回空', async () => {
    const r = await new AuditReader(path.join(dir, 'nope'), () => NOW).query()
    expect(r.rows).toEqual([])
  })
})
