import { Check, FolderPlus, UsersRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BridgeState } from '../../../shared/api'
import { errText } from '../lib/format'
import { onWorkspaceDialog, type WorkspaceDialogRequest } from '../lib/workspaceDialog'
import { Avatar, Badge, Button, cx, Segmented } from './ui'

type Mode = 'picked' | 'all'

/** 文件夹名：路径最后一段 */
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * 选哪些 AI 能用这个工作区。加工作区时默认一个都不勾（你来选）；
 * 「所有 AI」是老行为：以后新加的 AI 也能用。挂在 App 上，由 lib/workspaceDialog 叫出来
 */
export function WorkspaceMembersDialog({ state }: { state: BridgeState }) {
  const [req, setReq] = useState<WorkspaceDialogRequest | null>(null)
  const [mode, setMode] = useState<Mode>('picked')
  const [sel, setSel] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(
    () =>
      onWorkspaceDialog((r) => {
        setError('')
        setBusy(false)
        if (r.kind === 'add') {
          setMode('picked')
          setSel([])
        } else {
          const ws = state.workspaces?.find((w) => w.id === r.workspaceId)
          setMode(ws?.members ? 'picked' : 'all')
          setSel(ws?.members ?? state.agents.map((a) => a.id))
        }
        setReq(r)
      }),
    [state.workspaces, state.agents]
  )

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setReq(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req, busy])

  if (!req) return null
  const ws = req.kind === 'members' ? state.workspaces?.find((w) => w.id === req.workspaceId) : undefined
  if (req.kind === 'members' && !ws) return null
  const title = req.kind === 'add' ? `添加工作区「${baseName(req.root)}」` : `「${ws!.name}」能用的 AI`
  const root = req.kind === 'add' ? req.root : ws!.root
  const agents = state.agents
  const picked = agents.map((a) => a.id).filter((id) => sel.includes(id))

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const members = mode === 'all' ? null : picked
      if (req.kind === 'add') await window.bridge.addWorkspaceAt(req.root, members)
      else await window.bridge.setWorkspaceMembers(req.workspaceId, members)
      setReq(null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" data-workspace-members>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-full w-full max-w-md overflow-auto rounded-lg border border-line bg-panel shadow-2xl">
        <div className="border-b border-line-soft px-5 py-4">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {req.kind === 'add' ? <FolderPlus size={15} className="text-accent" /> : <UsersRound size={15} className="text-accent" />}
            <span className="truncate">{title}</span>
          </div>
          <div className="selectable mt-1 truncate font-mono text-[11px] text-faint" title={root}>
            {root}
          </div>
        </div>
        <div className="space-y-3 px-5 py-4">
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'picked', label: '只给勾选的 AI', title: '名单外的 AI 看不到、用不了这个工作区' },
              { value: 'all', label: '所有 AI', title: '包括以后新加的 AI（以前的工作区都是这样）' }
            ]}
          />
          {mode === 'picked' ? (
            <div className="rounded-md border border-line-soft bg-canvas p-1.5">
              <div className="flex items-center justify-between px-1.5 pb-1 text-[11px] text-muted">
                <span>
                  勾上的能用（{picked.length}/{agents.length}）
                </span>
                <span className="flex gap-2">
                  <button type="button" className="cursor-pointer hover:text-fg" onClick={() => setSel(agents.map((a) => a.id))}>
                    全选
                  </button>
                  <button type="button" className="cursor-pointer hover:text-fg" onClick={() => setSel([])}>
                    全不选
                  </button>
                </span>
              </div>
              <div className="max-h-72 overflow-auto">
                {agents.length === 0 && <div className="px-1.5 py-2 text-xs text-muted">还没有 AI，先在团队页新建。</div>}
                {agents.map((a) => {
                  const on = sel.includes(a.id)
                  return (
                    <button
                      type="button"
                      key={a.id}
                      role="checkbox"
                      aria-checked={on}
                      data-member-option={a.id}
                      onClick={() => setSel((cur) => (cur.includes(a.id) ? cur.filter((id) => id !== a.id) : [...cur, a.id]))}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-hover"
                    >
                      <span className={cx('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border', on ? 'border-accent bg-accent text-[#0d1117]' : 'border-line')}>
                        {on && <Check size={10} strokeWidth={3} />}
                      </span>
                      <Avatar name={a.name} color={a.color} size={18} />
                      <span className={cx('min-w-0 flex-1 truncate text-xs', !on && 'text-muted')}>{a.name}</span>
                      {a.machineAccess && <Badge className="shrink-0">整台电脑</Badge>}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-line-soft bg-canvas px-3 py-2.5 text-xs leading-relaxed text-muted">现在的 {agents.length} 个 AI 和以后新加的 AI 都能用这个工作区。</div>
          )}
          <div className="text-[11px] leading-relaxed text-faint">
            没勾的 AI：工作区列表里没有它，读写不了里面的文件，进不了它的群聊，开了「整台电脑」也不能用绝对路径进来；命令不能在这个目录里执行，也不能在命令里写它的路径（只是按文字拦，不是沙箱）。
            {req.kind === 'members' ? '能不能用变了的 AI 会断开重连，拿到新的工作区列表。' : '只有勾上的 AI 会因为加了工作区断开重连。'}
          </div>
          {error && <div className="text-xs text-bad">{error}</div>}
        </div>
        <div className="flex justify-end gap-1.5 border-t border-line-soft px-5 py-3">
          <Button variant="ghost" disabled={busy} onClick={() => setReq(null)}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '处理中…' : req.kind === 'add' ? (mode === 'picked' && picked.length === 0 ? '添加（先不给 AI）' : '添加') : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
