import { cx } from './ui'

const MAX_ROWS = 400

interface Row {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
  oldNo?: number
  newNo?: number
}

function parse(diff: string): Row[] {
  const rows: Row[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of diff.split('\n')) {
    // 空字符串不是 diff 的一行（空的上下文行是一个空格），是末尾换行切出来的
    if (line === '' || /^(===|---|\+\+\+|Index:|\\)/.test(line)) continue
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
    else if (rows.length) rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return rows
}

export function diffStats(diff: string): { added: number; removed: number } {
  const rows = parse(diff)
  return { added: rows.filter((r) => r.kind === 'add').length, removed: rows.filter((r) => r.kind === 'del').length }
}

/** 渲染 unified diff：跳过文件头，按增删着色并标注新旧行号 */
export function DiffView({ diff, maxHeight = 420 }: { diff: string; maxHeight?: number }) {
  const rows = parse(diff)
  const shown = rows.slice(0, MAX_ROWS)
  return (
    <div className="selectable overflow-auto rounded-md border border-line bg-canvas font-mono text-[12px] leading-[1.6]" style={{ maxHeight }}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((r, i) =>
            r.kind === 'hunk' ? (
              <tr key={i} className="bg-accent/10 text-accent/80">
                <td colSpan={3} className="px-3 py-0.5">
                  {r.text}
                </td>
              </tr>
            ) : (
              <tr key={i} className={cx(r.kind === 'add' && 'bg-ok/10', r.kind === 'del' && 'bg-bad/10')}>
                <td className="w-10 px-2 text-right align-top text-faint select-none">{r.oldNo ?? ''}</td>
                <td className="w-10 px-2 text-right align-top text-faint select-none">{r.newNo ?? ''}</td>
                <td className={cx('pr-3 break-all whitespace-pre-wrap', r.kind === 'add' && 'text-[#aff5b4]', r.kind === 'del' && 'text-[#ffdcd7]', r.kind === 'ctx' && 'text-muted')}>
                  <span className="pr-2 text-faint select-none">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
                  {r.text}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && <div className="px-3 py-2 text-xs text-muted">…还有 {rows.length - MAX_ROWS} 行未显示</div>}
    </div>
  )
}
