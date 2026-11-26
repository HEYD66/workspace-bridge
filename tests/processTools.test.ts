import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  killProcess,
  listProcesses,
  parseLsof,
  parseNetstat,
  parsePs,
  parseWindowsJson,
  planKill,
  type ExecFn,
  type ExecResult,
  type ProcessToolOptions
} from '../src/core/processTools'

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })

// 假的 Windows 进程表：1000=工作台（父 900=explorer），2000=node 开发服务器（子 2001），3000=chrome（子 3001=svchost，故意）
const WIN_PROCS = [
  { pid: 0, ppid: 0, name: 'System Idle Process', cmd: '' },
  { pid: 4, ppid: 0, name: 'System', cmd: '' },
  { pid: 900, ppid: 4, name: 'explorer.exe', cmd: 'C:\\Windows\\explorer.exe' },
  { pid: 1000, ppid: 900, name: 'Workbench.exe', cmd: 'Workbench.exe' },
  { pid: 1100, ppid: 1000, name: 'Workbench.exe', cmd: 'Workbench.exe --type=renderer' },
  { pid: 2000, ppid: 1500, name: 'node.exe', cmd: 'node ' + 'x'.repeat(500) + ' vite --port 5173' },
  { pid: 2001, ppid: 2000, name: 'esbuild.exe', cmd: 'esbuild --service' },
  { pid: 3000, ppid: 1500, name: 'chrome.exe', cmd: 'chrome.exe' },
  { pid: 3001, ppid: 3000, name: 'svchost.exe', cmd: 'svchost.exe -k x' },
  { pid: 4000, ppid: 1500, name: 'python.exe', cmd: 'python -m http.server 8000' }
]
const WIN_PORTS = [
  { pid: 2000, port: 5173 },
  { pid: 2000, port: 24678 },
  { pid: 4000, port: 8000 },
  { pid: 4, port: 445 },
  { pid: 3000, port: 9222 }
]

function winOpts(over: Partial<ProcessToolOptions> & { ports?: unknown; netstat?: string } = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const alive = new Set(WIN_PROCS.map((p) => p.pid))
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args })
    if (file === 'powershell') return ok(JSON.stringify({ procs: WIN_PROCS, ports: 'ports' in over ? over.ports : WIN_PORTS }))
    if (file === 'netstat') return ok(over.netstat ?? '')
    if (file === 'taskkill') {
      const pid = Number(args[1])
      alive.delete(pid)
      if (args.includes('/T')) for (const p of WIN_PROCS) if (p.ppid === pid) alive.delete(p.pid)
      return ok('成功')
    }
    throw new Error(`unexpected ${file}`)
  }
  const opts: ProcessToolOptions = { exec, platform: 'win32', selfPid: 1000, isAlive: (pid) => alive.has(pid), sleep: async () => undefined, ...over }
  return { opts, calls, alive }
}

