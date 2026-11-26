// T-21：群聊图片的界面零件：输入框里待发送的缩略图、消息里的缩略图、大图查看、图片右键菜单（逻辑在 lib/chatImages.ts）
import { Copy, ImageDown, ImageOff, Maximize2, X } from 'lucide-react'
import { useEffect, type MouseEvent } from 'react'
import type { MenuEntry } from '../lib/contextMenu'
import { dataUrlToBlob, formatBytes, imageActions, peekChatImage, thumbBox, useChatImage, type ChatAttachment, type PendingImage } from '../lib/chatImages'
import { cx, IconButton } from './ui'

/** 输入框上方：待发送的图片，可以删掉 */
export function PendingImages({ images, onRemove, disabled }: { images: PendingImage[]; onRemove: (key: string) => void; disabled?: boolean }) {
  if (!images.length) return null
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {images.map((p) => (
        <div key={p.key} className="relative h-14 w-14 overflow-hidden rounded border border-line bg-canvas" title={`${p.name} · ${formatBytes(p.size)}`}>
          <img src={p.dataUrl} alt={p.name} className="h-full w-full object-cover" draggable={false} />
          {!disabled && (
            <button
              type="button"
              title="不发这张"
              aria-label={`删掉 ${p.name}`}
              onClick={() => onRemove(p.key)}
              className="absolute top-0.5 right-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              <X size={10} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** 消息里的图片；右键由消息的菜单处理（按 data-att-id 认出点的是哪张） */
export function MessageImages({ list, onOpen }: { list: ChatAttachment[]; onOpen: (a: ChatAttachment) => void }) {
  if (!list.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {list.map((a) => (
        <Thumb key={a.id} att={a} onOpen={onOpen} />
      ))}
    </div>
  )
}

function Thumb({ att, onOpen }: { att: ChatAttachment; onOpen: (a: ChatAttachment) => void }) {
  const img = useChatImage(att.id)
  const box = thumbBox(att.width, att.height)
  const ok = img.status === 'ok'
  return (
    <button
      type="button"
      data-att-id={att.id}
      aria-disabled={!ok || undefined}
      title={img.status === 'error' ? '图片已失效' : `${att.name} · ${formatBytes(att.size)}，点开看大图`}
      onClick={() => ok && onOpen(att)}
      style={{ width: box.width, height: box.height }}
      className={cx('relative shrink-0 overflow-hidden rounded border border-line bg-canvas', ok ? 'cursor-zoom-in' : 'cursor-default', img.status === 'loading' && 'animate-pulse')}
    >
      {ok && <img src={img.url} alt={att.name} className="h-full w-full object-contain" draggable={false} />}
      {img.status === 'error' && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[11px] text-faint">
          <ImageOff size={16} />
          图片已失效
        </span>
      )}
    </button>
  )
}

/** 大图：点空白处或按 Esc 关掉 */
export function ImageViewer({ att, onClose, onContextMenu }: { att: ChatAttachment; onClose: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const img = useChatImage(att.id)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 大图上开着右键菜单时，Esc 先让菜单自己关（maya02 #275）
      if (document.querySelector('[role="menu"]')) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const can = imageActions(img.status === 'ok' ? img.url : undefined, canWriteImage())
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <div role="dialog" aria-modal="true" aria-label={`查看图片 ${att.name}`} onClick={onClose} className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-6">
      <IconButton title="关闭（Esc）" onClick={onClose} className="absolute top-3 right-3 h-8 w-8 text-white/80 hover:bg-white/10 hover:text-white">
        <X size={18} />
      </IconButton>
      {img.status === 'ok' ? (
        <img src={img.url} alt={att.name} onClick={stop} onContextMenu={onContextMenu} className="max-h-[80vh] max-w-[90vw] object-contain shadow-2xl" />
      ) : img.status === 'error' ? (
        <div className="flex flex-col items-center gap-2 text-sm text-white/70">
          <ImageOff size={28} />
          图片已失效
        </div>
      ) : (
        <div className="text-sm text-white/70">加载中…</div>
      )}
      <div onClick={stop} className="flex items-center gap-3 text-xs text-white/70">
        <span className="max-w-[50vw] truncate">
          {att.name} · {formatBytes(att.size)}
          {att.width && att.height ? ` · ${att.width}×${att.height}` : ''}
        </span>
        <ViewerButton label="复制图片" off={can.copy} onClick={() => img.status === 'ok' && void copyImage(img.url)} />
        <ViewerButton label="另存为…" off={can.save} onClick={() => img.status === 'ok' && saveImage(img.url, att.name)} />
      </div>
    </div>
  )
}

function ViewerButton({ label, off, onClick }: { label: string; off: false | string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-disabled={off ? true : undefined}
      title={off || undefined}
      onClick={() => !off && onClick()}
      className={cx('rounded border border-white/20 px-2 py-0.5', off ? 'cursor-default opacity-40' : 'cursor-pointer hover:bg-white/10 hover:text-white')}
    >
      {label}
    </button>
  )
}

/** 图片的右键菜单项：查看大图、复制图片、另存为；图片没取到时变灰。inViewer：已经在大图里，不列「查看大图」 */
export function imageMenu(att: ChatAttachment, onOpen: (a: ChatAttachment) => void, inViewer = false): MenuEntry[] {
  const url = peekChatImage(att.id)
  const can = imageActions(url, canWriteImage())
  return [
    ...(inViewer ? [] : [{ id: 'img-open', label: '查看大图', icon: <Maximize2 size={13} />, disabled: can.open, run: () => onOpen(att) }]),
    { id: 'img-copy', label: '复制图片', icon: <Copy size={13} />, disabled: can.copy, run: () => (url ? copyImage(url) : undefined) },
    { id: 'img-save', label: '另存为…', icon: <ImageDown size={13} />, disabled: can.save, run: () => (url ? saveImage(url, att.name) : undefined) }
  ]
}

function canWriteImage(): boolean {
  return typeof ClipboardItem !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.clipboard?.write === 'function'
}

/** 剪贴板只认 PNG：别的格式先画到 canvas 上转一下 */
async function copyImage(url: string): Promise<void> {
  let blob = dataUrlToBlob(url)
  if (blob.type !== 'image/png') blob = await toPng(blob)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')?.drawImage(bmp, 0, 0)
  bmp.close()
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('转换图片失败'))), 'image/png'))
}

/** 另存为：走浏览器下载，Electron 默认弹保存对话框 */
function saveImage(url: string, name: string): void {
  const href = URL.createObjectURL(dataUrlToBlob(url))
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 30_000)
}
