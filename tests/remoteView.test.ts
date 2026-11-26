import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_REMOTE_PREFS, lanAddresses, readRemotePrefs, RemoteViewServer, writeRemotePrefs } from '../src/core/remoteView'

let base: string
let rv: RemoteViewServer
let origin: string
let sent: { channel: string; args: unknown[] }[]
let visits: number

const API = { 'content-type': 'application/json', 'x-wb-remote': '1' }

/** 用口令进一次，拿回 cookie */
async function enter(): Promise<string> {
  const res = await fetch(origin + rv.info().entryPath!, { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/')
  const cookie = res.headers.get('set-cookie')!
  expect(cookie).toMatch(/^wb_rv=[\w-]+; HttpOnly; SameSite=Lax; Path=\/$/)
  return cookie.split(';')[0]
}
const invoke = (cookie: string, channel: string, args: unknown[], extra: Record<string, unknown> = {}, headers: Record<string, string> = API) =>
  fetch(origin + '/rv-api/invoke', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ channel, args, ...extra }) })

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rv-'))
  fs.mkdirSync(path.join(base, 'renderer', 'assets'), { recursive: true })
  fs.writeFileSync(path.join(base, 'renderer', 'index.html'), '<!doctype html><title>界面</title>')
  fs.writeFileSync(path.join(base, 'renderer', 'assets', 'app.js'), 'console.log(1)')
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside')
  sent = []
  visits = 0
  rv = new RemoteViewServer({
    staticRoot: path.join(base, 'renderer'),
    invoke: async (channel, args) => {
      if (channel === 'echo') return args
      if (channel === 'kinds') return args.map((a) => (a === undefined ? 'undefined' : a === null ? 'null' : typeof a))
      if (channel === 'void') return undefined
      if (channel === 'boom') throw new Error('炸了')
      throw new Error(`No handler registered for '${channel}'`)
    },
    send: (channel, args) => void sent.push({ channel, args }),
    onVisit: () => void visits++,
    pollWaitMs: 300
  })
  const info = await rv.start()
  origin = `http://127.0.0.1:${info.port}`
})

afterEach(async () => {
  await rv.stop()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('远端查看：入口和口令', () => {
  it('没开的时候 info 是关着的；开了以后有端口和带口令的入口', async () => {
    const off = new RemoteViewServer({ staticRoot: base, invoke: () => undefined, send: () => undefined })
    expect(off.info()).toEqual({ running: false, visits: 0 })
    const info = rv.info()
    expect(info.running).toBe(true)
    expect(info.port).toBeGreaterThan(0)
    expect(info.entryPath).toMatch(/^\/rv\/[\w-]{32}$/)
    expect(info.visits).toBe(0)
  })

  it('没有 cookie：页面是 403，接口是 401，都拿不到界面文件', async () => {
    const page = await fetch(origin + '/')
    expect(page.status).toBe(403)
    expect(await page.text()).not.toContain('界面')
    expect((await fetch(origin + '/assets/app.js')).status).toBe(403)
    const api = await fetch(origin + '/rv-api/invoke', { method: 'POST', headers: API, body: JSON.stringify({ channel: 'echo', args: [] }) })
    expect(api.status).toBe(401)
    expect((await fetch(origin + '/rv-api/events?after=-1')).status).toBe(401)
  })

  it('口令不对：403，不发 cookie，不计打开次数', async () => {
    const res = await fetch(origin + '/rv/' + 'x'.repeat(32), { redirect: 'manual' })
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(rv.info().visits).toBe(0)
    expect(visits).toBe(0)
  })

  it('口令对了：发 cookie、跳到 /、计一次打开；带 cookie 能拿到界面和资源', async () => {
    const cookie = await enter()
    expect(rv.info().visits).toBe(1)
    expect(visits).toBe(1)
    const page = await fetch(origin + '/', { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await page.text()).toContain('界面')
    const js = await fetch(origin + '/assets/app.js', { headers: { cookie } })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect((await fetch(origin + '/assets/none.js', { headers: { cookie } })).status).toBe(404)
  })

  it('经 https 隧道进来的 cookie 带 Secure', async () => {
    const res = await fetch(origin + rv.info().entryPath!, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } })
    expect(res.headers.get('set-cookie')).toMatch(/; Secure$/)
  })

  it('不能用 ../ 跳出界面目录', async () => {
    const cookie = await enter()
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await fetch(origin + p, { headers: { cookie } })
      expect([403, 404]).toContain(res.status)
      expect(await res.text()).not.toContain('outside')
    }
  })

  it('关掉以后旧 cookie 作废；再开是新口令，旧链接进不来', async () => {
    const cookie = await enter()
    const oldEntry = rv.info().entryPath!
    await rv.stop()
    expect(rv.info().running).toBe(false)
    const info = await rv.start()
    origin = `http://127.0.0.1:${info.port}`
    expect(info.entryPath).not.toBe(oldEntry)
    expect(info.visits).toBe(0)
    expect((await fetch(origin + '/', { headers: { cookie } })).status).toBe(403)
    expect((await fetch(origin + oldEntry, { redirect: 'manual' })).status).toBe(403)
  })
})

