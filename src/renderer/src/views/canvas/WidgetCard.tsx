// 画布上的工具卡片：终端、网页、文件。撑满外面给的大小；位置、大小、拖动归外面管。
// 上面一条标题栏可以拿来拖；下面的内容区带 data-cv-nodrag，鼠标和键盘留给里面的东西。
//
// 三种各自怎么做的：
// - 终端：用工作台现成的终端（lib/terminals），和底部面板里的是同一批。同一个终端只能显示在一处，
//   在底部面板里点开它，画布上这张就空了，点一下卡片再拿回来。
// - 网页：用右栏的网页标签那一套（BrowserTabView，Electron 的 <webview>）。手机上看工作台时没有 <webview>，只显示网址。
// - 文件：一个简单的文本编辑框（不是右边那个完整的编辑器：那个在缩放过的画布里光标位置会错位）。
//   Ctrl+S 保存，带防覆盖：保存时发现文件被别人改过会停下来问。要高亮、要查找就点「在编辑器里打开」。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { BridgeState } from '../../../../shared/api'
import type { CanvasWidget } from '../../../../shared/canvasDoc'
import { Button, cx } from '../../components/ui'
import { createTerminal, fitTerminal, mountTerminal, useTerminals } from '../../lib/terminals'
import { BrowserTabView } from '../BrowserTab'
import { errText } from './canvasApi'

export interface WidgetCardProps {
  state: BridgeState
  widget: CanvasWidget
  onRemove(): void
  /** 卡片自己要改记下来的东西（终端重新开了、网页跳转了、标题变了）；外面发一条 editWidget */
  onEdit?(patch: { termId?: string | null; url?: string; title?: string }): void
  /** 在工作台的编辑器 / 文件页里打开这个文件；不给就不显示那个按钮 */
  onOpenFile?(workspaceId: string, path: string): void
  /** 画布现在缩放到多少（1 = 原大）。太小时不让里面的东西接鼠标，免得点错 */
  zoom?: number
}

const KIND_LABEL: Record<CanvasWidget['kind'], string> = { terminal: '终端', web: '网页', file: '文件' }

export function WidgetCard(props: WidgetCardProps) {
  const { state, widget, onRemove } = props
  const ws = state.workspaces.find((w) => w.id === widget.workspaceId)
  const [askRemove, setAskRemove] = useState(false)
  const title = widget.title || (widget.kind === 'file' ? widget.path : widget.kind === 'web' ? widget.url : widget.path || ws?.name) || KIND_LABEL[widget.kind]

  let body: ReactNode
  if (!ws) body = <Blank>这张卡片属于的项目已经不在了。</Blank>
  else if (widget.kind === 'terminal') body = <TerminalBody {...props} />
  else if (widget.kind === 'web') body = <WebBody {...props} />
  else body = <FileBody {...props} />

  return (
    <div data-canvas-part="widget" data-widget-id={widget.id} data-widget-kind={widget.kind} className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-line bg-panel text-xs text-fg shadow-[0_6px_18px_rgba(0,0,0,0.4)]">
      <div className="flex h-7 shrink-0 cursor-grab items-center gap-2 border-b border-line px-2">
        <span className="shrink-0 rounded bg-raised px-1 text-muted">{KIND_LABEL[widget.kind]}</span>
        <span className="min-w-0 flex-1 truncate" title={`${title}${ws ? `\n项目：${ws.name}` : ''}`}>
          {title}
        </span>
        <span data-cv-nodrag className="flex shrink-0 items-center gap-1">
          {askRemove ? (
            <>
              <button type="button" className="cursor-pointer rounded px-1 text-bad hover:bg-hover" onClick={onRemove}>
                {widget.kind === 'terminal' ? '确认拿掉' : '确认关掉'}
              </button>
              <button type="button" className="cursor-pointer rounded px-1 text-muted hover:bg-hover" onClick={() => setAskRemove(false)}>
                留着
              </button>
            </>
          ) : (
            <button type="button" title={widget.kind === 'terminal' ? '从画布上拿掉（终端本身不关，底部面板里还在）' : '从画布上关掉这张卡片'} aria-label="关掉" className="cursor-pointer rounded px-1 text-muted hover:bg-hover hover:text-fg" onClick={() => setAskRemove(true)}>
              ✕
            </button>
          )}
        </span>
      </div>
      <div data-cv-nodrag data-cv-scroll className="relative min-h-0 flex-1" onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  )
}