describe('解析', () => {
  it('parseWindowsJson：数组、单个对象、ports=null', () => {
    const r = parseWindowsJson('\uFEFF' + JSON.stringify({ procs: { pid: 5, ppid: 1, name: 'a.exe', cmd: null }, ports: null }))
    expect(r.procs).toEqual([{ pid: 5, ppid: 1, name: 'a.exe', command_line: '' }])
    expect(r.ports).toBeNull()
    const r2 = parseWindowsJson(JSON.stringify({ procs: [{ pid: 6, ppid: 0, name: 'b', cmd: 'b x' }], ports: { pid: 6, port: 80 } }))
    expect(r2.ports).toEqual([{ pid: 6, port: 80 }])
  })

  it('parseNetstat：只要 TCP 监听行，IPv4 / IPv6，本地化状态也认', () => {
    const text = [
      '活动连接',
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       2000',
      '  TCP    [::]:8000              [::]:0                 侦听            4000',
      '  TCP    127.0.0.1:50000        127.0.0.1:5173         ESTABLISHED     3000',
      '  UDP    0.0.0.0:5353           *:*                                    1234'
    ].join('\r\n')
    expect(parseNetstat(text)).toEqual([
      { pid: 2000, port: 5173 },
      { pid: 4000, port: 8000 }
    ])
  })

  it('parsePs / parseLsof', () => {
    const ps = ['  PID  PPID COMMAND         COMMAND', '    1     0 /sbin/launchd   /sbin/launchd', '  500     1 node            node server.js --port 3000'].join('\n')
    expect(parsePs(ps)).toEqual([
      { pid: 1, ppid: 0, name: 'launchd', command_line: '/sbin/launchd' },
      { pid: 500, ppid: 1, name: 'node', command_line: 'node server.js --port 3000' }
    ])
    const lsof = [
      'COMMAND PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    500 me   21u  IPv6 0x1      0t0  TCP *:3000 (LISTEN)',
      'node    500 me   22u  IPv4 0x2      0t0  TCP 127.0.0.1:9229 (LISTEN)'
    ].join('\n')
    expect(parseLsof(lsof)).toEqual([
      { pid: 500, port: 3000 },
      { pid: 500, port: 9229 }
    ])
  })
})
describe('listProcesses（假 exec）', () => {
  it('Windows 只调一次 powershell，端口挂到进程上，命令行截到 300 字', async () => {
    const { opts, calls } = winOpts()
    const r = await listProcesses({}, opts)
    expect(calls.map((c) => c.file)).toEqual(['powershell'])
    expect(calls[0].args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])
    const node = r.processes.find((p) => p.pid === 2000)
    expect(node?.listening_ports).toEqual([5173, 24678])
    expect(node?.command_line.length).toBeLessThanOrEqual(301)
    expect(r.ports_available).toBe(true)
  })

  it('name 不分大小写匹配进程名和命令行；port 只留监听它的进程', async () => {
    const { opts } = winOpts()
    expect((await listProcesses({ name: 'NODE' }, opts)).processes.map((p) => p.pid)).toEqual([2000])
    expect((await listProcesses({ name: 'http.SERVER' }, opts)).processes.map((p) => p.pid)).toEqual([4000])
    expect((await listProcesses({ port: 5173 }, opts)).processes.map((p) => p.pid)).toEqual([2000])
    expect((await listProcesses({ port: 1 }, opts)).processes).toEqual([])
  })

  it('limit 默认 50、最大 200，超出时 truncated', async () => {
    const { opts } = winOpts()
    const r = await listProcesses({ limit: 2 }, opts)
    expect(r.processes).toHaveLength(2)
    expect(r.total).toBe(WIN_PROCS.length)
    expect(r.truncated).toBe(true)
    expect((await listProcesses({ limit: 10_000 }, opts)).processes).toHaveLength(WIN_PROCS.length)
  })

  it('Get-NetTCPConnection 不可用时退回 netstat -ano', async () => {
    const { opts, calls } = winOpts({ ports: null, netstat: '  TCP    0.0.0.0:8000    0.0.0.0:0    LISTENING    4000\r\n' })
    const r = await listProcesses({ port: 8000 }, opts)
    expect(calls.map((c) => c.file)).toEqual(['powershell', 'netstat'])
    expect(r.processes.map((p) => p.pid)).toEqual([4000])
  })

  it('其他平台：ps + lsof；没有 lsof 就不填端口', async () => {
    const exec: ExecFn = async (file) => {
      if (file === 'ps') return ok('  PID  PPID COMMAND COMMAND\n  500     1 node node server.js\n')
      if (file === 'lsof') return { code: null, stdout: '', stderr: '', error: 'spawn lsof ENOENT' }
      throw new Error(file)
    }
    const r = await listProcesses({}, { exec, platform: 'linux', selfPid: 999 })
    expect(r.processes).toEqual([{ pid: 500, ppid: 1, name: 'node', command_line: 'node server.js', listening_ports: [] }])
    expect(r.ports_available).toBe(false)
  })
})

