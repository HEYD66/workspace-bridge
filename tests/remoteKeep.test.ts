// 远端查看的「重启后保留」：记录的读写、用原来的端口和口令接着开、重启前打开的页面照旧能用
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_REMOTE_PREFS, MAX_KEPT_SESSIONS, readRemoteKept, readRemotePrefs, RemoteViewServer, removeRemoteKept, writeRemoteKept, writeRemotePrefs, type RemoteKeptRecord } from '../src/core/remoteView'

let base: string
const servers: RemoteViewServer[] = []

function server(): RemoteViewServer {
  const rv = new RemoteViewServer({ staticRoot: path.join(base, 'renderer'), invoke: (channel, args) => (channel === 'echo' ? args : undefined), send: () => undefined, pollWaitMs: 200 })
  servers.push(rv)
  return rv
}
async function enter(rv: RemoteViewServer): Promise<string> {
  const i = rv.info()
  const res = await fetch(`http://127.0.0.1:${i.port}${i.entryPath}`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  return res.headers.get('set-cookie')!.split(';')[0]
}
const events = (rv: RemoteViewServer, cookie: string, after: number) => fetch(`http://127.0.0.1:${rv.info().port}/rv-api/events?after=${after}`, { headers: { cookie } })

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rvkeep-'))
  fs.mkdirSync(path.join(base, 'renderer'), { recursive: true })
  fs.writeFileSync(path.join(base, 'renderer', 'index.html'), '<!doctype html><title>界面</title>')
})
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('远端查看：重启后保留', () => {
  it('开关记在访问方式里：没开时不写这一项，开了能读回来；两个访问方式都关时回默认但开关还在', () => {
    const file = path.join(base, 'remote-view.json')
    writeRemotePrefs(file, { tunnel: true, lan: false })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ tunnel: true, lan: false })
    expect(readRemotePrefs(file)).toEqual({ tunnel: true, lan: false })
    writeRemotePrefs(file, { tunnel: false, lan: true, keep: true })
    expect(readRemotePrefs(file)).toEqual({ tunnel: false, lan: true, keep: true })
    fs.writeFileSync(file, '{"tunnel":false,"lan":false,"keep":true}')
    expect(readRemotePrefs(file)).toEqual({ ...DEFAULT_REMOTE_PREFS, keep: true })
    fs.writeFileSync(file, '{"keep":"yes"}')
    expect(readRemotePrefs(file)).toEqual(DEFAULT_REMOTE_PREFS)
  })

  it('记录：写了能读回来，只留最近的 50 台设备；没有、读不了、端口或口令不对都当没有；删了就没了', () => {
    const file = path.join(base, 'sub', 'remote-view-kept.json')
    expect(readRemoteKept(file)).toBeUndefined()
    const rec: RemoteKeptRecord = { port: 45678, passcode: 'p'.repeat(32), sessions: ['s'.repeat(32), 't'.repeat(32)], startedAt: 1234, tunnel: true, lan: false }
    writeRemoteKept(file, rec)
    expect(readRemoteKept(file)).toEqual(rec)

    const many = Array.from({ length: MAX_KEPT_SESSIONS + 5 }, (_, i) => `sess${String(i).padStart(4, '0')}${'x'.repeat(20)}`)
    writeRemoteKept(file, { ...rec, sessions: many })
    expect(readRemoteKept(file)!.sessions).toEqual(many.slice(5))

    const bad = (patch: Record<string, unknown>): RemoteKeptRecord | undefined => {
      fs.writeFileSync(file, JSON.stringify({ ...rec, ...patch }))
      return readRemoteKept(file)
    }
    expect(bad({ port: 0 })).toBeUndefined()
    expect(bad({ port: 70000 })).toBeUndefined()
    expect(bad({ port: '45678' })).toBeUndefined()
    expect(bad({ passcode: 'short' })).toBeUndefined()
    expect(bad({ passcode: 'has space and / slash, long enough' })).toBeUndefined()
    expect(bad({ tunnel: false, lan: false })).toBeUndefined()
    // 设备列表里不像样的那几条丢掉，其余照用
    expect(bad({ sessions: ['s'.repeat(32), 7, '../x', null] })!.sessions).toEqual(['s'.repeat(32)])
    expect(bad({ sessions: 'nope' })!.sessions).toEqual([])
    fs.writeFileSync(file, 'not json')
    expect(readRemoteKept(file)).toBeUndefined()

    writeRemoteKept(file, rec)
    removeRemoteKept(file)
    expect(fs.existsSync(file)).toBe(false)
    removeRemoteKept(file)
  })

  it('接着开：端口、口令、开启时间都是原来的；重启前进来的设备不用重新进，位置对不上会被告知整页重新取状态', async () => {
    const a = server()
    const first = await a.start()
    const cookie = await enter(a)
    a.broadcast('state', [1])
    a.broadcast('state', [2])
    const before = (await (await events(a, cookie, -1)).json()) as { last: number }
    expect(before.last).toBe(2)
    const saved = a.resumeState()!
    expect(saved).toMatchObject({ port: first.port, passcode: first.entryPath!.slice('/rv/'.length), startedAt: first.startedAt })
    expect(saved.sessions).toEqual([cookie.split('=')[1]])
    await a.stop()
    expect(a.resumeState()).toBeUndefined()

    // 「重启」：另一个服务对象拿着记录接着开
    const b = server()
    const again = await b.start(undefined, saved)
    expect(again).toMatchObject({ running: true, port: first.port, entryPath: first.entryPath, startedAt: first.startedAt, visits: 0 })
    // 原来的 cookie 直接能用。端口没变，fetch 可能还拿着连旧服务的连接（已经断了），第一下断线就再来一次，和浏览器一样
    const page = await fetch(`http://127.0.0.1:${again.port}/`, { headers: { cookie } }).catch(() => fetch(`http://127.0.0.1:${again.port}/`, { headers: { cookie } }))
    expect(page.status).toBe(200)
    const call = await fetch(`http://127.0.0.1:${again.port}/rv-api/invoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-remote': '1', cookie }, body: JSON.stringify({ channel: 'echo', args: ['hi'] }) })
    expect(await call.json()).toEqual({ ok: true, result: ['hi'] })
    // 手里的推送位置是重启前的：整页重新取状态
    const stale = (await (await events(b, cookie, before.last)).json()) as { reset?: boolean; last: number }
    expect(stale.reset).toBe(true)
    expect(stale.last).toBeGreaterThan(before.last)
    // 重新取完以后照常收推送
    const from = ((await (await events(b, cookie, -1)).json()) as { last: number }).last
    b.broadcast('state', [3])
    const got = (await (await events(b, cookie, from)).json()) as { events: { channel: string; args: unknown[] }[] }
    expect(got.events.map((e) => e.args)).toEqual([[3]])
    // 原来的链接也还能进，别的口令不行
    await enter(b)
    expect((await fetch(`http://127.0.0.1:${again.port}/rv/${'z'.repeat(32)}`, { redirect: 'manual' })).status).toBe(403)
    expect((await fetch(`http://127.0.0.1:${again.port}/`, { headers: { cookie: 'wb_rv=' + 'z'.repeat(32) } })).status).toBe(403)
  })

  it('原来的端口被别的程序占了：换一个端口照样开，口令不变', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const taken = (blocker.address() as net.AddressInfo).port
    try {
      const rv = server()
      const info = await rv.start(undefined, { port: taken, passcode: 'k'.repeat(32), sessions: [], startedAt: 99 })
      expect(info.running).toBe(true)
      expect(info.port).not.toBe(taken)
      expect(info.entryPath).toBe('/rv/' + 'k'.repeat(32))
      await enter(rv)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('关掉再开（不是接着开）还是新口令，以前的 cookie 作废', async () => {
    const rv = server()
    const first = await rv.start()
    const cookie = await enter(rv)
    await rv.stop()
    const second = await rv.start()
    expect(second.entryPath).not.toBe(first.entryPath)
    expect((await fetch(`http://127.0.0.1:${second.port}/`, { headers: { cookie } })).status).toBe(403)
  })
})
