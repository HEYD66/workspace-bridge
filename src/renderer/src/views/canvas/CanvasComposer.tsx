// 画布上直接说话：对一张卡片（一个 AI）说，或者框选几张一起说。发到项目的群聊里并 @ 上它们，
// 下面显示这些 AI 在这个频道里最近的几条发言，不用离开画布去群聊页。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GroupMessage } from '../../../../core/types'
import { Button, cx } from '../../components/ui'
import { MAX_TEXT, mentionText, sendGroupChat, snippet, useGroupMessages } from '../../lib/groupChat'
import { navigate } from '../../lib/nav'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const AWAY_LABEL: Record<string, string> = { offline: '没连着', stuck: '可能卡住了', paused: '暂停中' }

export interface ComposerTarget {
  id: string
  name: string
  /** 卡片的状态（CanvasCardState）；offline / stuck / paused 的会提示「现在收不到」 */
  state?: string
}

export interface CanvasComposerProps {
  /** 发到哪个频道（项目的主群聊是 `ws:<工作区 id>`） */
  channel: string
  /** 对谁说：一个是对一个 AI 说，多个是群发 */
  targets: ComposerTarget[]
  /** 显示最近几条发言，默认 3 */
  recent?: number
  onSent?: (m: GroupMessage) => void
  autoFocus?: boolean
  /**
   * 先替用户填进输入框的话（比如把文件拖到卡片上：「看一下这个文件：路径」）。给了就接在已经写的字后面，光标放最后。
   * 同一个值只填一次；要再填一遍同样的话，带上不同的 initialSeq
   */
  initialText?: string
  initialSeq?: number
}

function timeLabel(ts: number): string {
  const d = new Date(ts)
  const same = new Date().toDateString() === d.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return same ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export function CanvasComposer({ channel, targets, recent = 3, onSent, autoFocus, initialText, initialSeq }: CanvasComposerProps) {
  const store = useGroupMessages(channel)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const filled = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!initialText) return
    const key = `${initialSeq ?? 0}\u0000${initialText}`
    if (filled.current === key) return
    filled.current = key
    setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')} ${initialText}` : initialText))
    requestAnimationFrame(() => {
      const el = box.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [initialText, initialSeq])

  const ids = useMemo(() => new Set(targets.map((t) => t.id)), [targets])
  // 这些 AI 在这个频道里最近的发言（群里说的，不含私聊）
  const said = useMemo(() => store.messages.filter((m) => m.from.kind === 'agent' && ids.has(m.from.id) && !m.to).slice(-recent), [store.messages, ids, recent])
  const away = targets.filter((t) => t.state && AWAY_LABEL[t.state])
  const mentions = targets.map((t) => mentionText(t.name)).join('')
  const tooLong = mentions.length + text.length > MAX_TEXT

  const send = async () => {
    const body = text.trim()
    if (!body || busy || tooLong || targets.length === 0) return
    setBusy(true)
    setError('')
    try {
      const m = await sendGroupChat({ channel, text: `${mentions}${body}` })
      setText('')
      onSent?.(m)
      box.current?.focus()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 回车发送，Shift+回车换行；输入法正在选字时的回车不算
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
    // 别让画布的快捷键（空格拖动、删除键）吃掉输入
    e.stopPropagation()
  }

  const who = targets.length === 1 ? targets[0].name : `${targets.length} 个 AI`

  return (
    <div className="flex flex-col gap-2 text-xs text-fg" data-canvas-part="composer" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      {targets.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted">发给：</span>
          {targets.map((t) => (
            <span key={t.id} className={cx('rounded bg-raised px-1.5 py-0.5', t.state && AWAY_LABEL[t.state] && 'text-muted')} title={t.state && AWAY_LABEL[t.state] ? `${t.name} ${AWAY_LABEL[t.state]}` : t.name}>
              {t.name}
            </span>
          ))}
        </div>
      )}
      {away.length > 0 && (
        <div className="text-warn">
          {away.map((t) => `${t.name}（${AWAY_LABEL[t.state!]}）`).join('、')} 现在收不到，消息会留在群里，等它回来才看得到。
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={box}
          value={text}
          autoFocus={autoFocus}
          rows={2}
          placeholder={targets.length === 0 ? '先选一张 AI 的卡片' : `对 ${who} 说…（回车发送，Shift+回车换行）`}
          disabled={targets.length === 0}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onKeyUp={(e) => e.stopPropagation()}
          className="min-h-[44px] flex-1 resize-y rounded-md border border-line bg-panel px-2 py-1.5 text-xs text-fg outline-none placeholder:text-muted focus:border-accent"
        />
        <Button size="md" variant="primary" disabled={busy || !text.trim() || tooLong || targets.length === 0} onClick={() => void send()}>
          {busy ? '发送中…' : '发送'}
        </Button>
      </div>
      {tooLong && <div className="text-bad">太长了，一条最多 {MAX_TEXT} 字。</div>}
      {error && <div className="text-bad">没发出去：{error}</div>}

      <div className="flex flex-col gap-1">
        <div className="flex items-center text-muted">
          <span className="flex-1">{targets.length === 1 ? '它最近说的' : '它们最近说的'}</span>
          <button type="button" className="cursor-pointer hover:text-fg" onClick={() => navigate({ section: 'group', id: channel })}>
            去群聊看全部
          </button>
        </div>
        {store.loading && !store.loaded && <div className="text-muted">正在读…</div>}
        {store.error && <div className="text-bad">读不了群聊：{store.error}</div>}
        {store.loaded && said.length === 0 && <div className="text-muted">{targets.length === 1 ? '它' : '它们'}在这个群里还没说过话。</div>}
        {said.map((m) => (
          <div key={m.id} className="rounded border border-line/70 bg-panel px-2 py-1" title={m.text}>
            <div className="flex gap-2 text-muted">
              {targets.length > 1 && <span style={{ color: m.from.color }}>{m.from.name}</span>}
              <span>{timeLabel(m.ts)}</span>
            </div>
            <div className="whitespace-pre-wrap break-words">{snippet(m.text, 280)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default CanvasComposer