function Blank({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center leading-5 text-muted">{children}</div>
}

// ========== 终端 ==========

function TerminalBody({ widget, onEdit }: WidgetCardProps) {
  const { list, loaded, creating, error } = useTerminals()
  const hostRef = useRef<HTMLDivElement>(null)
  const info = widget.termId ? list.find((t) => t.id === widget.termId) : undefined
  const exited = info?.exitCode !== undefined
  const [here, setHere] = useState(true)
  const [busy, setBusy] = useState(false)
  const termId = info?.id

  const mount = useCallback(() => {
    const host = hostRef.current
    if (!host || !termId || host.clientWidth === 0 || host.clientHeight === 0) return undefined
    setHere(true)
    return mountTerminal(termId, host, { focus: false })
  }, [termId])

  useEffect(() => mount(), [mount])

  // 卡片拉大拉小时重排行列；顺便看一眼终端的界面还在不在这张卡片里（被底部面板拿走了就提示）
  useEffect(() => {
    const host = hostRef.current
    if (!host || !termId) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fitTerminal(termId))
    })
    ro.observe(host)
    const mo = new MutationObserver(() => setHere(host.childElementCount > 0))
    mo.observe(host, { childList: true })
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [termId])

  const open = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const t = await createTerminal({ workspaceId: widget.workspaceId, ...(widget.path ? { cwd: widget.path } : {}) })
      if (t) onEdit?.({ termId: t.id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div ref={hostRef} data-terminal-host className="selectable absolute inset-0 bg-canvas" onPointerDown={() => !here && mount()} />
      {!info && (
        <Blank>
          {!loaded ? (
            '正在找回终端…'
          ) : (
            <>
              <span>{widget.termId ? '原来那个终端已经关了（工作台重启后终端不会留着）。' : '还没开终端。'}</span>
              <Button size="sm" variant="primary" disabled={busy || creating} onClick={() => void open()}>
                {busy || creating ? '正在开…' : '在这里开一个终端'}
              </Button>
              {error && <span className="text-bad">{error}</span>}
            </>
          )}
        </Blank>
      )}
      {info && !here && (
        <Blank>
          <span>这个终端现在显示在别处（底部面板或右栏）。</span>
          <Button size="sm" onClick={() => mount()}>
            拿回画布上
          </Button>
        </Blank>
      )}
      {exited && here && <div className="pointer-events-none absolute top-1 right-2 rounded bg-raised px-1 text-muted">已退出</div>}
    </>
  )
}

// ========== 网页 ==========

// 网页里按 Ctrl+T / Ctrl+W 不响应：关小窗只走标题栏上的 ✕（那里要确认）
function WebBody({ widget, onEdit, zoom }: WidgetCardProps) {
  const remote = (window.bridge as { isRemote?: boolean }).isRemote === true
  const url = widget.url ?? 'about:blank'
  if (remote) {
    return (
      <Blank>
        <span>在手机 / 浏览器里看工作台时，画布上放不了网页。</span>
        <a href={url} target="_blank" rel="noreferrer" className="break-all text-accent underline">
          {url}
        </a>
      </Blank>
    )
  }
  // 画布缩得很小的时候盖一层，免得滚轮和点击落进网页里
  const far = zoom !== undefined && zoom < 0.5
  return (
    <div className="absolute inset-0">
      <BrowserTabView id={widget.id} url={url} active onChange={(p) => onEdit?.({ ...(p.url ? { url: p.url } : {}), ...(p.title ? { title: p.title } : {}) })} onNewTab={() => undefined} onClose={() => undefined} />
      {far && <div className="absolute inset-0" title="放大一点再操作网页" />}
    </div>
  )
}

// ========== 文件 ==========

interface Loaded {
  text: string
  version?: string
}

