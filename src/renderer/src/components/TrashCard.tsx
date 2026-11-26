import { File, Folder, RefreshCw, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { BridgeState, TrashEntry } from '../../../shared/api'
import { errText, formatBytes, timeAgo } from '../lib/format'
import { Badge, Button, Card, ConfirmButton } from './ui'

/** 一次最多画这么多行，再多只提示数量（回收站可能积了几千项） */
const MAX_ROWS = 200

const SOURCE_TEXT: Record<TrashEntry['source'], string> = { delete: '删除', rollback: '回滚移走', skill: '技能' }

function sizeText(it: TrashEntry): string {
  const size = `${it.sizeCapped ? '至少 ' : ''}${formatBytes(it.bytes)}`
  return it.kind === 'dir' ? `${size} · ${it.sizeCapped ? '至少 ' : ''}${it.files} 个文件` : size
}

/**
 * 设置页的回收站：AI 和用户删除、覆盖的文件，回滚时移走的新建文件，删掉的技能都在这里。
 * 整个工作台共用一个，所以每项标出原来在哪个工作区
 */
export function TrashCard({ state }: { state: BridgeState }) {
  const [items, setItems] = useState<TrashEntry[] | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const active = (state.workspaces ?? []).find((w) => w.id === state.activeWorkspaceId)

  const load = useCallback(async () => {
    try {
      setItems(await window.bridge.listTrash())
    } catch (e) {
      setError(errText(e))
    }
  }, [])

  useEffect(() => {
    void load()
    return window.bridge.onChanged((kind) => {
      if (kind === 'trash') void load()
    })
  }, [load])

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key)
    setError('')
    setNote('')
    try {
      setNote(await fn())
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
      await load()
    }
  }

  const restore = (it: TrashEntry) =>
    act(`restore:${it.id}`, async () => {
      const r = await window.bridge.restoreTrash(it.id)
      const ws = (state.workspaces ?? []).find((w) => w.id === r.workspaceId)
      return `已恢复 ${it.name} → ${ws ? `${ws.name}：` : ''}${r.path}`
    })

  const purge = (ids?: string[]) =>
    act(ids ? `purge:${ids[0]}` : 'empty', async () => {
      const r = await window.bridge.purgeTrash(ids)
      const failed = r.failed.length ? `，${r.failed.length} 项没删掉（文件可能被占用）` : ''
      return `${ids ? '已彻底删除' : '已清空'} ${r.removed} 项，腾出 ${formatBytes(r.bytes)}${failed}`
    })

  const list = items ?? []
  const total = list.reduce((n, x) => n + x.bytes, 0)
  const capped = list.some((x) => x.sizeCapped)

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Trash2 size={15} className="text-accent" />
        <span className="text-[13px] font-medium">回收站</span>
        {items && (
          <Badge>
            {list.length} 项{list.length ? ` · ${capped ? '至少 ' : ''}${formatBytes(total)}` : ''}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" disabled={!!busy} onClick={() => void load()}>
            <RefreshCw size={13} /> 刷新
          </Button>
          {list.length > 0 && (
            <ConfirmButton confirmText={`${list.length} 项全部彻底删除，恢复不了，再点一次确认`} onConfirm={() => void purge()}>
              清空
            </ConfirmButton>
          )}
        </div>
      </div>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-muted">
        AI 和你删除、覆盖的文件，回滚时移走的新建文件，删掉的技能都在这里，所有工作区共用一个。恢复是放回原来的位置；那里已经有同名的东西就不覆盖。AI 也能看、恢复和清空（trash_list / trash_restore /
        trash_empty）。
      </p>
      {error && <div className="mb-2 text-xs text-bad">{error}</div>}
      {note && <div className="mb-2 text-xs text-ok">{note}</div>}
      {items === null ? (
        <div className="text-xs text-faint">正在读取…</div>
      ) : list.length === 0 ? (
        <div className="rounded-md border border-line bg-canvas px-3 py-4 text-center text-xs text-faint">回收站是空的</div>
      ) : (
        <div className="max-h-96 divide-y divide-line overflow-auto rounded-md border border-line bg-canvas">
          {list.slice(0, MAX_ROWS).map((it) => {
            const Icon = it.source === 'skill' ? Sparkles : it.kind === 'dir' ? Folder : File
            const where = it.restoreTo ?? it.originalPath
            // 老版本删的没有记原位置：只能放进当前工作区
            const legacy = !it.restoreTo
            return (
              <div key={it.id} className="flex items-center gap-3 px-3 py-2">
                <Icon size={14} className="shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="selectable truncate text-xs text-fg" title={it.name}>
                      {it.name}
                    </span>
                    <Badge>{SOURCE_TEXT[it.source]}</Badge>
                    {it.workspaceName && <Badge>{it.workspaceName}</Badge>}
                  </div>
                  <div className="selectable mt-0.5 truncate font-mono text-[11px] text-faint" title={where}>
                    {where}
                  </div>
                  <div className="mt-0.5 text-[11px] text-faint">
                    {timeAgo(it.deletedAt)} · {sizeText(it)}
                    {legacy && <span className="text-warn"> · 没有记原位置，恢复会放进当前工作区{active ? `「${active.name}」` : ''}</span>}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={!!busy || (legacy && !active)}
                  title={legacy ? (active ? `放进「${active.name}」里的 ${it.originalPath}` : '先添加工作区') : `放回 ${where}`}
                  onClick={() => void restore(it)}
                >
                  <Undo2 size={13} /> {busy === `restore:${it.id}` ? '恢复中…' : '恢复'}
                </Button>
                <ConfirmButton confirmText="恢复不了，确认删除？" onConfirm={() => void purge([it.id])}>
                  彻底删除
                </ConfirmButton>
              </div>
            )
          })}
          {list.length > MAX_ROWS && <div className="px-3 py-2 text-center text-[11px] text-faint">还有 {list.length - MAX_ROWS} 项没有列出来（清空会一起删掉）</div>}
        </div>
      )}
    </Card>
  )
}
