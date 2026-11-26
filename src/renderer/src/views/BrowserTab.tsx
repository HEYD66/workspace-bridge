// 右栏里的网页标签和新标签页。网页用 Electron 自带的 Chromium（<webview>），和工作台的界面是两个进程。
// 事件怎么接、出错时怎么说，照 arena-core（千面 Facet）的 src/main/browser-tabs.cjs。
// 指纹：网页先停在空白页，等主进程把指纹装好（prepareBrowserTab）才去加载真正的地址，不然第一页看到的是真实硬件。
import { Activity, ArrowLeft, ArrowRight, Copy, Eraser, ExternalLink, FileDiff, Files, Fingerprint, Globe, ListTodo, MapPin, MoreHorizontal, Network, RotateCw, SlidersHorizontal, SquareTerminal, Wrench, X } from 'lucide-react'
import { createElement, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cx, Switch } from '../components/ui'
import type { BrowserStatus } from '../../../shared/api'
import { errText, timeAgo } from '../lib/format'
import { BROWSER_PARTITION } from '../../../shared/browser'
import { addressToUrl, clearRecentSites, noteRecentSite, siteLabel, TOOL_LABEL, useRecentSites, type ToolId } from '../lib/rightTabs'

/** <webview> 上用到的方法（Electron 的 WebviewTag），dom-ready 之前调会抛错 */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  closeDevTools(): void
  isDevToolsOpened(): boolean
  getWebContentsId(): number
  clearHistory(): void
}

type GuestEvent = Event & { url?: string; title?: string; isMainFrame?: boolean; isInPlace?: boolean; errorCode?: number; errorDescription?: string; validatedURL?: string }

/** 地址栏：回车打开；Esc 放弃正在输的、回到当前地址 */
function AddressBar({
  value,
  onGo,
  focusSeq,
  placeholder = '搜索或输入网址',
  center
}: {
  value: string
  onGo: (url: string) => void
  /** 每加一次，把焦点放进来并全选（Ctrl+L、刚开新标签页） */
  focusSeq?: number
  placeholder?: string
  center?: boolean
}) {
  const [draft, setDraft] = useState<string>()
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(undefined), [value])
  useEffect(() => {
    if (!focusSeq) return
    ref.current?.focus()
    ref.current?.select()
  }, [focusSeq])
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      const url = addressToUrl(draft ?? value)
      if (url) {
        setDraft(undefined)
        onGo(url)
        ref.current?.blur()
      }
    } else if (e.key === 'Escape') {
      setDraft(undefined)
      ref.current?.blur()
    }
  }
  return (
    <input
      ref={ref}
      data-browser-address
      aria-label="地址"
      spellCheck={false}
      autoComplete="off"
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKey}
      onFocus={(e) => e.target.select()}
      className={cx(
        'h-7 min-w-0 flex-1 rounded-full border border-transparent bg-hover px-3 text-xs text-fg outline-none placeholder:text-muted focus:border-accent/60',
        center && 'text-center focus:text-left'
      )}
    />
  )
}

function NavButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted"
    >
      {children}
    </button>
  )
}

// ========== 新标签页 ==========

const TOOLS: { id: ToolId | 'terminal' | 'files'; icon: typeof Globe; keys?: string }[] = [
  { id: 'changes', icon: FileDiff, keys: 'Ctrl+Shift+G' },
  { id: 'terminal', icon: SquareTerminal },
  { id: 'files', icon: Files, keys: 'Ctrl+P' },
  { id: 'tasks', icon: ListTodo },
  { id: 'activity', icon: Activity }
]
const toolLabel = (id: ToolId | 'terminal' | 'files'): string => (id === 'terminal' ? '终端' : id === 'files' ? '文件' : TOOL_LABEL[id])