function FileBody({ widget, onOpenFile }: WidgetCardProps) {
  const path = widget.path ?? ''
  const wsId = widget.workspaceId
  const [disk, setDisk] = useState<Loaded>()
  const [text, setText] = useState('')
  const [block, setBlock] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  /** 保存时发现磁盘上的已经变了 */
  const [conflict, setConflict] = useState(false)
  const dirty = disk !== undefined && text !== disk.text
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const load = useCallback(
    async (force: boolean): Promise<void> => {
      // 有没保存的字就不自动重读，免得把正在敲的冲掉
      if (!force && dirtyRef.current) return
      try {
        const f = await window.bridge.readFile(wsId, path)
        if (f.error) setBlock(f.error)
        else if (f.binary) setBlock('这是二进制文件，不能在这里改。')
        else if (f.tooLarge || f.content === undefined) setBlock('文件太大，不能在这里改。')
        else {
          // 编辑框里一律用 \n
          const t = f.content.replace(/\r\n/g, '\n')
          setBlock('')
          setDisk({ text: t, version: f.version })
          setText(t)
          setConflict(false)
        }
        setError('')
      } catch (e) {
        setError(errText(e))
      }
    },
    [wsId, path]
  )

  useEffect(() => {
    setDisk(undefined)
    void load(true)
  }, [load])

  const save = async (overwrite = false): Promise<void> => {
    if (!disk || busy || !dirty) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      // 换行符不用自己换：后台保存时保持文件原来的编码和换行符
      const r = await window.bridge.saveFile(wsId, path, text, overwrite ? undefined : disk.version)
      setDisk({ ...disk, text, version: r.version })
      setConflict(false)
      setNote('已保存')
    } catch (e) {
      const msg = errText(e)
      if (/CONFLICT|被改过|被删除/.test(msg)) setConflict(true)
      else setError(msg)
    } finally {
      setBusy(false)
    }
  }

  if (block) {
    return (
      <Blank>
        <span>{block}</span>
        {onOpenFile && (
          <Button size="sm" onClick={() => onOpenFile(wsId, path)}>
            在文件页里打开
          </Button>
        )}
      </Blank>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <textarea
        value={text}
        spellCheck={false}
        disabled={!disk}
        onChange={(e) => {
          setText(e.target.value)
          setNote('')
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            void save()
          } else if (e.key === 'Tab' && !e.shiftKey) {
            // Tab 打两个空格，不跳到别的按钮上
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: a, selectionEnd: b } = el
            const next = `${text.slice(0, a)}  ${text.slice(b)}`
            setText(next)
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
          }
        }}
        onWheel={(e) => e.stopPropagation()}
        placeholder={disk ? '' : '正在读…'}
        className="selectable min-h-0 flex-1 resize-none bg-canvas p-2 font-mono text-xs leading-5 text-fg outline-none"
        style={{ tabSize: 2, whiteSpace: 'pre', overflowWrap: 'normal', overflow: 'auto' }}
      />
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line px-2">
        {conflict ? (
          <>
            <span className="min-w-0 flex-1 truncate text-warn" title="你打开之后，这个文件被别的途径（AI、编辑器）改过">
              文件被别处改过了
            </span>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void save(true)} title="用你这里的内容盖掉别处的改动">
              照我的存
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void load(true)} title="丢掉你这里没保存的字，读磁盘上现在的">
              读新的
            </Button>
          </>
        ) : (
          <>
            <span className={cx('min-w-0 flex-1 truncate', error ? 'text-bad' : 'text-muted')} title={error || undefined}>
              {error || (dirty ? '有改动没保存（Ctrl+S 保存）' : note || '和磁盘上的一样')}
            </span>
            {onOpenFile && (
              <Button size="sm" variant="ghost" onClick={() => onOpenFile(wsId, path)} title="要语法高亮、查找替换，去完整的编辑器">
                在编辑器里打开
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => void load(true)} title="重新读磁盘上的内容（AI 改过以后点一下）">
              重读
            </Button>
            <Button size="sm" variant={dirty ? 'primary' : 'default'} disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export default WidgetCard
