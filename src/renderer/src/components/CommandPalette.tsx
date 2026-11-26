// 命令面板（Ctrl+Shift+P / Ctrl+K）：键盘跳到任何页面、任何 AI / 频道 / 工作区，执行常用操作
import { Command } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { BridgeState } from '../../../core/types'
import { cx } from './ui'

export interface PaletteItem {
  id: string
  /** 分组名，显示在右边 */
  group: string
  title: string
  /** 额外参与匹配的词（拼音首字母、英文名等） */
  keywords?: string
  hint?: string
  run: () => void | Promise<void>
}

/** 子序列匹配打分：连续命中、词首命中加分；不匹配返回 -1 */
export function paletteScore(q: string, text: string): number {
  if (!q) return 0
  const t = text.toLowerCase()
  const s = q.toLowerCase().trim()
  if (!s) return 0
  const direct = t.indexOf(s)
  if (direct >= 0) return 1000 - direct * 2 + (direct === 0 ? 200 : 0)
  let score = 0
  let ti = 0
  let run = 0
  for (const ch of s) {
    if (ch === ' ') continue
    const i = t.indexOf(ch, ti)
    if (i < 0) return -1
    run = i === ti ? run + 1 : 0
    score += 10 + run * 5 - Math.min(9, i - ti)
    ti = i + 1
  }
  return score
}

export function filterPalette(items: PaletteItem[], q: string, max = 60): PaletteItem[] {
  if (!q.trim()) return items.slice(0, max)
  return items
    .map((it, i) => ({ it, i, s: paletteScore(q, `${it.title} ${it.keywords ?? ''} ${it.group}`) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.it)
}

export function CommandPalette({ open, items, onClose }: { open: boolean; items: PaletteItem[]; onClose: () => void; state?: BridgeState }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => filterPalette(items, q), [items, q])

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      setError('')
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])
  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  if (!open) return null
  const choose = async (i: number) => {
    const it = rows[i]
    if (!it) return
    try {
      await it.run()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const n = rows.length
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      if (n) setSel((s) => (s + 1) % n)
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      if (n) setSel((s) => (s - 1 + n) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void choose(sel)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="命令面板"
        className="flex h-fit max-h-[60vh] w-[620px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line-soft p-2">
          <Command size={14} className="ml-1 text-faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="跳到页面、AI、频道、工作区，或执行操作…"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-accent bg-canvas px-2.5 text-[13px] text-fg outline-none placeholder:text-faint"
          />
        </div>
        {error && <div className="px-3 py-2 text-xs text-bad">{error}</div>}
        {rows.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted">没有匹配的命令</div>
        ) : (
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
            {rows.map((r, i) => (
              <div
                key={r.id}
                data-row={i}
                onMouseMove={() => sel !== i && setSel(i)}
                onClick={() => void choose(i)}
                className={cx('mx-1 flex h-[28px] cursor-pointer items-center gap-2 rounded px-2', i === sel ? 'bg-accent/20' : 'hover:bg-hover')}
              >
                <span className="truncate text-[13px] text-fg">{r.title}</span>
                {r.hint && <span className="truncate text-[11px] text-faint">{r.hint}</span>}
                <span className="ml-auto shrink-0 text-[11px] text-faint">{r.group}</span>
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">↑↓ 选择 · Enter 执行 · Esc 关闭 · Ctrl+P 快速打开文件</div>
      </div>
    </div>
  )
}
