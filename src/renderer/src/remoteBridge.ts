import { createBridgeApi, type BridgeTransport } from '../../shared/bridgeClient'

/**
 * 远端查看：页面是用手机 / 平板的浏览器从远端链接打开的时候，没有 Electron 的预加载脚本，window.bridge 不存在。
 * 这里用 HTTP 补一个一模一样的：调用走 POST /rv-api/invoke 和 /rv-api/send，后端的推送走 GET /rv-api/events 长轮询。
 * 服务端在 src/core/remoteView.ts。电脑上的窗口里 window.bridge 已经有了，这个文件什么都不做。
 */

const HEADERS = { 'content-type': 'application/json', 'x-wb-remote': '1' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let closed = false
/** 电脑上关掉了远端查看或换了链接：盖住整页，别让人对着一个点了没反应的界面 */
function showClosed(): void {
  if (closed) return
  closed = true
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:#111111;color:#ececec;font:16px system-ui,sans-serif;text-align:center'
  el.textContent = '远端查看已经关掉，或者换了新链接。请在电脑上的工作台里重新打开，用新的链接进来。'
  document.body.appendChild(el)
}

async function post(path: string, channel: string, args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // JSON 里没有 undefined，没传的参数位置单独记下来，服务端还原
  const undef: number[] = []
  args.forEach((a, i) => {
    if (a === undefined) undef.push(i)
  })
  const res = await fetch(path, { method: 'POST', headers: HEADERS, credentials: 'same-origin', body: JSON.stringify({ channel, args, undef }) })
  if (res.status === 401) {
    showClosed()
    throw new Error('远端查看已经关掉')
  }
  return res.json()
}

function httpTransport(): BridgeTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners = new Map<string, Set<(...args: any[]) => void>>()

  // 发了就不管的调用（终端打字）要保证先后顺序：排队一条一条发，连着打的字合成一条
  const queue: { channel: string; args: unknown[] }[] = []
  let flushing = false
  const flush = async (): Promise<void> => {
    if (flushing) return
    flushing = true
    while (queue.length > 0 && !closed) {
      const item = queue.shift()!
      while (item.channel === 'terminal:write' && queue[0]?.channel === 'terminal:write' && queue[0].args[0] === item.args[0]) {
        item.args[1] = String(item.args[1]) + String(queue.shift()!.args[1])
      }
      try {
        await post('/rv-api/send', item.channel, item.args)
      } catch {
        // 和本机窗口一样，发不出去就算了
      }
    }
    flushing = false
  }

  const poll = async (): Promise<void> => {
    let last = -1
    while (!closed) {
      try {
        const res = await fetch(`/rv-api/events?after=${last}`, { credentials: 'same-origin', cache: 'no-store' })
        if (res.status === 401) return showClosed()
        if (!res.ok) throw new Error(String(res.status))
        const r = (await res.json()) as { reset?: boolean; last: number; events: { channel: string; args: unknown[] }[] }
        // 断线太久，中间的推送已经不在缓冲里了：整页重新加载，状态从头取
        if (r.reset) return location.reload()
        for (const e of r.events) for (const cb of [...(listeners.get(e.channel) ?? [])]) cb(...e.args)
        last = r.last
      } catch {
        // 手机锁屏、切网络：等一下再连
        await sleep(1500)
      }
    }
  }
  void poll()

  return {
    invoke: async (channel, ...args) => {
      const r = await post('/rv-api/invoke', channel, args)
      // 报错的格式和 Electron 的 ipcRenderer.invoke 一样，界面里整理报错文字的代码不用分两种情况
      if (!r.ok) throw new Error(`Error invoking remote method '${channel}': ${r.error}`)
      return r.result
    },
    send: (channel, ...args) => {
      queue.push({ channel, args })
      void flush()
    },
    on: (channel, cb) => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(cb)
      return () => void set.delete(cb)
    }
  }
}

/** 浏览器自己的剪贴板；不是 https 的页面没有 navigator.clipboard，退回老办法 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // 往下走老办法
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    ta.remove()
  }
}

if (!window.bridge) {
  // 复制要写到手里这台设备的剪贴板，不是电脑的
  window.bridge = { ...createBridgeApi(httpTransport(), true), copy: copyText }
  document.documentElement.classList.add('remote')
  // 界面是按电脑窗口设计的（最窄 1100）。屏幕窄的设备按 1100 宽排版再整体缩小，能双指放大；够宽的平板按实际宽度。
  // 这是打开页面那一刻的设置；手机上用手机版时 App.tsx 会把它改成按手机宽度排（lib/phone.ts 的 viewportContent）
  const meta = document.createElement('meta')
  meta.name = 'viewport'
  meta.content = window.screen.width < 1100 ? 'width=1100' : 'width=device-width, initial-scale=1'
  document.head.appendChild(meta)
}