describe('killProcess（假 exec）', () => {
  it('pid 和 port 必须且只能给一个', async () => {
    const { opts } = winOpts()
    await expect(killProcess({}, opts)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(killProcess({ pid: 2000, port: 5173 }, opts)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('按 port 结束：taskkill /T /F，返回进程和子进程', async () => {
    const { opts, calls } = winOpts()
    const r = await killProcess({ port: 5173 }, opts)
    expect(calls.filter((c) => c.file === 'taskkill').map((c) => c.args)).toEqual([['/PID', '2000', '/T', '/F']])
    expect(r.killed).toEqual([
      { pid: 2000, name: 'node.exe' },
      { pid: 2001, name: 'esbuild.exe' }
    ])
    expect(r.not_found).toBeUndefined()
  })

  it('tree=false 不带 /T；没找到返回 not_found', async () => {
    const { opts, calls } = winOpts()
    await killProcess({ pid: 4000, tree: false }, opts)
    expect(calls.find((c) => c.file === 'taskkill')?.args).toEqual(['/PID', '4000', '/F'])
    expect(await killProcess({ pid: 77777 }, opts)).toEqual({ killed: [], not_found: true })
    expect(await killProcess({ port: 1 }, opts)).toEqual({ killed: [], not_found: true })
  })

  it('保护名单：pid 0/4、工作台和祖先、调用方传入的 pid、系统进程名', async () => {
    const { opts, calls } = winOpts({ protectedPids: [1100] })
    for (const pid of [0, 4, 1000, 900, 1100, 3001]) {
      await expect(killProcess({ pid, tree: false }, opts)).rejects.toMatchObject({ code: 'PROTECTED_PROCESS' })
    }
    // System 监听 445：按端口也拒绝
    await expect(killProcess({ port: 445 }, opts)).rejects.toMatchObject({ code: 'PROTECTED_PROCESS' })
    expect(calls.some((c) => c.file === 'taskkill')).toBe(false)
  })

  it('进程树里有受保护的进程时整棵树拒绝，tree=false 可以只结束目标', async () => {
    const { opts, calls } = winOpts()
    await expect(killProcess({ pid: 3000 }, opts)).rejects.toMatchObject({ code: 'PROTECTED_PROCESS', message: expect.stringContaining('tree=false') })
    expect(calls.some((c) => c.file === 'taskkill')).toBe(false)
    const r = await killProcess({ pid: 3000, tree: false }, opts)
    expect(r.killed).toEqual([{ pid: 3000, name: 'chrome.exe' }])
  })

  it('其他平台：SIGTERM，1.5 秒后还在就 SIGKILL；pid 1 和 launchd 受保护', async () => {
    const exec: ExecFn = async (file) =>
      file === 'ps' ? ok('  PID  PPID COMMAND COMMAND\n    1     0 /sbin/launchd /sbin/launchd\n  600     1 node node a.js\n  601   600 node node b.js\n') : ok('')
    const alive = new Set([1, 600, 601])
    const sent: string[] = []
    const opts: ProcessToolOptions = {
      exec,
      platform: 'darwin',
      selfPid: 999,
      sleep: async () => undefined,
      isAlive: (pid) => alive.has(pid),
      // 600 不理 SIGTERM，601 收到就退
      signal: (pid, sig) => {
        sent.push(`${pid}:${sig}`)
        if (sig === 'SIGKILL' || pid === 601) alive.delete(pid)
      }
    }
    const r = await killProcess({ pid: 600 }, opts)
    expect(sent).toEqual(['600:SIGTERM', '601:SIGTERM', '600:SIGKILL'])
    expect(r.killed.map((k) => k.pid)).toEqual([600, 601])
    await expect(killProcess({ pid: 1 }, opts)).rejects.toMatchObject({ code: 'PROTECTED_PROCESS' })
  })
})

describe('真实冒烟', () => {
  let child: ChildProcess | undefined
  afterEach(() => {
    // 兜底：只结束自己起的子进程
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child = undefined
  })

  it('起一个监听随机端口的 node 子进程，按端口找到并结束它', async () => {
    const script = "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port));setInterval(()=>{},1e6)"
    const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    child = c
    const port = await new Promise<number>((resolve, reject) => {
      let buf = ''
      c.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        const m = /PORT=(\d+)/.exec(buf)
        if (m) resolve(Number(m[1]))
      })
      c.once('exit', () => reject(new Error('子进程提前退出')))
    })

    const listed = await listProcesses({ port })
    expect(listed.processes.map((p) => p.pid)).toEqual([c.pid])
    expect(listed.processes[0].listening_ports).toContain(port)

    // 先确认目标只有自己起的子进程，再真的结束
    const plan = await planKill({ port })
    expect(plan.targets.map((t) => t.pid)).toEqual([c.pid])
    const exited = new Promise((r) => c.once('exit', r))
    const r = await killProcess({ port })
    expect(r.killed.map((k) => k.pid)).toContain(c.pid)
    await exited
    expect((await listProcesses({ port })).processes).toEqual([])
  }, 60_000)
})
