import { Eye, EyeOff, Loader2, Play, RefreshCw, Smartphone, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RemoteViewStatus } from '../../../shared/api'
import { encodeQr, qrSvgPath } from '../../../shared/qr'
import { clockTime, errText, timeAgo } from '../lib/format'
import { Badge, Button, ConfirmButton, CopyButton, cx, IconButton, Switch } from './ui'

export const REMOTE_VIEW_LABEL: Record<RemoteViewStatus['state'], string> = { off: '已关闭', connecting: '远端连接中…', on: '远端查看中', error: '远端查看出错' }
const BADGE: Record<RemoteViewStatus['state'], { label: string; color?: string }> = {
  off: { label: '已关闭' },
  connecting: { label: '正在申请公网地址', color: '#d29922' },
  on: { label: '已开启', color: '#3fb950' },
  error: { label: '公网地址没申请下来', color: '#f85149' }
}

/** 远端查看的状态：进页面取一次，之后跟着后端的通知变（状态栏和设置页共用） */
export function useRemoteView(): RemoteViewStatus {
  const [status, setStatus] = useState<RemoteViewStatus>({ state: 'off', visits: 0 })
  useEffect(() => {
    let alive = true
    window.bridge
      .remoteViewStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    const off = window.bridge.onRemoteView(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

/** 把链接里的口令遮住：投屏、截图时不至于把入口露出去 */
function masked(link: string): string {
  return link.replace(/\/rv\/.+$/, '/rv/••••••••')
}

/** 链接的二维码：白底黑格，四周留够空白，深色界面上也能扫 */
function QrImage({ text }: { text: string }) {
  const qr = useMemo(() => {
    try {
      return qrSvgPath(encodeQr(text))
    } catch {
      return null
    }
  }, [text])
  if (!qr) return <div className="text-[11px] text-faint">链接太长，画不出二维码，请用「复制链接」。</div>
  return (
    <svg viewBox={`0 0 ${qr.total} ${qr.total}`} width={176} height={176} shapeRendering="crispEdges" role="img" aria-label="远端查看链接的二维码" className="shrink-0 rounded">
      <rect width={qr.total} height={qr.total} fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  )
}

/** 「远端查看」：用手机 / 平板的浏览器打开这个工作台。设置页里有一张，图标栏左下角的手机按钮点开也是它 */
export function RemoteViewCard({ className }: { className?: string }) {
  const status = useRemoteView()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState(false)
  /** 局域网有好几个地址时，二维码画哪一个 */
  const [lanPick, setLanPick] = useState(0)
  const remote = window.bridge.isRemote
  const on = status.state !== 'off'
  const badge = BADGE[status.state]

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }
  const start = (renew: boolean) => {
    setReveal(false)
    return run(renew ? 'renew' : 'start', () => window.bridge.remoteViewStart({ renew }))
  }
  const stop = () => run('stop', () => window.bridge.remoteViewStop())
  const wantTunnel = status.tunnel !== false
  const wantLan = status.lan === true
  const setOption = (patch: { tunnel?: boolean; lan?: boolean }) => {
    setReveal(false)
    setLanPick(0)
    return run('options', () => window.bridge.remoteViewSetOptions(patch))
  }
  const keep = status.keep === true
  // 只改「重启后保留」不会换口令，所以不用把已经显示出来的链接遮回去
  const setKeep = (next: boolean) => run('keep', () => window.bridge.remoteViewSetOptions({ keep: next }))
  const lanUrls = status.lanUrls ?? []
  const lanUrl = lanUrls[Math.min(lanPick, Math.max(0, lanUrls.length - 1))]
  // 只开了局域网时没有「连接中」这回事：服务一起来就能用
  const badgeNow = on && !wantTunnel ? BADGE.on : badge

  return (
    <div data-remote-card className={cx('rounded-lg border border-line bg-panel p-5', className)}>
      <div className="flex items-center gap-2">
        <Smartphone size={15} className="text-accent" />
        <span className="text-[13px] font-medium">远端查看</span>
        <Badge color={badgeNow.color}>
          {status.state === 'connecting' && <Loader2 size={10} className="animate-spin" />}
          {badgeNow.label}
        </Badge>
        <div className="flex-1" />
        {!on ? (
          <Button variant="primary" disabled={!!busy} onClick={() => void start(false)}>
            {busy === 'start' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {busy === 'start' ? '开启中…' : '开启'}
          </Button>
        ) : remote ? (
          // 人就是从这个链接进来的：关掉以后这个页面马上断开，多确认一次
          <ConfirmButton size="md" confirmText="你现在就是从远端链接进来的，关掉后这里马上断开。再点一次确认" onConfirm={() => void stop()}>
            <Square size={13} /> 关闭
          </ConfirmButton>
        ) : (
          <Button disabled={!!busy} onClick={() => void stop()}>
            <Square size={13} /> {busy === 'stop' ? '关闭中…' : '关闭'}
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        用手机或平板的浏览器打开这个工作台：看群聊和实时活动、回答任务里等你决定的问题、点「全部停下」，功能和这个窗口一样，包括终端和设置。
        <span className="text-warn">拿到链接的人就能操作这台电脑</span>，所以默认关着；每次开启都是新链接，关闭或换链接后，旧链接和已经打开的页面立刻失效。
      </p>
      <div className="mt-3 space-y-2" data-remote-options>
        <div className="text-[11px] font-medium text-muted">从哪里能打开（至少开一个{on && !remote ? '；改了会马上换链接，已经打开的页面要重新进' : ''}）</div>
        <label className={cx('flex items-start gap-3 text-xs', !(remote || busy) && 'cursor-pointer')}>
          <span className={cx('min-w-0 flex-1 leading-relaxed', (remote || busy) && 'opacity-60')}>
            <span className="text-fg">公网链接</span>
            <span className="ml-1.5 text-muted">在哪个网络都能打开，走 Cloudflare 的临时地址（https）。</span>
          </span>
          <Switch
            data-remote-opt="tunnel"
            aria-label="公网链接"
            title={wantTunnel && !wantLan ? '两项至少开一个：先开「局域网」才能关这个' : undefined}
            checked={wantTunnel}
            disabled={remote || !!busy}
            locked={wantTunnel && !wantLan}
            onChange={(next) => void setOption({ tunnel: next })}
          />
        </label>
        <label className={cx('flex items-start gap-3 text-xs', !(remote || busy) && 'cursor-pointer')}>
          <span className={cx('min-w-0 flex-1 leading-relaxed', (remote || busy) && 'opacity-60')}>
            <span className="text-fg">局域网</span>
            <span className="ml-1.5 text-muted">
              手机和这台电脑连同一个 Wi‑Fi / 路由器时直接打开，不经过外网，更快。
              <span className="text-warn">是 http，不加密：同一个网络里的人能截到链接，别在公共 Wi‑Fi 上开。</span>
              第一次开 Windows 防火墙可能会问，要选「允许」（专用网络）。
            </span>
          </span>
          <Switch
            data-remote-opt="lan"
            aria-label="局域网"
            title={wantLan && !wantTunnel ? '两项至少开一个：先开「公网链接」才能关这个' : undefined}
            checked={wantLan}
            disabled={remote || !!busy}
            locked={wantLan && !wantTunnel}
            onChange={(next) => void setOption({ lan: next })}
          />
        </label>
        <label className={cx('flex items-start gap-3 border-t border-line-soft pt-2 text-xs', !(remote || busy) && 'cursor-pointer')}>
          <span className={cx('min-w-0 flex-1 leading-relaxed', (remote || busy) && 'opacity-60')}>
            <span className="text-fg">重启后保留</span>
            <span className="ml-1.5 text-muted">
              工作台重启（比如换新版本）以后自己接着开，链接和手机上已经打开的页面照旧能用，不用回到电脑前重新开。
              <span className="text-warn">口令会存在这台电脑上，链接一直有效到你点「关闭」或「换链接」。</span>
              电脑关机再开机后公网地址会换（临时地址留不住），局域网链接不变。
              {on && wantTunnel && !keep && !remote && ' 现在打开这一项，公网地址会马上换一次，之后重启就不变了。'}
            </span>
          </span>
          <Switch data-remote-keep aria-label="重启后保留" checked={keep} disabled={remote || !!busy} onChange={(next) => void setKeep(next)} />
        </label>
        {remote && <div className="text-[11px] text-faint">这几项只能在电脑上的窗口里改。</div>}
      </div>
      {error && <div className="mt-2 text-xs text-bad">{error}</div>}

      {status.state === 'connecting' && <div className="mt-3 text-xs text-muted">正在向 Cloudflare 申请一个临时公网地址，一般十几秒。申请下来之前，下面的本机地址已经能用了。</div>}
      {status.state === 'error' && (
        <div className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs leading-relaxed text-bad">
          {status.error}
          <div className="mt-1.5">
            <Button size="sm" disabled={!!busy} onClick={() => void start(true)}>
              <RefreshCw size={13} /> {busy === 'renew' ? '重试中…' : '重试'}
            </Button>
          </div>
        </div>
      )}

      {status.link && (
        <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2.5">
          <div className="text-xs font-medium text-fg">公网链接（在手机 / 平板的浏览器里打开）</div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg" title={reveal ? status.link : '点右边的眼睛显示完整链接和二维码'}>
              {reveal ? status.link : masked(status.link)}
            </span>
            <IconButton title={reveal ? '遮住口令和二维码' : '显示完整链接和二维码'} onClick={() => setReveal((v) => !v)}>
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
            <CopyButton text={status.link} label="复制链接" />
            <Button size="sm" disabled={!!busy} title="换一个新口令和新地址，旧链接立刻失效" onClick={() => void start(true)}>
              <RefreshCw size={13} /> {busy === 'renew' ? '更换中…' : '换链接'}
            </Button>
          </div>
          {reveal ? (
            <div className="mt-2.5 flex items-center gap-3">
              <QrImage text={status.link} />
              <div className="text-[11px] leading-relaxed text-muted">
                用手机相机或浏览器的扫一扫打开。
                <br />
                二维码和链接是同一个东西，别截图发到群里。
              </div>
            </div>
          ) : (
            <div className="mt-1.5 text-[11px] text-faint">口令和二维码默认遮住（防投屏、截图时露出去），点眼睛显示。</div>
          )}
        </div>
      )}

      {on && wantLan && (
        <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2.5" data-remote-lan>
          <div className="text-xs font-medium text-fg">局域网链接（手机和这台电脑连同一个 Wi‑Fi 时打开）</div>
          {lanUrls.length === 0 ? (
            <div className="mt-1.5 text-xs text-warn">没找到局域网 IPv4 地址，确认这台电脑已经连上 Wi‑Fi 或网线。</div>
          ) : (
            <>
              {lanUrls.map((u, i) => (
                <div key={u} className="mt-1.5 flex items-center gap-1.5">
                  {lanUrls.length > 1 && (
                    <input type="radio" name="remote-lan-pick" aria-label={`二维码用这个地址：${new URL(u).hostname}`} checked={u === lanUrl} onChange={() => setLanPick(i)} />
                  )}
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg" title={reveal ? u : '点右边的眼睛显示完整链接和二维码'}>
                    {reveal ? u : masked(u)}
                  </span>
                  {i === 0 && (
                    <IconButton title={reveal ? '遮住口令和二维码' : '显示完整链接和二维码'} onClick={() => setReveal((v) => !v)}>
                      {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                    </IconButton>
                  )}
                  <CopyButton text={u} label="复制链接" />
                </div>
              ))}
              {lanUrls.length > 1 && <div className="mt-1.5 text-[11px] text-faint">这台电脑有 {lanUrls.length} 个网络地址（虚拟机、VPN 也算）。一般是 192.168 开头的那个；打不开就换一个试。</div>}
              {reveal && lanUrl ? (
                <div className="mt-2.5 flex items-center gap-3">
                  <QrImage text={lanUrl} />
                  <div className="text-[11px] leading-relaxed text-muted">
                    手机先连上和电脑同一个 Wi‑Fi，再扫。
                    <br />
                    打不开多半是防火墙没放行，或者路由器开了「设备隔离」。
                  </div>
                </div>
              ) : (
                !status.link && <div className="mt-1.5 text-[11px] text-faint">口令和二维码默认遮住（防投屏、截图时露出去），点眼睛显示。</div>
              )}
            </>
          )}
        </div>
      )}

      {on && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
          {status.startedAt && (
            <span>
              {clockTime(status.startedAt)} 开启{status.resumed && '（工作台重启后接着开的）'}
            </span>
          )}
          <span className={status.visits > 0 ? 'text-warn' : undefined}>
            用链接打开过 {status.visits} 次{status.lastVisitAt ? `，最近一次 ${timeAgo(status.lastVisitAt)}` : ''}
          </span>
          {status.localUrl && !remote && (
            <span className="flex items-center gap-1.5">
              本机地址（只有这台电脑能打开）
              <CopyButton text={status.localUrl} label="复制" />
            </span>
          )}
        </div>
      )}
      <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
        要弹出电脑上的窗口的几个操作（添加工作区、导入技能包、导入导出备份、导出审计和诊断、在资源管理器里显示）在远端页面里会提示只能在电脑上做。手机上是按电脑的排版整体缩小，可以双指放大。
      </p>
    </div>
  )
}