export function NewTabPage({
  focusSeq,
  onGo,
  onTool,
  onTerminal,
  onFiles
}: {
  focusSeq: number
  onGo: (url: string) => void
  onTool: (id: ToolId) => void
  onTerminal: () => void
  onFiles: () => void
}) {
  const recent = useRecentSites()
  const remote = window.bridge.isRemote
  return (
    <div data-right-newtab className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
        <NavButton title="后退" disabled onClick={() => undefined}>
          <ArrowLeft size={14} />
        </NavButton>
        <NavButton title="前进" disabled onClick={() => undefined}>
          <ArrowRight size={14} />
        </NavButton>
        <NavButton title="刷新" disabled onClick={() => undefined}>
          <RotateCw size={13} />
        </NavButton>
        <AddressBar value="" onGo={onGo} focusSeq={focusSeq} center />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="mb-2 text-[12.5px] font-semibold text-fg">工具</div>
        <div className="mb-5 grid grid-cols-2 gap-1.5">
          {TOOLS.map(({ id, icon: Icon, keys }) => (
            <button
              key={id}
              type="button"
              data-newtab-tool={id}
              onClick={() => (id === 'terminal' ? onTerminal() : id === 'files' ? onFiles() : onTool(id))}
              className="flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-raised px-3 text-left text-[12.5px] text-fg hover:bg-hover"
            >
              <Icon size={14} className="shrink-0 text-muted" />
              <span className="shrink-0">{toolLabel(id)}</span>
              <span className="min-w-0 flex-1" />
              {keys && <span className="min-w-0 truncate rounded bg-hover px-1.5 text-[10.5px] text-muted">{keys}</span>}
            </button>
          ))}
        </div>
        <div className="mb-1 flex items-center text-[12.5px] font-semibold text-fg">
          最近打开
          {recent.length > 0 && (
            <button type="button" className="ml-auto cursor-pointer text-[11px] font-normal text-faint hover:text-fg" onClick={clearRecentSites}>
              清空
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <div className="py-1 text-xs leading-relaxed text-muted">
            {remote ? '网页标签只能在电脑上的窗口里用。' : '还没有打开过网页。在上面输网址（比如 localhost:5173）或要搜的词，回车打开。'}
          </div>
        ) : (
          recent.map((r) => (
            <button
              key={r.url}
              type="button"
              data-newtab-recent={r.url}
              title={r.url}
              onClick={() => onGo(r.url)}
              className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] text-fg hover:bg-hover"
            >
              <Globe size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">
                {r.title || siteLabel(r.url)}
                {r.title && <span className="ml-2 text-[11.5px] text-faint">{siteLabel(r.url)}</span>}
              </span>
              <span className="shrink-0 text-[11px] text-faint">{timeAgo(r.ts)}</span>
            </button>
          ))
        )}
        {!remote && <BrowserSettings />}
      </div>
    </div>
  )
}

// ========== 指纹和 CDP 的设置（在新标签页最下面） ==========