describe('远端查看：调用后端', () => {
  it('invoke 把参数原样交给后端，结果原样带回', async () => {
    const cookie = await enter()
    const res = await invoke(cookie, 'echo', ['a', 1, { b: [true, null] }])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: ['a', 1, { b: [true, null] }] })
  })

  it('undef 里记的位置还原成 undefined，其余的 null 还是 null', async () => {
    const cookie = await enter()
    const res = await invoke(cookie, 'kinds', ['x', null, null, 2], { undef: [1, 99, -1, 'x'] })
    expect((await res.json()).result).toEqual(['string', 'undefined', 'null', 'number'])
  })

  it('后端没有返回值：结果里没有 result', async () => {
    const cookie = await enter()
    expect(await (await invoke(cookie, 'void', [])).json()).toEqual({ ok: true })
  })

  it('后端抛错：ok=false，带上错误文字；没有的通道也是报错不是崩', async () => {
    const cookie = await enter()
    expect(await (await invoke(cookie, 'boom', [])).json()).toEqual({ ok: false, error: 'Error: 炸了' })
    expect(await (await invoke(cookie, 'nope', [])).json()).toEqual({ ok: false, error: "Error: No handler registered for 'nope'" })
  })

  it('请求体不对：400', async () => {
    const cookie = await enter()
    expect((await fetch(origin + '/rv-api/invoke', { method: 'POST', headers: { ...API, cookie }, body: 'not json' })).status).toBe(400)
    expect((await invoke(cookie, 'echo', 'not-an-array' as unknown as unknown[])).status).toBe(400)
  })

  it('没带自定义头、或 Origin 是别的网站：403，后端没被调到', async () => {
    const cookie = await enter()
    const noHeader = await invoke(cookie, 'echo', [1], {}, { 'content-type': 'application/json' })
    expect(noHeader.status).toBe(403)
    const cross = await invoke(cookie, 'echo', [1], {}, { ...API, origin: 'https://evil.example' })
    expect(cross.status).toBe(403)
    const same = await invoke(cookie, 'echo', [1], {}, { ...API, origin })
    expect(same.status).toBe(200)
    const tunnel = await invoke(cookie, 'echo', [1], {}, { ...API, origin: 'https://abc.trycloudflare.com', 'x-forwarded-host': 'abc.trycloudflare.com' })
    expect(tunnel.status).toBe(200)
  })

  it('send 交给后端，不等结果', async () => {
    const cookie = await enter()
    const res = await fetch(origin + '/rv-api/send', { method: 'POST', headers: { ...API, cookie }, body: JSON.stringify({ channel: 'terminal:write', args: ['t1', 'ls\r'] }) })
    expect(await res.json()).toEqual({ ok: true })
    expect(sent).toEqual([{ channel: 'terminal:write', args: ['t1', 'ls\r'] }])
  })
})

describe('远端查看：后端推送（长轮询）', () => {
  const events = async (cookie: string, after: number) => (await fetch(origin + `/rv-api/events?after=${after}`, { headers: { cookie } })).json()

  it('第一次来只拿到当前位置；之后的推送按顺序带回', async () => {
    const cookie = await enter()
    const first = await events(cookie, -1)
    expect(first).toEqual({ ok: true, events: [], last: 0 })
    rv.broadcast('bridge:state', [{ n: 1 }])
    rv.broadcast('bridge:changed', ['chat', { id: 'm1' }])
    const r = await events(cookie, first.last)
    expect(r.events).toEqual([
      { seq: 1, channel: 'bridge:state', args: [{ n: 1 }] },
      { seq: 2, channel: 'bridge:changed', args: ['chat', { id: 'm1' }] }
    ])
    expect(r.last).toBe(2)
    expect((await events(cookie, 1)).events.map((e: { seq: number }) => e.seq)).toEqual([2])
  })

  it('没有新推送时挂着等，有了马上返回', async () => {
    const cookie = await enter()
    const t = Date.now()
    const pending = events(cookie, 0)
    setTimeout(() => rv.broadcast('terminal:data', [{ id: 't1', data: 'hi' }]), 60)
    const r = await pending
    expect(r.events).toEqual([{ seq: 1, channel: 'terminal:data', args: [{ id: 't1', data: 'hi' }] }])
    expect(Date.now() - t).toBeLessThan(290)
  })

  it('等到头也没有：返回空列表，位置不变', async () => {
    const cookie = await enter()
    const t = Date.now()
    const r = await events(cookie, 0)
    expect(r).toEqual({ ok: true, events: [], last: 0 })
    expect(Date.now() - t).toBeGreaterThanOrEqual(250)
  })

  it('还没人进来时不攒推送', async () => {
    rv.broadcast('bridge:state', [{ n: 1 }])
    const cookie = await enter()
    expect((await events(cookie, -1)).last).toBe(0)
  })

  it('缓冲装不下丢过旧的：位置太旧的让界面重新取状态（reset）', async () => {
    const cookie = await enter()
    for (let i = 0; i < 2100; i++) rv.broadcast('bridge:event', [i])
    const stale = await events(cookie, 5)
    expect(stale.reset).toBe(true)
    expect(stale.last).toBe(2100)
    const ok = await events(cookie, 2098)
    expect(ok.reset).toBeUndefined()
    expect(ok.events.map((e: { seq: number }) => e.seq)).toEqual([2099, 2100])
    // 刚好接在丢掉的最后一条后面：一条都没漏，不用重置
    const edge = await events(cookie, 100)
    expect(edge.reset).toBeUndefined()
    expect(edge.events[0].seq).toBe(101)
    expect(edge.events).toHaveLength(2000)
  })

  it('挂着的长轮询在关掉时马上结束，返回 401', async () => {
    const cookie = await enter()
    const pending = fetch(origin + '/rv-api/events?after=0', { headers: { cookie } })
    await new Promise((r) => setTimeout(r, 50))
    const t = Date.now()
    await rv.stop()
    const res = await pending.catch(() => null)
    expect(Date.now() - t).toBeLessThan(250)
    if (res) expect(res.status).toBe(401)
  })
})

