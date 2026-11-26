// 画布上的一张便签：撑满外面给的大小。双击改字，失焦或 Ctrl+回车保存，Esc 放弃；可以换颜色、删掉。
// 位置和拖动归外面管；这里只在改字的时候把鼠标留给自己（data-cv-nodrag）。
import { useEffect, useRef, useState } from 'react'
import type { CanvasNote } from '../../../../shared/canvasDoc'
import { cx } from '../../components/ui'

/** 便签颜色：名字存进 CanvasNote.color；没有颜色的按 yellow 画 */
export const NOTE_COLORS: Record<string, { label: string; bg: string; border: string; text: string }> = {
  yellow: { label: '黄', bg: '#3b3320', border: '#6b5a1e', text: '#f0e2b0' },
  green: { label: '绿', bg: '#1f3526', border: '#2f6b3f', text: '#c5ecd0' },
  blue: { label: '蓝', bg: '#1d2f45', border: '#2f5c8f', text: '#c9dff7' },
  pink: { label: '粉', bg: '#40222f', border: '#8a3b5c', text: '#f5cfe0' },
  purple: { label: '紫', bg: '#2f2545', border: '#5d4a96', text: '#dcd2f7' },
  gray: { label: '灰', bg: '#262626', border: '#444444', text: '#d6d6d6' }
}

export function noteColor(color: string | undefined): { bg: string; border: string; text: string } {
  if (color && NOTE_COLORS[color]) return NOTE_COLORS[color]
  // AI 可能直接给了 #rrggbb：拿它当边框色
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return { bg: '#262626', border: color, text: '#e6e6e6' }
  return NOTE_COLORS.yellow
}

function when(ts: number): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return new Date().toDateString() === d.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

export interface NoteCardProps {
  note: CanvasNote
  onEdit(patch: { text?: string; color?: string | null }): void
  onRemove(): void
  /** 新贴的便签：一出来就进入改字 */
  startEditing?: boolean
}

export function NoteCard({ note, onEdit, onRemove, startEditing }: NoteCardProps) {
  const [editing, setEditing] = useState(!!startEditing)
  const [draft, setDraft] = useState(note.text)
  const [askRemove, setAskRemove] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const c = noteColor(note.color)

  useEffect(() => {
    if (!editing) setDraft(note.text)
  }, [note.text, editing])
  useEffect(() => {
    if (editing) {
      box.current?.focus()
      box.current?.setSelectionRange(box.current.value.length, box.current.value.length)
    }
  }, [editing])

  const save = (): void => {
    setEditing(false)
    const text = draft.trim()
    // 改空了不存（要删就点删除），内容没变也不存
    if (text && text !== note.text) onEdit({ text })
    else setDraft(note.text)
  }
  const cancel = (): void => {
    setDraft(note.text)
    setEditing(false)
  }

  return (
    <div
      data-canvas-part="note"
      data-note-id={note.id}
      className="group/note flex h-full w-full flex-col overflow-hidden rounded-md border text-xs shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
      style={{ background: c.bg, borderColor: c.border, color: c.text }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <div className="flex h-6 shrink-0 items-center gap-1 px-2 opacity-80">
        <span className="min-w-0 flex-1 truncate" title={`${note.byName} 贴于 ${new Date(note.createdAt).toLocaleString()}${note.updatedAt > note.createdAt ? `，${new Date(note.updatedAt).toLocaleString()} 改过` : ''}`}>
          {note.by === 'user' ? '你' : note.byName} · {when(note.updatedAt)}
        </span>
        <div className={cx('items-center gap-1', editing || askRemove ? 'flex' : 'hidden group-hover/note:flex')} data-cv-nodrag>
          {askRemove ? (
            <>
              <button type="button" className="cursor-pointer rounded px-1 text-bad hover:bg-black/30" onClick={onRemove}>
                确认删
              </button>
              <button type="button" className="cursor-pointer rounded px-1 hover:bg-black/30" onClick={() => setAskRemove(false)}>
                不删
              </button>
            </>
          ) : (
            <>
              {Object.entries(NOTE_COLORS).map(([name, v]) => (
                <button
                  key={name}
                  type="button"
                  title={`换成${v.label}色`}
                  aria-label={`换成${v.label}色`}
                  className={cx('h-3 w-3 cursor-pointer rounded-full border', (note.color ?? 'yellow') === name ? 'border-white' : 'border-transparent')}
                  style={{ background: v.border }}
                  onClick={() => onEdit({ color: name })}
                />
              ))}
              <button type="button" title="改字（也可以双击便签）" className="cursor-pointer rounded px-1 hover:bg-black/30" onClick={() => setEditing(true)}>
                改
              </button>
              <button type="button" title="删掉这张便签" className="cursor-pointer rounded px-1 hover:bg-black/30" onClick={() => setAskRemove(true)}>
                删
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          ref={box}
          data-cv-nodrag
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') cancel()
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) save()
          }}
          onKeyUp={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          placeholder="写点什么…（Ctrl+回车保存，Esc 放弃）"
          className="min-h-0 flex-1 resize-none bg-transparent px-2 pb-2 text-xs leading-5 outline-none placeholder:opacity-50"
          style={{ color: c.text }}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words px-2 pb-2 leading-5" title="双击改字">
          {note.text}
        </div>
      )}
    </div>
  )
}

export default NoteCard