function BrowserSettings() {
  const [st, setSt] = useState<BrowserStatus>()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let live = true
    window.bridge
      .browserStatus()
      .then((s) => live && setSt(s))
      .catch((e) => live && setErr(errText(e)))
    return () => {
      live = false
    }
  }, [])
  const [proxyDraft, setProxyDraft] = useState<string>()
  const change = (patch: { cdp?: boolean; fingerprint?: boolean; regenerate?: boolean; region?: boolean; refreshRegion?: boolean; proxy?: string }): void => {
    setBusy(true)
    setErr('')
    window.bridge
      .setBrowserPrefs(patch)
      .then((s) => {
        setSt(s)
        if (patch.proxy !== undefined) setProxyDraft(undefined)
      })
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusy(false))
  }
  const cdp = st?.cdp
  const fp = st?.fingerprint
  const region = st?.region
  const network = st?.network
  const route = !network ? '' : network.route === 'DIRECT' ? '直连（没走代理）' : network.route.replace(/^(PROXY|HTTPS|SOCKS5?|SOCKS4)\s+/i, '经代理 ')
  // 开关和这次启动的实际状态不一样：改了还没重启
  const cdpRunning = !!cdp?.activePort && cdp.ok
  const cdpPending = !!cdp && cdp.source !== 'cmdline' && cdp.source !== 'env' && cdp.enabled !== !!cdp.activePort
  return (
    <div data-browser-settings className="mt-5">
      <div className="mb-1 text-[12.5px] font-semibold text-fg">浏览器</div>
      {err && <div className="mb-1 text-xs text-bad">{err}</div>}
      <div className="rounded-lg bg-raised px-3 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-fg">
          <Fingerprint size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">指纹</span>
          <Switch data-browser-fp-switch aria-label="指纹" checked={fp?.enabled ?? false} disabled={!st || busy} onChange={(v) => change({ fingerprint: v })} />
        </label>
        <div data-browser-fp-summary className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
          {!fp ? '读取中…' : fp.enabled ? (
            <>
              网页看到的是这台「电脑」，每个标签、每次重开都一样：
              <span className="mt-1 block text-fg">
                {fp.details.map((d) => (
                  <span key={d.label} className="mr-3 inline-block">
                    <span className="text-faint">{d.label}</span> {d.value}
                  </span>
                ))}
              </span>
            </>
          ) : (
            '没开：网页看到的是这台电脑真实的显卡、屏幕、CPU 和内存。'
          )}
        </div>
        {fp?.enabled && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-browser-fp-new
              disabled={busy}
              onClick={() => change({ regenerate: true })}
              className="shrink-0 cursor-pointer rounded-md border border-line px-2 py-1 text-[11.5px] whitespace-nowrap text-fg hover:bg-hover disabled:opacity-50"
            >
              换一套
            </button>
            <span className="text-[11px] text-faint">开关和换一套，对之后打开的标签生效</span>
          </div>
        )}
      </div>
      <div className="mt-1.5 rounded-lg bg-raised px-3 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-fg">
          <MapPin size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">时区和语言跟出口 IP 走</span>
          <Switch data-browser-region-switch aria-label="时区和语言跟出口 IP 走" checked={region?.enabled ?? false} disabled={!st || busy} onChange={(v) => change({ region: v })} />
        </label>
        <div data-browser-region-state className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
          {!region ? (
            '读取中…'
          ) : !region.enabled ? (
            '没开：网页看到的是这台电脑自己的时区和语言。出口 IP 在别的国家时，这两样对不上是最常见的破绽。'
          ) : region.timezone ? (
            <>
              出口 <span className="text-fg">{region.ip}</span>（{region.country}）。网页看到的：
              <span className="mt-1 block text-fg">
                <span className="mr-3 inline-block">
                  <span className="text-faint">时区</span> {region.timezone}
                </span>
                <span className="inline-block">
                  <span className="text-faint">语言</span> {region.language}
                </span>
              </span>
            </>
          ) : (
            '还没查到出口 IP 在哪；查到之前时区和语言用的是这台电脑自己的。'
          )}
          {region?.enabled && region.error && <div className="mt-1 text-warn">{region.error}</div>}
        </div>
        {region?.enabled && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-browser-region-refresh
              disabled={busy}
              onClick={() => change({ refreshRegion: true })}
              className="shrink-0 cursor-pointer rounded-md border border-line px-2 py-1 text-[11.5px] whitespace-nowrap text-fg hover:bg-hover disabled:opacity-50"
            >
              {busy ? '查询中…' : '重新查'}
            </button>
            <span className="text-[11px] text-faint">换了节点点一下；对之后打开的标签生效</span>
          </div>
        )}
      </div>
      <div className="mt-1.5 rounded-lg bg-raised px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12.5px] text-fg">
          <Network size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">网络</span>
        </div>
        <div data-browser-network-state className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
          {!network ? '读取中…' : <>现在网页{route || '怎么走没查到'}。WebRTC 不走代理的 UDP 已禁用，不会漏出真实 IP。</>}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            data-browser-proxy
            aria-label="代理"
            spellCheck={false}
            autoComplete="off"
            placeholder="留空跟系统代理；direct 直连；或 http://127.0.0.1:端口"
            value={proxyDraft ?? network?.proxy ?? ''}
            disabled={!st || busy}
            onChange={(e) => setProxyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && proxyDraft !== undefined) change({ proxy: proxyDraft })
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-hover px-2 text-[11.5px] text-fg outline-none placeholder:text-faint focus:border-accent/60"
          />
          <button
            type="button"
            data-browser-proxy-save
            disabled={busy || proxyDraft === undefined || proxyDraft.trim() === (network?.proxy ?? '')}
            onClick={() => proxyDraft !== undefined && change({ proxy: proxyDraft })}
            className="shrink-0 cursor-pointer rounded-md border border-line px-2 py-1 text-[11.5px] whitespace-nowrap text-fg hover:bg-hover disabled:cursor-default disabled:opacity-40"
          >
            保存
          </button>
        </div>
        <div className="mt-1.5 text-[11px] leading-relaxed text-faint">想让它单独走一个节点（比如千面的节点端口），把那个端口的地址填在这里。DNS 由代理那一头去查，检测站看到的 DNS 才和出口一致。</div>
      </div>
      <div className="mt-1.5 rounded-lg bg-raised px-3 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-fg">
          <SlidersHorizontal size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">CDP（让 AI 和脚本操作这里的网页）</span>
          <Switch data-browser-cdp-switch aria-label="CDP" checked={cdp?.enabled ?? false} disabled={!st || busy} onChange={(v) => change({ cdp: v })} />
        </label>
        <div data-browser-cdp-state className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
          {!cdp ? (
            '读取中…'
          ) : cdpRunning ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <code data-browser-cdp-url className="rounded bg-hover px-1.5 py-0.5 text-fg">
                {cdp.url}
              </code>
              <button
                type="button"
                className="shrink-0 cursor-pointer whitespace-nowrap text-accent hover:underline"
                onClick={() => {
                  void window.bridge.copy(cdp.url ?? '')
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? '已复制' : '复制'}
              </button>
              <span className="w-full text-faint">只有这台电脑上的程序连得上</span>
            </span>
          ) : cdp.activePort ? (
            `端口 ${cdp.activePort} 上没有应答。`
          ) : (
            '这次启动没开。'
          )}
          {cdp?.note && <div className="mt-1">{cdp.note}</div>}
          {cdpPending && <div className="mt-1 text-warn">改了开关，重启工作台后生效。</div>}
          {cdp && (cdp.source === 'cmdline' || cdp.source === 'env') && <div className="mt-1">这次的端口是启动参数定的，开关管不到。</div>}
          {cdpRunning && <div className="mt-1">接进来的 AI 在握手说明里会看到这个地址，用 browser_info / browser_open 这两个工具开始。</div>}
        </div>
      </div>
    </div>
  )
}