describe('远端查看：局域网', () => {
  const nic = (address: string, extra: Record<string, unknown> = {}) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null, ...extra }) as never

  it('开的时候给了监听地址就用它，info 里带着；不给还是 127.0.0.1', async () => {
    expect(rv.info().host).toBe('127.0.0.1')
    await rv.stop()
    expect(rv.info().host).toBeUndefined()
    // 测试里不真的监听 0.0.0.0（Windows 防火墙会弹窗），用另一个回环地址证明参数生效
    const info = await rv.start('127.0.0.2')
    expect(info.host).toBe('127.0.0.2')
    origin = `http://127.0.0.2:${info.port}`
    const cookie = await enter()
    expect((await fetch(origin + '/', { headers: { cookie } })).status).toBe(200)
  })

  it('已经开着时再 start 换不了监听地址：原样返回，口令不变', async () => {
    const before = rv.info()
    const again = await rv.start('127.0.0.2')
    expect(again.host).toBe('127.0.0.1')
    expect(again.entryPath).toBe(before.entryPath)
    expect(again.port).toBe(before.port)
  })

  it('不是从 https 隧道进来的（局域网、本机）cookie 不带 Secure，照样 HttpOnly', async () => {
    const res = await fetch(origin + rv.info().entryPath!, { redirect: 'manual' })
    const c = res.headers.get('set-cookie')!
    expect(c).toMatch(/HttpOnly/)
    expect(c).not.toMatch(/Secure/)
  })

  it('局域网地址：只要 IPv4，不要回环和 169.254；192.168 排最前，然后 10、172.16–31，其余在后；不重复', () => {
    const list = lanAddresses({
      lo: [nic('127.0.0.1', { internal: true })],
      vpn: [nic('100.64.3.2')],
      vm: [nic('172.20.0.1'), nic('fe80::1', { family: 'IPv6' })],
      corp: [nic('10.1.2.3')],
      apipa: [nic('169.254.9.9')],
      wifi: [nic('192.168.1.23'), nic('192.168.1.23')],
      odd: [nic('172.40.0.1')],
      none: undefined
    })
    expect(list).toEqual(['192.168.1.23', '10.1.2.3', '172.20.0.1', '100.64.3.2', '172.40.0.1'])
    expect(lanAddresses({})).toEqual([])
  })

  it('访问方式：没存过、读不出来、两个都关，都按默认（公网开、局域网关）；存了能读回来', () => {
    const file = path.join(base, 'sub', 'remote-view.json')
    expect(readRemotePrefs(file)).toEqual(DEFAULT_REMOTE_PREFS)
    writeRemotePrefs(file, { tunnel: false, lan: true })
    expect(readRemotePrefs(file)).toEqual({ tunnel: false, lan: true })
    writeRemotePrefs(file, { tunnel: true, lan: true })
    expect(readRemotePrefs(file)).toEqual({ tunnel: true, lan: true })
    fs.writeFileSync(file, '{"tunnel":false,"lan":false}')
    expect(readRemotePrefs(file)).toEqual(DEFAULT_REMOTE_PREFS)
    fs.writeFileSync(file, 'not json')
    expect(readRemotePrefs(file)).toEqual(DEFAULT_REMOTE_PREFS)
    fs.writeFileSync(file, '{"lan":"yes"}')
    expect(readRemotePrefs(file)).toEqual({ tunnel: true, lan: false })
    // 默认值不会被调用的人改掉
    readRemotePrefs(path.join(base, 'nope.json')).lan = true
    expect(DEFAULT_REMOTE_PREFS).toEqual({ tunnel: true, lan: false })
  })
})
