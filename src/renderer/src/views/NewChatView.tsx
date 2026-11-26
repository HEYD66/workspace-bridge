// 「新会话」页（照 Codex）：首页什么都没选时就是它。选一个项目，直接说要做什么；发出第一条消息时才建会话
import { Check, FolderPlus, MessageSquarePlus, Monitor } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BridgeState } from '../../../core/types'
import { Button, cx, EmptyState } from '../components/ui'
import { addMessages, canAccess, newThread, wsChannel } from '../lib/groupChat'
import { newChatKey } from '../lib/newChat'
import { threadTitleFrom } from '../lib/projects'
import { addWorkspaceFlow } from '../lib/workspaceDialog'
import { Composer } from './GroupChatView'

export function NewChatView({ state, onOpen }: { state: BridgeState; onOpen: (channel: string) => void }) {
  const all = state.workspaces ?? []
  /** 用户在这一页上挑的项目；没挑过就是当前工作区 */
  const [picked, setPicked] = useState<string>()
  const [choosing, setChoosing] = useState(false)
  /** 会话建好了但消息没发出去：再发时接着用这个会话，不再建一个 */
  const made = useRef<{ ws: string; channel: string } | undefined>(undefined)
  const pickRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!choosing) return
    const close = (e: MouseEvent) => {
      if (!pickRef.current?.contains(e.target as Node)) setChoosing(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChoosing(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [choosing])

  const ws = all.find((w) => w.id === picked) ?? all.find((w) => w.id === state.activeWorkspaceId) ?? all.find((w) => w.kind !== 'machine') ?? all[0]
  if (!ws)
    return (
      <EmptyState
        icon={<FolderPlus size={32} />}
        title="先添加一个项目"
        hint="项目就是你电脑上的一个文件夹。添加之后，可以在里面开会话、派任务。"
        action={
          <Button variant="primary" onClick={() => void addWorkspaceFlow()}>
            <FolderPlus size={14} /> 选一个文件夹
          </Button>
        }
      />
    )
  const members = state.agents.filter((a) => canAccess(a, wsChannel(ws.id), all))
  const online = members.filter((a) => state.presence.some((p) => p.agentId === a.id)).length

  return (
    <div data-new-chat={ws.id} className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto px-6 py-6">
        <MessageSquarePlus size={44} strokeWidth={1.2} className="shrink-0 text-faint" />
        <h1 className="text-center text-[26px] leading-snug font-medium">
          想让 AI 们在{' '}
          <span ref={pickRef} className="relative inline-block">
            <button
              aria-haspopup="listbox"
              aria-expanded={choosing}
              title="换一个项目"
              onClick={() => setChoosing((v) => !v)}
              className="cursor-pointer underline decoration-faint decoration-dotted underline-offset-[6px] hover:decoration-fg"
            >
              {ws.name}
            </button>
            {choosing && (
              <div role="listbox" aria-label="项目" className="absolute top-full left-1/2 z-30 mt-2 max-h-72 w-64 -translate-x-1/2 overflow-auto rounded-xl border border-line bg-raised py-1.5 text-left text-[13px] font-normal shadow-2xl">
                {all.map((w) => (
                  <div
                    key={w.id}
                    role="option"
                    aria-selected={w.id === ws.id}
                    onClick={() => {
                      setPicked(w.id)
                      setChoosing(false)
                    }}
                    className={cx('flex h-8 cursor-pointer items-center gap-2 px-3 hover:bg-hover', w.id === ws.id ? 'text-fg' : 'text-muted')}
                  >
                    {w.kind === 'machine' && <Monitor size={13} className="shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {w.id === ws.id && <Check size={13} className="shrink-0" />}
                  </div>
                ))}
              </div>
            )}
          </span>{' '}
          里做什么？
        </h1>
        <div className="max-w-md text-center text-xs leading-relaxed text-muted">
          {members.length ? `${members.length} 个 AI 能看到这个会话，${online} 个在线。` : '还没有能访问这个项目的 AI。'}
          发出第一条消息时建会话，标题取消息的开头。
        </div>
      </div>
      <Composer
        key={ws.id}
        state={state}
        channel={newChatKey(ws.id)}
        members={members}
        fresh={{
          placeholder: `说说要在「${ws.name}」里做什么；@名字 点名，@所有人 叫大家`,
          chip: `${ws.name} · 新会话`,
          resolve: async (text) => {
            if (made.current?.ws === ws.id) return made.current.channel
            const channel = await newThread(ws.id, threadTitleFrom(text))
            made.current = { ws: ws.id, channel }
            return channel
          }
        }}
        onSent={(m) => {
          addMessages([m])
          made.current = undefined
          onOpen(m.channel)
        }}
      />
    </div>
  )
}