// ========== 网页标签 ==========

export function BrowserTabView({
  id,
  url,
  active,
  onChange,
  onNewTab,
  onClose
}: {
  id: string
  /** 这个标签记着的地址。第一次显示时从它开始加载；之后网页自己跳转会经 onChange 改它，这里不会因此重新加载 */
  url: string
  active: boolean
  onChange: (patch: { url?: string; title?: string }) => void
  /** 网页里按了 Ctrl+T */
  onNewTab: () => void
  /** 网页里按了 Ctrl+W */
  onClose: () => void
}) {
  const remote = window.bridge.isRemote
  const view = useRef<WebviewEl | null>(null)
  const ready = useRef(false)
  /** 这次加载失败了：出错页不记进「最近打开」 */
  const failed = useRef(false)
  /** 真正的地址已经让它去加载了。之前网页停在空白页等指纹，那段时间的事件都不算数 */
  const started = useRef(false)
  const preparing = useRef(false)
  /** 第一页还没出来：出来后把历史里那张空白页清掉，不然「后退」会退到空白页 */
  const firstPage = useRef(true)
  const urlRef = useRef(url)
  urlRef.current = url
  /** 指纹：pending 还在装、on 装上了、off 没开、failed 没装上（等用户决定要不要照样打开） */
  const [fp, setFp] = useState<'pending' | 'on' | 'off' | 'failed'>('pending')
  const [fpError, setFpError] = useState('')
  /** 这个标签用的时区和语言（跟出口 IP 走时）；空的就是系统的 */
  const [region, setRegion] = useState('')
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(false)
  const [note, setNote] = useState('')
  const [focusSeq, setFocusSeq] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const cb = useRef({ onChange, onNewTab, onClose })
  cb.current = { onChange, onNewTab, onClose }
  const beginRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    const wv = view.current
    if (!wv) return
    const refresh = (): void => {
      if (!ready.current) return
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      } catch {
        // 网页进程刚没了
      }
    }
    const on = (type: string, fn: (e: GuestEvent) => void): (() => void) => {
      wv.addEventListener(type, fn as EventListener)
      return () => wv.removeEventListener(type, fn as EventListener)
    }
    const dropBlank = (): void => {
      if (!firstPage.current) return
      firstPage.current = false
      try {
        wv.clearHistory()
      } catch {
        // 清不掉只是「后退」多一步
      }
    }
    const navigated = (e: GuestEvent): void => {
      if (!started.current || e.isMainFrame === false || !e.url) return
      dropBlank()
      cb.current.onChange({ url: e.url })
      refresh()
    }
    const begin = (): void => {
      started.current = true
      setLoading(true)
      void wv.loadURL(urlRef.current).catch(() => undefined)
    }
    beginRef.current = begin
    const prepare = async (): Promise<void> => {
      let res: { fingerprint: boolean; region?: { country: string; timezone: string; language: string }; note?: string; error?: string }
      try {
        res = await window.bridge.prepareBrowserTab(wv.getWebContentsId(), id)
      } catch (e) {
        res = { fingerprint: false, error: errText(e) }
      }
      if (res.error) {
        setFp('failed')
        setFpError(res.error)
        return
      }
      setFp(res.fingerprint ? 'on' : 'off')
      setRegion(res.region ? `${res.region.timezone} · ${res.region.language}` : '')
      if (res.note) {
        setNote(res.note)
        setTimeout(() => setNote(''), 8000)
      }
      begin()
    }
    const offs = [
      on('dom-ready', () => {
        ready.current = true
        // 第一次 dom-ready 是空白页：这时装指纹，装好再加载真正的地址
        if (!started.current && !preparing.current) {
          preparing.current = true
          void prepare()
        }
        refresh()
      }),
      on('did-start-loading', () => {
        if (started.current) setLoading(true)
      }),
      on('did-stop-loading', () => {
        if (!started.current) return
        setLoading(false)
        refresh()
        if (!ready.current) return
        try {
          if (failed.current) return
          const u = wv.getURL()
          const title = wv.getTitle()
          cb.current.onChange({ title })
          noteRecentSite({ url: u, title })
        } catch {
          // 同上
        }
      }),
      on('did-start-navigation', (e) => {
        if (started.current && e.isMainFrame && !e.isInPlace) {
          failed.current = false
          setError('')
        }
      }),
      on('did-navigate', navigated),
      on('did-navigate-in-page', navigated),
      on('page-title-updated', (e) => {
        if (started.current && typeof e.title === 'string') cb.current.onChange({ title: e.title })
      }),
      on('did-fail-load', (e) => {
        // -3 是被新的跳转打断，不算失败
        if (!started.current || e.errorCode === -3 || e.isMainFrame === false) return
        dropBlank()
        failed.current = true
        setLoading(false)
        setError(`页面加载失败：${e.errorDescription || '未知错误'} (${e.errorCode})`)
        if (e.validatedURL) cb.current.onChange({ url: e.validatedURL })
      }),
      on('render-process-gone', () => {
        ready.current = false
        setLoading(false)
        setError('此标签页的浏览进程退出，请刷新标签页')
      })
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [id])

  // 网页有焦点时按的快捷键到不了工作台的界面，主进程转过来（见 main/browserGuests.ts）
  useEffect(
    () =>
      window.bridge.onBrowserKey(({ wcId, key }) => {
        const wv = view.current
        if (!wv || !ready.current) return
        let mine = false
        try {
          mine = wv.getWebContentsId() === wcId
        } catch {
          mine = false
        }
        if (!mine) return
        if (key === 'address') setFocusSeq((n) => n + 1)
        else if (key === 'new') cb.current.onNewTab()
        else if (key === 'close') cb.current.onClose()
      }),
    []
  )

  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    const esc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

  const go = (target: string): void => {
    setError('')
    cb.current.onChange({ url: target })
    const wv = view.current
    // 还在等指纹：只记下新地址，装好后加载的就是它
    if (!wv || !started.current) return
    void wv.loadURL(target).catch(() => undefined)
  }
  const act = (fn: (wv: WebviewEl) => void) => () => {
    const wv = view.current
    if (!wv || !ready.current) return
    try {
      fn(wv)
    } catch (e) {
      setError(errText(e))
    }
  }
  const menuItem = (label: string, icon: ReactNode, run: () => void, attr: string) => (
    <button
      type="button"
      role="menuitem"
      data-browser-menu={attr}
      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-xs text-fg hover:bg-hover"
      onClick={() => {
        setMenu(false)
        run()
      }}
    >
      <span className="shrink-0 text-muted">{icon}</span>
      {label}
    </button>
  )

  if (remote) {
    return (
      <div data-browser-tab={id} className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed text-muted">
        <Globe size={24} />
        <div>网页标签只能在电脑上的窗口里用。</div>
        <a className="break-all text-accent hover:underline" href={url} target="_blank" rel="noreferrer">
          在这台设备的浏览器里打开 {siteLabel(url)}
        </a>
      </div>
    )
  }

  return (
    <div data-browser-tab={id} data-browser-fp={fp} data-browser-region={region || undefined} data-browser-loading={loading ? '' : undefined} className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
        <NavButton title="后退" disabled={!nav.back} onClick={act((wv) => wv.goBack())}>
          <ArrowLeft size={14} />
        </NavButton>
        <NavButton title="前进" disabled={!nav.forward} onClick={act((wv) => wv.goForward())}>
          <ArrowRight size={14} />
        </NavButton>
        {loading ? (
          <NavButton title="停止加载" onClick={act((wv) => wv.stop())}>
            <X size={14} />
          </NavButton>
        ) : (
          <NavButton title="刷新" onClick={act((wv) => wv.reload())}>
            <RotateCw size={13} />
          </NavButton>
        )}
        <AddressBar value={url === 'about:blank' ? '' : url} onGo={go} focusSeq={focusSeq} />
        {fp === 'on' && (
          <span title={`指纹开着：网页看到的硬件信息是配好的那一套${region ? `；时区和语言 ${region}` : '；时区和语言是系统的'}（设置在新标签页最下面）`} className="inline-flex h-7 w-6 shrink-0 items-center justify-center text-ok">
            <Fingerprint size={13} />
          </span>
        )}
        <div ref={menuRef} className="relative shrink-0">
          <NavButton title="更多" onClick={() => setMenu((m) => !m)}>
            <MoreHorizontal size={15} />
          </NavButton>
          {menu && (
            <div role="menu" className="absolute top-8 right-0 z-30 w-52 rounded-lg border border-line bg-raised p-1 shadow-xl">
              {menuItem('在系统浏览器里打开', <ExternalLink size={13} />, () => window.open(url, '_blank'), 'external')}
              {menuItem('复制地址', <Copy size={13} />, () => void window.bridge.copy(url), 'copy')}
              {menuItem(
                '开发者工具（F12）',
                <Wrench size={13} />,
                act((wv) => (wv.isDevToolsOpened() ? wv.closeDevTools() : wv.openDevTools())),
                'devtools'
              )}
              {menuItem('指纹和 CDP 设置', <Fingerprint size={13} />, () => cb.current.onNewTab(), 'settings')}
              <div className="my-1 border-t border-line-soft" />
              {menuItem(
                '清除浏览数据（登录状态、缓存）',
                <Eraser size={13} />,
                () =>
                  void window.bridge
                    .clearBrowserData()
                    .then(() => {
                      setNote('浏览数据已清除，刷新后生效')
                      setTimeout(() => setNote(''), 4000)
                    })
                    .catch((e) => setError(errText(e))),
                'clear'
              )}
            </div>
          )}
        </div>
      </div>
      {(error || note) && (
        <div data-browser-error={error ? '' : undefined} className={cx('flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5 text-xs', error ? 'bg-bad/10 text-bad' : 'text-muted')}>
          <span className="min-w-0 flex-1">{error || note}</span>
          {error && (
            <button type="button" className="shrink-0 cursor-pointer rounded border border-bad/40 px-2 py-0.5 hover:bg-bad/15" onClick={() => go(url)}>
              重试
            </button>
          )}
        </div>
      )}
      {fp === 'failed' && (
        <div data-browser-fp-failed className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-warn/10 px-3 py-1.5 text-xs text-warn">
          <span className="min-w-0 flex-1">环境没有装上，网页还没打开：{fpError}</span>
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/15"
            onClick={() => {
              setFp('off')
              beginRef.current()
            }}
          >
            照样打开
          </button>
        </div>
      )}
      {/* 白底：很多网页不写背景色，深色底上会看不清字 */}
      <div className="min-h-0 flex-1 bg-white">
        {createElement('webview', {
          ref: view,
          src: 'about:blank',
          partition: BROWSER_PARTITION,
          allowpopups: 'true',
          'data-browser-view': id,
          'data-active': active ? '' : undefined,
          style: { display: 'flex', width: '100%', height: '100%' }
        })}
      </div>
    </div>
  )
}
