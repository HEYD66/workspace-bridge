import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandRunner,
  ENV_ALLOWLIST,
  bashEnvPrefix,
  bashQuoteValue,
  compileWaitPattern,
  findPowerShell,
  powershellInvocation,
  validateCommandEnv,
  MAX_RUNNING_PER_OWNER,
  OutputBuffer,
  findWindowsBash,
  isPathInside,
  managedProcessEnvironment,
  protectedCommandHit,
  protectedCwdReason,
  type CommandAuditRecord,
  writeCommandAudit,
  needsScriptBridge,
  normalizeManagedTerminalCwd,
  parseBashPipelineSnapshot,
  parseManagedPrompt,
  resolveCommandCwd,
  stripAnsi,
  tempScriptCommand,
  windowsManagedBashProtocol,
  type ShellSpec
} from '../src/core/commandRunner'

// ===== 假 PTY：模拟一个会回显、会打提示符标记的 bash =====

type Handler = (args: string, sh: FakeShell) => void

class FakeShell {
  pid: number
  cwd: string
  seq = 0
  token = ''
  dataCbs: ((d: string) => void)[] = []
  exitCbs: ((e: { exitCode: number }) => void)[] = []
  line = ''
  running: { onInput?: (line: string) => void; onInterrupt?: () => void } | undefined
  killed = false
  env: Record<string, string>
  /** 最近一次临时脚本里 export 的命令级 env */
  lastScriptEnv: Record<string, string> = {}
  /** 最近一次执行的 .ps1 */
  lastPs1: { exe: string; path: string; bom: boolean; text: string } | undefined

  constructor(
    pid: number,
    cwd: string,
    env: Record<string, string>,
    private readonly handlers: Record<string, Handler>,
    private readonly echoStyle: 'plain' | 'conpty'
  ) {
    this.pid = pid
    this.cwd = cwd
    this.env = env
    const blob = Object.values(env).join(' ')
    this.token = /ShunCode;([a-zA-Z0-9_-]+);/.exec(blob)?.[1] ?? ''
    setTimeout(() => this.prompt(0), 1)
  }

  emit(d: string): void {
    if (this.killed) return
    for (const cb of this.dataCbs) cb(d)
  }

  prompt(exitCode: number): void {
    this.running = undefined
    this.seq++
    const cwd = Buffer.from(this.cwd).toString('base64')
    this.emit(`\x1b]633;ShunCode;${this.token};${this.seq};${exitCode};${cwd};${exitCode}\x07$ `)
  }

  finish(code: number): void {
    setTimeout(() => this.prompt(code), 2)
  }

  write(data: string): void {
    if (this.killed) return
    for (const ch of data) {
      if (ch === '\x03') {
        this.emit('^C\r\n')
        this.line = ''
        if (this.running?.onInterrupt) this.running.onInterrupt()
        else if (!this.running) this.prompt(130)
        continue
      }
      if (ch === '\r') {
        const line = this.line
        this.line = ''
        if (this.running) {
          this.emit('\r\n')
          this.running.onInput?.(line)
        } else {
          this.execute(line)
        }
        continue
      }
      this.line += ch
    }
  }

  execute(line: string): void {
    // 回显：conpty 风格夹杂光标控制和分块
    if (this.echoStyle === 'conpty') {
      const half = Math.floor(line.length / 2)
      this.emit(`\x1b[?25l${line.slice(0, half)}`)
      this.emit(`\x1b[?25h${line.slice(half)}\r\n`)
    } else {
      this.emit(`${line}\r\n`)
    }
    this.running = {}
    const m = /^(\S+)\s*(.*)$/s.exec(line)
    const name = m?.[1] ?? ''
    const args = m?.[2] ?? ''
    if (name === 'bash') {
      const scriptPath = args.replace(/^'|'$/g, '')
      const body = fs.readFileSync(scriptPath, 'utf8')
      const marker = /^printf '\\033\]633;ShunCode;([^;]+);S;(\d+)\\007'; ([\s\S]*)$/.exec(body)
      if (!marker) throw new Error('bad script ' + body)
      this.emit(`\x1b]633;ShunCode;${marker[1]};S;${marker[2]}\x07`)
      let inner = marker[3].replace(/\n$/, '')
      // 命令级 env：export K=$'...' ...; 正文（只在这条脚本里生效）
      const scriptEnv: Record<string, string> = {}
      const ex = /^export ((?:[A-Za-z_][A-Za-z0-9_]*=\$'(?:[^'\\]|\\.)*' ?)+); ([\s\S]*)$/.exec(inner)
      if (ex) {
        for (const m of ex[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=\$'((?:[^'\\]|\\.)*)'/g)) {
          scriptEnv[m[1]] = m[2].replace(/\\(x[0-9a-f]{2}|.)/g, (_s, e: string) =>
            e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e.startsWith('x') && e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e
          )
        }
        inner = ex[2]
      }
      this.lastScriptEnv = scriptEnv
      // PowerShell：'pwsh.exe' -NoProfile ... -File '<ps1>'
      const ps = /^'([^']+)' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '([^']+)'$/.exec(inner)
      if (ps) {
        const raw = fs.readFileSync(ps[2])
        const text = raw.toString('utf8')
        this.lastPs1 = { exe: ps[1], path: ps[2], bom: raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, text }
        const envs = [...text.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*) = \[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\('([^']*)'\)\)/g)]
        const body = text.replace(/^\uFEFF/, '').replace(/^try \{[^\n]*?catch \{ \}; /, '').replace(/^(\$env:[^;]*\)\); )*/, '').replace(/\r\n$/, '')
        for (const m of envs) this.emit(`${m[1]}=${Buffer.from(m[2], 'base64').toString('utf8')}\r\n`)
        this.emit(`PS:${body}\r\n`)
        this.finish(0)
        return
      }
      const im = /^(\S+)\s*(.*)$/s.exec(inner)
      const h = this.handlers[im?.[1] ?? '']
      if (!h) {
        this.emit(`bash: ${im?.[1]}: command not found\r\n`)
        this.finish(127)
        return
      }
      h(im?.[2] ?? '', this)
      return
    }
    const h = this.handlers[name]
    if (!h) {
      this.emit(`bash: ${name}: command not found\r\n`)
      this.finish(127)
      return
    }
    h(args, this)
  }
}

const handlers: Record<string, Handler> = {
  echo: (a, sh) => {
    sh.emit(`${a}\r\n`)
    sh.finish(0)
  },
  fail: (a, sh) => {
    sh.emit('boom\r\n')
    sh.finish(Number(a))
  },
  cd: (a, sh) => {
    sh.cwd = a
    sh.finish(0)
  },
  // 模拟「用别的办法 cd 进了 .git」：命令文本里不出现 .git
  'cd-dotgit': (a, sh) => {
    sh.cwd = path.join(a, '.git')
    sh.finish(0)
  },
  pwd: (_a, sh) => {
    sh.emit(`${sh.cwd}\r\n`)
    sh.finish(0)
  },
  big: (a, sh) => {
    const n = Number(a)
    sh.emit('x'.repeat(n) + '\r\n')
    sh.finish(0)
  },
  'sleep-forever': (_a, sh) => {
    sh.running = { onInterrupt: () => sh.finish(130) }
  },
  'ignore-int': (_a, sh) => {
    sh.running = { onInterrupt: () => undefined }
  },
  'read-line': (_a, sh) => {
    sh.emit('name? ')
    sh.running = {
      onInput: (l) => {
        sh.emit(`got:${l}\r\n`)
        sh.finish(0)
      }
    }
  },
  slow: (a, sh) => {
    sh.emit('start\r\n')
    setTimeout(() => {
      sh.emit('end\r\n')
      sh.finish(0)
    }, Number(a))
  },
  // 打出脚本里设的命令级 env（终端自己的 env 里有没有也一并打出来）
  showenv: (a, sh) => {
    for (const k of a.split(/\s+/).filter(Boolean)) sh.emit(`${k}=${JSON.stringify(sh.lastScriptEnv[k] ?? null)} term=${JSON.stringify(sh.env[k] ?? null)}\r\n`)
    sh.lastScriptEnv = {}
    sh.finish(0)
  },
  // 分几次输出，最后一直不结束（等开发服务器那种）
  serve: (_a, sh) => {
    sh.running = { onInterrupt: () => sh.finish(130) }
    setTimeout(() => sh.emit('compiling...\r\n'), 20)
    setTimeout(() => sh.emit('server listening on 5173\r\n'), 60)
  },
  multi: (a, sh) => {
    // 脚本桥接的多行正文：原样打出来
    sh.emit(a.replace(/\n/g, '\r\n') + '\r\n')
    sh.finish(0)
  }
}

function fakePty(echoStyle: 'plain' | 'conpty' = 'plain') {
  const shells: FakeShell[] = []
  let pid = 1000
  const mod = {
    spawn(_file: string, _args: string[], opts: { cwd: string; env: Record<string, string> }) {
      const sh = new FakeShell(++pid, opts.cwd, opts.env, handlers, echoStyle)
      shells.push(sh)
      return {
        get pid() {
          return sh.pid
        },
        onData(cb: (d: string) => void) {
          sh.dataCbs.push(cb)
          return { dispose: () => (sh.dataCbs = sh.dataCbs.filter((c) => c !== cb)) }
        },
        onExit(cb: (e: { exitCode: number }) => void) {
          sh.exitCbs.push(cb)
          return { dispose: () => (sh.exitCbs = sh.exitCbs.filter((c) => c !== cb)) }
        },
        write: (d: string) => sh.write(d),
        kill: () => {
          if (sh.killed) return
          const cbs = [...sh.exitCbs]
          sh.killed = true
          for (const cb of cbs) cb({ exitCode: 1 })
        }
      }
    }
  }
  return { mod, shells }
}

const posixShell: ShellSpec = { file: '/bin/bash', args: [], env: {}, kind: 'posix-bash' }
const ROOT = path.resolve(os.tmpdir())

function makeRunner(extra: Partial<ConstructorParameters<typeof CommandRunner>[0]> = {}, echoStyle: 'plain' | 'conpty' = 'plain') {
  const { mod, shells } = fakePty(echoStyle)
  const killed: number[] = []
  const runner = new CommandRunner({
    loadPty: async () => mod as never,
    shellSpec: () => posixShell,
    platform: process.platform,
    killTree: (pid) => killed.push(pid),
    flushMs: 5,
    echoTimeoutMs: 300,
    cancelGraceMs: 100,
    backgroundStartupMs: 30,
    ...extra
  })
  return { runner, shells, killed }
}

describe('CommandRunner（假 PTY）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-cmd-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('前台命令：吞掉回显，返回输出和退出码', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'echo hello world' })
    expect(r.status).toBe('completed')
    expect(r.exit_code).toBe(0)
    expect(r.output).toBe('hello world\n')
    expect(r.command_id).toMatch(/^cmd_[0-9a-f]{48}$/)
    runner.dispose()
  })

  it('ConPTY 风格的分块回显和光标控制也能吞掉', async () => {
    const { runner } = makeRunner({}, 'conpty')
    const r = await runner.run('agent-a', ROOT, { command: 'echo split-echo' })
    expect(r.output).toBe('split-echo\n')
    runner.dispose()
  })

  it('wait_for 的灾难性回溯正则不会卡住主进程：超时返回 INVALID_ARGUMENT', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: `echo ${'a'.repeat(40)}b` })
    let beats = 0
    const iv = setInterval(() => beats++, 20)
    const t0 = Date.now()
    await expect(runner.getOutput('agent-a', r.command_id, { wait_for: '^(a+)+$', wait_ms: 3000 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    clearInterval(iv)
    expect(Date.now() - t0).toBeLessThan(2000)
    // 等待期间主线程照常跑定时器
    expect(beats).toBeGreaterThan(3)
    // 字面量和正常正则照常工作
    expect((await runner.getOutput('agent-a', r.command_id, { wait_for: 'aaab', wait_ms: 100 })).wait_result).toBe('matched')
    expect((await runner.getOutput('agent-a', r.command_id, { wait_for: 'a{3}b$', wait_ms: 100 })).wait_result).toBe('matched')
    runner.dispose()
  })

  it('用户视角：listAll 列出所有 AI 的命令（运行中的在前），能读任何人的输出、能停任何人的命令；onChange 会触发', async () => {
    let changes = 0
    const { runner } = makeRunner({ onChange: () => changes++ })
    await runner.run('agent-a', ROOT, { command: 'echo from-a' })
    const bg = await runner.run('agent-b', ROOT, { command: 'sleep-forever', background: true })
    const all = runner.listAll()
    expect(all.running).toBe(1)
    expect(all.commands.map((c) => [c.owner, c.status])).toEqual([
      ['agent-b', 'running'],
      ['agent-a', 'completed']
    ])
    const outA = runner.getOutputForUser(all.commands[1].command_id)
    expect(outA).toMatchObject({ owner: 'agent-a', command: 'echo from-a', output: 'from-a\n' })
    const c = await runner.cancelForUser(bg.command_id)
    expect(c).toMatchObject({ owner: 'agent-b' })
    expect(runner.listAll().running).toBe(0)
    expect(() => runner.getOutputForUser('cmd_nope')).toThrow(/找不到/)
    await expect(runner.cancelForUser('cmd_nope')).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    expect(changes).toBeGreaterThan(2)
    runner.dispose()
  })

  it('非零退出码如实返回', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'fail 3' })
    expect(r.status).toBe('completed')
    expect(r.exit_code).toBe(3)
    expect(r.output).toBe('boom\n')
    runner.dispose()
  })

  it('持久终端：cd 在命令之间保留，不传 cwd 复用最近的空闲终端', async () => {
    const { runner, shells } = makeRunner()
    await runner.run('agent-a', ROOT, { command: 'cd /somewhere/else' })
    const r = await runner.run('agent-a', ROOT, { command: 'pwd' })
    expect(r.output).toBe('/somewhere/else\n')
    expect(r.cwd).toBe('/somewhere/else')
    expect(shells).toHaveLength(1)
    runner.dispose()
  })

  it('按「身份 + cwd」复用空闲终端，不同身份不共用', async () => {
    const a = fs.mkdtempSync(path.join(tmp, 'a-'))
    const b = fs.mkdtempSync(path.join(tmp, 'b-'))
    const { runner, shells } = makeRunner()
    await runner.run('agent-a', ROOT, { command: 'echo 1', cwd: a })
    await runner.run('agent-a', ROOT, { command: 'echo 2', cwd: b })
    await runner.run('agent-a', ROOT, { command: 'echo 3', cwd: a })
    expect(shells).toHaveLength(2)
    await runner.run('agent-b', ROOT, { command: 'echo 4', cwd: a })
    expect(shells).toHaveLength(3)
    expect(runner.terminalCount('agent-a')).toEqual({ total: 2, idle: 2 })
    runner.dispose()
  })

  it('每个身份最多保留 4 个空闲终端', async () => {
    const { runner } = makeRunner()
    for (let i = 0; i < 6; i++) {
      const dir = fs.mkdtempSync(path.join(tmp, `d${i}-`))
      await runner.run('agent-a', ROOT, { command: `echo ${i}`, cwd: dir })
    }
    expect(runner.terminalCount('agent-a').idle).toBe(4)
    runner.dispose()
  })

  it('相对 cwd 按工作区解析，绝对 cwd 可以在工作区外，不存在的报错', async () => {
    const { runner } = makeRunner()
    fs.mkdirSync(path.join(tmp, 'sub'))
    const r1 = await runner.run('agent-a', tmp, { command: 'pwd', cwd: 'sub' })
    expect(r1.output.trim()).toBe(path.join(tmp, 'sub'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-outside-'))
    const r2 = await runner.run('agent-a', path.join(tmp, 'sub'), { command: 'pwd', cwd: outside })
    expect(r2.output.trim()).toBe(outside)
    fs.rmSync(outside, { recursive: true, force: true })
    await expect(runner.run('agent-a', tmp, { command: 'pwd', cwd: 'nope' })).rejects.toMatchObject({ code: 'CWD_NOT_FOUND' })
    runner.dispose()
  })

  it('前台超时不杀进程，只返回 running；之后能读到结束状态', async () => {
    const { runner, killed } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'slow 1300', timeout_ms: 1000 })
    expect(r.status).toBe('running')
    expect(r.output).toBe('start\n')
    expect(killed).toEqual([])
    await new Promise((res) => setTimeout(res, 500))
    const o = await runner.getOutput('agent-a', r.command_id, r.next_offset)
    expect(o.status).toBe('completed')
    expect(o.exit_code).toBe(0)
    expect(o.output).toBe('end\n')
    runner.dispose()
  })

  it('后台命令 + send_command_input', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'read-line', background: true })
    expect(r.status).toBe('running')
    expect(r.output).toBe('name? ')
    const s = await runner.sendInput('agent-a', r.command_id, 'Ada')
    expect(s.bytes_sent).toBe(4)
    await new Promise((res) => setTimeout(res, 50))
    const o = await runner.getOutput('agent-a', r.command_id)
    expect(o.status).toBe('completed')
    expect(o.output).toContain('got:Ada')
    await expect(runner.sendInput('agent-a', r.command_id, 'x')).rejects.toMatchObject({ code: 'COMMAND_NOT_RUNNING' })
    runner.dispose()
  })

  it('取消：Ctrl-C 能停就不强杀，终端继续复用', async () => {
    const { runner, killed, shells } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'sleep-forever', background: true })
    const c = await runner.cancel('agent-a', r.command_id)
    expect(c.status).toBe('cancelled')
    expect(c.exit_code).toBe(130)
    expect(c.forced).toBe(false)
    expect(killed).toEqual([])
    await runner.run('agent-a', ROOT, { command: 'echo again' })
    expect(shells).toHaveLength(1)
    const again = await runner.cancel('agent-a', r.command_id)
    expect(again.already_finished).toBe(true)
    runner.dispose()
  })

  it('取消：Ctrl-C 无效就强制结束整棵进程树并关掉终端', async () => {
    const { runner, killed, shells } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'ignore-int', background: true })
    const c = await runner.cancel('agent-a', r.command_id)
    expect(c.forced).toBe(true)
    expect(c.status).toBe('cancelled')
    expect(killed).toEqual([shells[0].pid])
    expect(runner.terminalCount('agent-a').total).toBe(0)
    runner.dispose()
  })

  it('command_id 只对发起它的身份可见', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'echo secret' })
    await expect(runner.getOutput('agent-b', r.command_id)).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    await expect(runner.cancel('agent-b', r.command_id)).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    await expect(runner.getOutput('agent-a', 'cmd_bad')).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    runner.dispose()
  })

  it('输出按绝对偏移，超出上限的部分丢弃并标 output_lost', async () => {
    const { runner } = makeRunner({ maxCapturedBytes: 1000 })
    const r = await runner.run('agent-a', ROOT, { command: 'big 3000', max_output_bytes: 100 })
    expect(r.total_output_bytes).toBe(3001)
    expect(r.output_lost).toBe(true)
    expect(r.offset).toBe(2001)
    expect(r.next_offset).toBe(2101)
    expect(r.has_more).toBe(true)
    const o = await runner.getOutput('agent-a', r.command_id, r.next_offset, 5000)
    expect(o.output_lost).toBe(false)
    expect(o.next_offset).toBe(3001)
    expect(o.has_more).toBe(false)
    runner.dispose()
  })

  it('多行 / 中文命令走临时脚本，开始标记之前的回显全部丢弃，脚本用完即删', async () => {
    const { runner } = makeRunner({ tempDir: tmp })
    const r = await runner.run('agent-a', ROOT, { command: 'multi 你好\nsecond line' })
    expect(r.status).toBe('completed')
    expect(r.output).toBe('你好\nsecond line\n')
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('wsb-run-'))).toEqual([])
    runner.dispose()
  })

  it('releaseOwner 关掉该身份的终端、取消运行中的命令、丢弃记录，不影响其他身份', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'sleep-forever', background: true })
    const other = await runner.run('agent-b', ROOT, { command: 'echo keep' })
    runner.releaseOwner('agent-a')
    expect(runner.terminalCount('agent-a').total).toBe(0)
    await expect(runner.getOutput('agent-a', r.command_id)).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    expect((await runner.getOutput('agent-b', other.command_id)).output).toBe('keep\n')
    expect(runner.terminalCount('agent-b').total).toBe(1)
    runner.dispose()
  })

  it('空命令报错', async () => {
    const { runner } = makeRunner()
    await expect(runner.run('agent-a', ROOT, { command: '   ' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    runner.dispose()
  })
})

describe('commandRunner 纯函数', () => {
  it('解析 W2 / POSIX 提示符标记', () => {
    expect(parseManagedPrompt('W2;3;1;declare -a PIPESTATUS=([0]="0" [1]="1");L2Q=')).toEqual({
      sequence: 3,
      exitCode: 1,
      cwdBase64: 'L2Q=',
      pipelineExitCodes: [0, 1]
    })
    expect(parseManagedPrompt('5;0;L2Q=;0,2')).toEqual({ sequence: 5, exitCode: 0, cwdBase64: 'L2Q=', pipelineExitCodes: [0, 2] })
    expect(parseManagedPrompt('garbage')).toBeUndefined()
    expect(parseBashPipelineSnapshot('declare -a PIPESTATUS=([1]="0")', true)).toBeUndefined()
  })

  it('Windows 协议的 token 必须是安全字符', () => {
    expect(windowsManagedBashProtocol('abc123').env.WSB_MANAGED_PS1).toContain('ShunCode;abc123;W2;')
    expect(() => windowsManagedBashProtocol('a;b')).toThrow()
  })

  it('MSYS 路径转 Windows 路径，cwd 解析允许工作区外', () => {
    expect(normalizeManagedTerminalCwd('/d/AProgram/MCP', 'win32')).toBe('D:\\AProgram\\MCP')
    expect(normalizeManagedTerminalCwd('/c', 'win32')).toBe('C:\\')
    expect(normalizeManagedTerminalCwd('/d/x', 'linux')).toBe('/d/x')
    expect(resolveCommandCwd('D:\\ws', undefined, 'win32')).toBe('D:\\ws')
    expect(resolveCommandCwd('D:\\ws', 'src', 'win32')).toBe('D:\\ws\\src')
    expect(resolveCommandCwd('D:\\ws', 'E:\\other', 'win32')).toBe('E:\\other')
    expect(resolveCommandCwd('D:\\ws', '/e/other', 'win32')).toBe('E:\\other')
    expect(resolveCommandCwd('/ws', '../up', 'linux')).toBe('/up')
  })

  it('哪些命令走脚本桥接', () => {
    expect(needsScriptBridge('echo hi')).toBe(false)
    expect(needsScriptBridge('echo a\necho b')).toBe(true)
    expect(needsScriptBridge('echo 中文')).toBe(true)
    expect(needsScriptBridge('x'.repeat(2000))).toBe(true)
    expect(tempScriptCommand('C:\\T\\a.sh', 'win32')).toBe("bash 'C:/T/a.sh'")
  })

  it('OutputBuffer 不切断多字节字符', () => {
    const b = new OutputBuffer(1000)
    b.append('你好世界')
    const s = b.read(0, 4)
    expect(s.text).toBe('你')
    expect(s.nextOffset).toBe(3)
    const s2 = b.read(1, 100)
    expect(s2.text).toBe('好世界')
  })

  it('stripAnsi 去掉控制序列并留下半个序列', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m\r\nok')).toEqual(['red\nok', ''])
    expect(stripAnsi('abc\x1b[3')).toEqual(['abc', '\x1b[3'])
    expect(stripAnsi('line\r')).toEqual(['line', '\r'])
  })

  it('findWindowsBash 不用 System32 的 WSL bash', () => {
    const exists = (p: string) => p === 'C:\\Windows\\System32\\bash.exe' || p === 'D:\\Git\\cmd\\git.exe' || p === 'D:\\Git\\bin\\bash.exe'
    expect(findWindowsBash({ Path: 'C:\\Windows\\System32;D:\\Git\\cmd' }, exists)).toBe('D:\\Git\\bin\\bash.exe')
    expect(findWindowsBash({ Path: 'C:\\Windows\\System32' }, exists)).toBeUndefined()
  })
})

// ===== #10 安全限制：环境变量白名单、受保护目录、敏感文件、审计、并发上限 =====

describe('命令执行安全限制（纯函数）', () => {
  it('环境变量只传白名单，Windows 大小写不敏感且保留原键名', () => {
    const env = managedProcessEnvironment({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\u',
      'ProgramFiles(x86)': 'C:\\PF86',
      OPENAI_API_KEY: 'sk-leak',
      GITHUB_TOKEN: 'ghp_leak',
      HTTP_PROXY: 'http://user:pw@proxy',
      WORKSPACE_BRIDGE_TOKEN: 'leak',
      ELECTRON_RUN_AS_NODE: '1',
      PS1: '$ ',
      PROMPT_COMMAND: 'x',
      BASH_ENV: '/tmp/evil'
    })
    expect(env.Path).toBe('C:\\Windows')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.USERPROFILE).toBe('C:\\Users\\u')
    expect(env['ProgramFiles(x86)']).toBe('C:\\PF86')
    for (const k of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'HTTP_PROXY', 'WORKSPACE_BRIDGE_TOKEN', 'ELECTRON_RUN_AS_NODE', 'PS1', 'PROMPT_COMMAND', 'BASH_ENV']) {
      expect(env[k]).toBeUndefined()
    }
    expect(env.TERM).toBe('xterm-256color')
    expect(env.HISTFILE).toBe('')
    expect(ENV_ALLOWLIST).toContain('PATH')
    // 额外放行
    expect(managedProcessEnvironment({ MY_VAR: '1', OTHER: '2' }, ['my_var'])).toMatchObject({ MY_VAR: '1' })
    expect(managedProcessEnvironment({ MY_VAR: '1', OTHER: '2' }, ['my_var']).OTHER).toBeUndefined()
  })

  it('受保护的 cwd 只有数据目录，.git/.ssh 不再拦；Windows 不分大小写', () => {
    expect(protectedCwdReason('/repo/.git/hooks', [], 'linux')).toBeUndefined()
    expect(protectedCwdReason('/home/u/.ssh', [], 'linux')).toBeUndefined()
    expect(protectedCwdReason('/repo/src', [], 'linux')).toBeUndefined()
    expect(protectedCwdReason('/repo/.github', [], 'linux')).toBeUndefined()
    expect(protectedCwdReason('/data/bridge/logs', ['/data/bridge'], 'linux')).toContain('数据目录')
    expect(protectedCwdReason('/data/bridge2', ['/data/bridge'], 'linux')).toBeUndefined()
    expect(protectedCwdReason('C:\\Users\\U\\AppData\\Roaming\\Bridge\\x', ['c:\\users\\u\\appdata\\roaming\\bridge'], 'win32')).toContain('数据目录')
    expect(protectedCwdReason('D:\\proj\\.GIT', [], 'win32')).toBeUndefined()
    expect(protectedCwdReason('C:\\USERS\\U\\APPDATA\\ROAMING\\BRIDGE', ['c:\\users\\u\\appdata\\roaming\\bridge'], 'win32')).toContain('数据目录')
    expect(isPathInside('D:\\Proj\\src', 'd:\\proj', 'win32')).toBe(true)
    expect(isPathInside('D:\\proj2', 'D:\\proj', 'win32')).toBe(false)
  })

  it('命令文本里只拦数据目录，.env、私钥、.git 等文件名不再拦', () => {
    const ok = [
      'cat .env',
      'cat ./.env',
      'type config\\.env.local',
      'cat "secrets.json"',
      'cp ~/.ssh/id_rsa /tmp/x',
      'cat .git/config',
      'git --git-dir=.git log',
      'cat server.key',
      'grep TOKEN *.env',
      'cat ~/.npmrc',
      'cat ~/.git-credentials',
      'git status',
      'cat .gitignore',
      'ls .github/workflows',
      'npm run typecheck && npm test',
      'node -e "console.log(process.env.HOME)"',
      'echo env',
      'printenv PATH',
      'cat README.md | grep key'
    ]
    for (const c of ok) expect(protectedCommandHit(c, [], 'linux'), c).toBeUndefined()
    // 数据目录：Windows 三种写法（反斜杠、正斜杠、MSYS）都算
    const dd = ['C:\\Users\\U\\AppData\\Roaming\\Bridge']
    expect(protectedCommandHit('type C:\\Users\\U\\AppData\\Roaming\\Bridge\\config.json', dd, 'win32')).toBeDefined()
    expect(protectedCommandHit('cat c:/users/u/appdata/roaming/bridge/config.json', dd, 'win32')).toBeDefined()
    expect(protectedCommandHit('cat /c/Users/U/AppData/Roaming/Bridge/config.json', dd, 'win32')).toBeDefined()
    expect(protectedCommandHit('cat /c/Users/U/AppData/Roaming/Other/config.json', dd, 'win32')).toBeUndefined()
  })
})

describe('命令执行安全限制（假 PTY）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-sec-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('cwd 在数据目录里直接拒绝，不起终端；.git 里可以执行', async () => {
    const dataDir = path.join(tmp, 'bridge-data')
    fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
    const { runner, shells } = makeRunner({ protectedDirs: [dataDir] })
    await expect(runner.run('agent-a', tmp, { command: 'pwd', cwd: path.join(dataDir, 'logs') })).rejects.toMatchObject({ code: 'PROTECTED' })
    expect(shells).toHaveLength(0)
    const inGit = await runner.run('agent-a', tmp, { command: 'pwd', cwd: path.join('.git', 'hooks') })
    expect(inGit.exit_code).toBe(0)
    const ok = await runner.run('agent-a', tmp, { command: 'pwd' })
    expect(ok.exit_code).toBe(0)
    runner.dispose()
  })

  it.skipIf(process.platform === 'win32')('符号链接指向数据目录也算受保护', async () => {
    const dataDir = path.join(tmp, 'bridge-data')
    fs.mkdirSync(dataDir)
    fs.symlinkSync(dataDir, path.join(tmp, 'innocent'))
    const { runner } = makeRunner({ protectedDirs: [dataDir] })
    await expect(runner.run('agent-a', tmp, { command: 'pwd', cwd: 'innocent' })).rejects.toMatchObject({ code: 'PROTECTED' })
    runner.dispose()
  })

  it('命令或输入里提到数据目录时拒绝，提到 .env 等放行', async () => {
    const dataDir = path.join(tmp, 'bridge-data')
    const { runner, shells } = makeRunner({ protectedDirs: [dataDir] })
    await expect(runner.run('agent-a', tmp, { command: `cat ${path.join(dataDir, 'config.json')}` })).rejects.toMatchObject({ code: 'PROTECTED' })
    expect(shells).toHaveLength(0)
    const r = await runner.run('agent-a', tmp, { command: 'read-line', background: true })
    await expect(runner.sendInput('agent-a', r.command_id, `cat ${path.join(dataDir, 'x')}`)).rejects.toMatchObject({ code: 'PROTECTED' })
    await runner.sendInput('agent-a', r.command_id, 'cat .env')
    await new Promise((res) => setTimeout(res, 40))
    const out = await runner.getOutput('agent-a', r.command_id)
    expect(out.output).toContain('got:cat .env')
    runner.dispose()
  })

  it('空闲终端的 cwd 已经在数据目录里就不再复用', async () => {
    const { runner, shells } = makeRunner({ protectedDirs: [path.join(tmp, '.git')] })
    await runner.run('agent-a', tmp, { command: `cd-dotgit ${tmp}` })
    const r = await runner.run('agent-a', tmp, { command: 'pwd' })
    expect(shells).toHaveLength(2)
    expect(r.output.trim()).toBe(tmp)
    runner.dispose()
  })

  it('结果里写明 sandbox: false 和 cwd_outside_workspace', async () => {
    const { runner } = makeRunner()
    const inside = await runner.run('agent-a', tmp, { command: 'pwd' })
    expect(inside.sandbox).toBe(false)
    expect(inside.cwd_outside_workspace).toBe(false)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-out-'))
    try {
      const r = await runner.run('agent-a', tmp, { command: 'pwd', cwd: outside })
      expect(r.cwd_outside_workspace).toBe(true)
      const again = await runner.getOutput('agent-a', r.command_id)
      expect(again.cwd_outside_workspace).toBe(true)
      expect(again.sandbox).toBe(false)
    } finally {
      runner.dispose()
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('每条命令结束时恰好一条审计记录：身份、工作区、cwd、命令（截断）、审批、时间、退出码、输出字节', async () => {
    const recs: CommandAuditRecord[] = []
    const { runner } = makeRunner({ onAudit: (r) => recs.push(r) })
    await runner.run('agent-a', tmp, { command: 'echo hi' }, { workspaceId: 'ws1', approval: 'approved' })
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      owner: 'agent-a',
      workspace_id: 'ws1',
      workspace_root: tmp,
      cwd: tmp,
      cwd_outside_workspace: false,
      command: 'echo hi',
      command_truncated: false,
      approval: 'approved',
      status: 'completed',
      exit_code: 0,
      output_bytes: 3,
      background: false
    })
    expect(recs[0].ended_at).toBeGreaterThanOrEqual(recs[0].started_at)
    expect(recs[0].duration_ms).toBe(recs[0].ended_at - recs[0].started_at)

    await runner.run('agent-a', tmp, { command: 'fail 4' })
    expect(recs[1]).toMatchObject({ exit_code: 4, approval: 'not_required' })

    const long = 'echo ' + 'a'.repeat(3000)
    await runner.run('agent-a', tmp, { command: long })
    expect(recs[2].command).toHaveLength(2048)
    expect(recs[2].command_truncated).toBe(true)

    // 取消和 releaseOwner 也各记一条，不重复
    const bg = await runner.run('agent-a', tmp, { command: 'sleep-forever', background: true })
    expect(recs).toHaveLength(3)
    await runner.cancel('agent-a', bg.command_id)
    expect(recs).toHaveLength(4)
    expect(recs[3]).toMatchObject({ command_id: bg.command_id, status: 'cancelled', background: true })
    await runner.run('agent-a', tmp, { command: 'ignore-int', background: true })
    runner.releaseOwner('agent-a')
    expect(recs).toHaveLength(5)
    expect(recs[4].status).toBe('terminated')
    runner.dispose()
    expect(recs).toHaveLength(5)
  })

  it('审计记录的 unattended：run_command 已经返回、结束时又没有调用在等，才是 true', async () => {
    const recs: CommandAuditRecord[] = []
    const { runner } = makeRunner({ onAudit: (r) => recs.push(r) })
    // 前台跑完：结果直接回给了调用方
    await runner.run('agent-a', tmp, { command: 'echo ok' })
    expect(recs.at(-1)).toMatchObject({ status: 'completed', unattended: false })
    // 后台，跑完时没人等
    const bg = await runner.run('agent-a', tmp, { command: 'slow 120', background: true })
    expect(bg.status).toBe('running')
    await sleep(300)
    expect(recs.at(-1)).toMatchObject({ command_id: bg.command_id, status: 'completed', background: true, unattended: true })
    // 后台，但 get_command_output 正等着：结果由那次调用带回去
    const watched = await runner.run('agent-a', tmp, { command: 'slow 120', background: true })
    const o = await runner.getOutput('agent-a', watched.command_id, { wait_ms: 5000, wait_for: 'never-matches' })
    expect(o.wait_result).toBe('exited')
    expect(recs.at(-1)).toMatchObject({ command_id: watched.command_id, unattended: false })
    // 前台等到超时转后台的也算
    const late = await runner.run('agent-a', tmp, { command: 'slow 1300', timeout_ms: 1000 })
    expect(late.status).toBe('running')
    await sleep(600)
    expect(recs.at(-1)).toMatchObject({ command_id: late.command_id, background: false, unattended: true })
    runner.dispose()
  })

  it('writeCommandAudit 写成一条 command_audit 活动事件', async () => {
    const started: Array<Record<string, unknown>> = []
    const finished: Array<{ ev: number; patch: Record<string, unknown> }> = []
    const log = {
      start: (e: Record<string, unknown>) => (started.push(e), started.length),
      finish: (ev: number, patch: Record<string, unknown>) => finished.push({ ev, patch })
    }
    const { runner } = makeRunner({ onAudit: (r) => writeCommandAudit(log, r, { name: 'Dev', color: '#123456' }) })
    await runner.run('agent-a', tmp, { command: 'fail 2' }, { workspaceId: 'ws1', approval: 'approved' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ agentId: 'agent-a', agentName: 'Dev', agentColor: '#123456', tool: 'command_audit', workspaceId: 'ws1' })
    expect((started[0].args as Record<string, unknown>).command).toBe('fail 2')
    expect(finished[0].ev).toBe(1)
    expect(finished[0].patch.status).toBe('error')
    expect(finished[0].patch.summary).toContain('退出码 2')
    runner.dispose()
  })

  it('审计回调抛错不影响命令', async () => {
    const { runner } = makeRunner({
      onAudit: () => {
        throw new Error('disk full')
      }
    })
    const r = await runner.run('agent-a', tmp, { command: 'echo ok' })
    expect(r.exit_code).toBe(0)
    runner.dispose()
  })

  it(`每个身份最多同时跑 ${MAX_RUNNING_PER_OWNER} 条，并发发起也一样；不影响其他身份`, async () => {
    const { runner } = makeRunner()
    const results = await Promise.allSettled(
      Array.from({ length: MAX_RUNNING_PER_OWNER + 3 }, () => runner.run('agent-a', tmp, { command: 'sleep-forever', background: true }))
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(MAX_RUNNING_PER_OWNER)
    expect(bad).toHaveLength(3)
    for (const b of bad) expect(b.reason).toMatchObject({ code: 'TOO_MANY_COMMANDS' })
    const other = await runner.run('agent-b', tmp, { command: 'echo b' })
    expect(other.exit_code).toBe(0)
    // 结束一条就能再跑
    const first = (ok[0] as PromiseFulfilledResult<{ command_id: string }>).value
    await runner.cancel('agent-a', first.command_id)
    const again = await runner.run('agent-a', tmp, { command: 'echo again' })
    expect(again.exit_code).toBe(0)
    runner.dispose()
  })

  it('全局终端上限：都在忙就拒绝，有空闲的先回收', async () => {
    const { runner } = makeRunner({ maxSlots: 3 })
    await runner.run('agent-a', tmp, { command: 'sleep-forever', background: true })
    await runner.run('agent-b', tmp, { command: 'sleep-forever', background: true })
    await runner.run('agent-c', tmp, { command: 'echo idle-after' })
    // agent-c 的空闲终端被回收给 agent-d
    const d = await runner.run('agent-d', tmp, { command: 'sleep-forever', background: true })
    expect(d.status).toBe('running')
    await expect(runner.run('agent-e', tmp, { command: 'echo x' })).rejects.toMatchObject({ code: 'TOO_MANY_COMMANDS' })
    runner.dispose()
  })
})

// ===== list_commands / 等待输出 / shell / env =====

describe('list_commands（假 PTY）', () => {
  it('只列自己的命令，最新的在前，status=running 只列运行中的，limit 生效，command 截到 200 字', async () => {
    const { runner } = makeRunner()
    const a1 = await runner.run('agent-a', ROOT, { command: 'echo first' })
    const a2 = await runner.run('agent-a', ROOT, { command: 'sleep-forever', background: true })
    const long = `echo ${'y'.repeat(300)}`
    const a3 = await runner.run('agent-a', ROOT, { command: long })
    await runner.run('agent-b', ROOT, { command: 'echo other' })
    const all = runner.listCommands('agent-a')
    expect(all.total).toBe(3)
    expect(all.commands.map((c) => c.command_id)).toEqual([a3.command_id, a2.command_id, a1.command_id])
    expect(all.commands[0].command).toHaveLength(200)
    expect(all.commands[2]).toMatchObject({ command: 'echo first', shell: 'bash', status: 'completed', exit_code: 0, background: false, output_bytes: 6, cwd: ROOT })
    expect(new Date(all.commands[2].started_at).toISOString()).toBe(all.commands[2].started_at)
    expect(all.commands[2].duration_ms).toBeGreaterThanOrEqual(0)
    const running = runner.listCommands('agent-a', { status: 'running' })
    expect(running.commands.map((c) => c.command_id)).toEqual([a2.command_id])
    expect(running.commands[0]).toMatchObject({ background: true, status: 'running', exit_code: null })
    expect(runner.listCommands('agent-a', { limit: 1 }).commands).toHaveLength(1)
    expect(runner.listCommands('agent-c').commands).toEqual([])
    expect(() => runner.listCommands('agent-a', { status: 'done' as never })).toThrow(/status/)
    runner.dispose()
  })
})

describe('get_command_output 等待（假 PTY）', () => {
  it('wait_for 匹配上就返回 matched 和 matched_text', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'serve', background: true })
    const t0 = Date.now()
    const o = await runner.getOutput('agent-a', r.command_id, { wait_ms: 5000, wait_for: 'listening on (\\d+)' })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(o.wait_result).toBe('matched')
    expect(o.matched_text).toBe('listening on 5173')
    expect(o.status).toBe('running')
    expect(o.output).toContain('server listening on 5173')
    runner.dispose()
  })

  it('只看 offset 之后的新输出：旧输出里有也不算', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'serve', background: true })
    const first = await runner.getOutput('agent-a', r.command_id, { wait_ms: 5000, wait_for: 'listening' })
    expect(first.wait_result).toBe('matched')
    const again = await runner.getOutput('agent-a', r.command_id, { offset: first.next_offset, wait_ms: 80, wait_for: 'listening' })
    expect(again.wait_result).toBe('timeout')
    expect(again.matched_text).toBeUndefined()
    runner.dispose()
  })

  it('只给 wait_ms：有新输出就返回 new_output；命令结束返回 exited；都没有就 timeout', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'serve', background: true })
    const o = await runner.getOutput('agent-a', r.command_id, { offset: r.next_offset, wait_ms: 5000 })
    expect(o.wait_result).toBe('new_output')
    expect(o.output.length).toBeGreaterThan(0)
    expect(o.offset).toBe(r.next_offset)
    const s = await runner.run('agent-a', ROOT, { command: 'slow 80', background: true })
    const e = await runner.getOutput('agent-a', s.command_id, { wait_ms: 5000, wait_for: 'never-matches' })
    expect(e.wait_result).toBe('exited')
    expect(e.status).toBe('completed')
    const f = await runner.run('agent-a', ROOT, { command: 'sleep-forever', background: true })
    const t = await runner.getOutput('agent-a', f.command_id, { offset: f.next_offset, wait_ms: 60 })
    expect(t.wait_result).toBe('timeout')
    // 不带等待参数时结果里没有 wait_result（老的调用方式不变）
    const plain = await runner.getOutput('agent-a', f.command_id, f.next_offset)
    expect(plain.wait_result).toBeUndefined()
    runner.dispose()
  })

  it('wait_for 编译失败或太长返回 INVALID_ARGUMENT', async () => {
    const { runner } = makeRunner()
    const r = await runner.run('agent-a', ROOT, { command: 'echo x' })
    await expect(runner.getOutput('agent-a', r.command_id, { wait_ms: 10, wait_for: '(' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(runner.getOutput('agent-a', r.command_id, { wait_for: 'a'.repeat(501) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    runner.dispose()
  })

  it('等待期间取消、全部停下、释放身份、调用方断开都能马上结束等待', async () => {
    const { runner } = makeRunner({ cancelGraceMs: 600 })
    const quick = async (p: Promise<{ wait_result?: string }>) => {
      const t0 = Date.now()
      const o = await p
      return { o, ms: Date.now() - t0 }
    }
    // cancel：Ctrl-C 被忽略，宽限期 600 ms，但等待在发出取消时就结束
    const a = await runner.run('agent-a', ROOT, { command: 'ignore-int', background: true })
    const wa = quick(runner.getOutput('agent-a', a.command_id, { offset: a.next_offset, wait_ms: 10_000, wait_for: 'x' }))
    await sleep(20)
    const cancelling = runner.cancel('agent-a', a.command_id)
    const ra = await wa
    expect(ra.o.wait_result).toBe('exited')
    expect(ra.ms).toBeLessThan(1000)
    await cancelling
    // 全部停下
    const b = await runner.run('agent-a', ROOT, { command: 'ignore-int', background: true })
    const wb = quick(runner.getOutput('agent-a', b.command_id, { offset: b.next_offset, wait_ms: 10_000 }))
    await sleep(20)
    const stopping = runner.cancelAllRunning()
    expect((await wb).ms).toBeLessThan(1000)
    await stopping
    // 调用方断开
    const c = await runner.run('agent-a', ROOT, { command: 'sleep-forever', background: true })
    const ac = new AbortController()
    const wc = quick(runner.getOutput('agent-a', c.command_id, { offset: c.next_offset, wait_ms: 10_000, signal: ac.signal }))
    await sleep(20)
    ac.abort()
    const rc = await wc
    expect(rc.o.wait_result).toBe('timeout')
    expect(rc.ms).toBeLessThan(1000)
    // 释放身份
    const wd = quick(runner.getOutput('agent-a', c.command_id, { offset: c.next_offset, wait_ms: 10_000 }))
    await sleep(20)
    runner.releaseOwner('agent-a')
    const rd = await wd
    expect(rd.o.wait_result).toBe('exited')
    expect(rd.ms).toBeLessThan(1000)
    runner.dispose()
  })

  it('wait_for 只在最近 64 KB 窗口里匹配', async () => {
    const { runner } = makeRunner()
    // 'MARK' 后面跟 70 KB 输出：MARK 落在窗口外
    const r = await runner.run('agent-a', ROOT, { command: 'echo MARK' })
    const b = await runner.run('agent-a', ROOT, { command: `big ${70 * 1024}` })
    expect(r.command_id).not.toBe(b.command_id)
    const inWindow = await runner.getOutput('agent-a', b.command_id, { wait_ms: 10, wait_for: 'x{10}' })
    expect(inWindow.wait_result).toBe('matched')
    expect(inWindow.matched_text).toBe('x'.repeat(10))
    const head = await runner.getOutput('agent-a', b.command_id, { wait_ms: 10, wait_for: '^x{70000}' })
    // 窗口从总长 - 64 KB 开始，开头那一段不在里面；窗口里连续的 x 不够 70000 个
    expect(head.wait_result).toBe('exited')
    runner.dispose()
  })
})

describe('run_command 的 shell 和 env（假 PTY）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-shell-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('bash 的 env 走临时脚本、安全转义，只对这一条生效，不污染复用的终端', async () => {
    const { runner, shells } = makeRunner({ tempDir: tmp })
    const tricky = `it's "q" $HOME \`id\` \\ ; rm -rf /\nline2\ttab 中文`
    const r = await runner.run('agent-a', ROOT, { command: 'showenv FOO BAR', env: { FOO: tricky, BAR: '' } })
    expect(r.status).toBe('completed')
    expect(r.output).toBe(`FOO=${JSON.stringify(tricky)} term=null\nBAR="" term=null\n`)
    // 同一个终端再跑一条：看不到上一条的 env
    const again = await runner.run('agent-a', ROOT, { command: 'showenv FOO' })
    expect(again.output).toBe('FOO=null term=null\n')
    expect(shells).toHaveLength(1)
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('wsb-run-'))).toEqual([])
    runner.dispose()
  })

  it('env 校验：键名、个数、值长度、类型', async () => {
    const { runner, shells } = makeRunner()
    const bad = async (env: unknown) => expect(runner.run('agent-a', ROOT, { command: 'echo x', env: env as Record<string, string> })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await bad({ '1ABC': 'x' })
    await bad({ 'A-B': 'x' })
    await bad({ 'A;rm': 'x' })
    await bad({ A: 1 })
    await bad({ A: 'x'.repeat(32 * 1024 + 1) })
    await bad(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, 'v'])))
    await bad(['x'])
    expect(shells).toHaveLength(0)
    const ok = await runner.run('agent-a', ROOT, { command: 'echo ok', env: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`K${i}`, 'v'])) })
    expect(ok.status).toBe('completed')
    runner.dispose()
  })

  it('powershell：写带 BOM 的 UTF-8 .ps1，在 bash 终端里用 pwsh -File 执行，env 用 $env: 设置，脚本用完即删', async () => {
    const exe = process.platform === 'win32' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : '/usr/bin/pwsh'
    const { runner, shells } = makeRunner({ tempDir: tmp, findPowerShell: () => exe })
    const r = await runner.run('agent-a', ROOT, { command: 'Write-Output "你好"\nGet-Location', shell: 'powershell', env: { MY_VAR: "a'b\u2019c" } })
    expect(r.status).toBe('completed')
    expect(r.output).toBe(`MY_VAR=a'b\u2019c\nPS:Write-Output "你好"\nGet-Location\n`)
    const ps1 = shells[0].lastPs1!
    expect(ps1.bom).toBe(true)
    expect(ps1.exe).toBe(process.platform === 'win32' ? exe.replace(/\\/g, '/') : exe)
    expect(ps1.path.endsWith('.ps1')).toBe(true)
    expect(ps1.text).toContain('[Console]::OutputEncoding')
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('wsb-run-'))).toEqual([])
    // 终端照常复用，env 没留下
    const again = await runner.run('agent-a', ROOT, { command: 'showenv MY_VAR' })
    expect(again.output).toBe('MY_VAR=null term=null\n')
    expect(shells).toHaveLength(1)
    expect(runner.listCommands('agent-a').commands.map((c) => c.shell)).toEqual(['bash', 'powershell'])
    runner.dispose()
  })

  it('找不到 PowerShell 时返回 SHELL_NOT_FOUND，不起终端；shell 取值不对报 INVALID_ARGUMENT', async () => {
    const { runner, shells } = makeRunner({ findPowerShell: () => undefined })
    await expect(runner.run('agent-a', ROOT, { command: 'Get-Date', shell: 'powershell' })).rejects.toMatchObject({ code: 'SHELL_NOT_FOUND' })
    expect(() => runner.precheckRun(ROOT, { command: 'Get-Date', shell: 'powershell' })).toThrow(/PowerShell|pwsh/)
    await expect(runner.run('agent-a', ROOT, { command: 'x', shell: 'cmd' as never })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(shells).toHaveLength(0)
    runner.dispose()
  })

  it('数据目录拦截也覆盖 env 的值和 PowerShell 脚本', async () => {
    const dataDir = path.join(tmp, 'bridge-data')
    const { runner, shells } = makeRunner({ protectedDirs: [dataDir], findPowerShell: () => '/usr/bin/pwsh' })
    await expect(runner.run('agent-a', tmp, { command: 'showenv P', env: { P: path.join(dataDir, 'tokens.json') } })).rejects.toMatchObject({ code: 'PROTECTED' })
    expect(() => runner.precheckRun(tmp, { command: 'echo', env: { P: dataDir } })).toThrow(/数据目录/)
    await expect(runner.run('agent-a', tmp, { command: `Get-Content '${path.join(dataDir, 'config.json')}'`, shell: 'powershell' })).rejects.toMatchObject({ code: 'PROTECTED' })
    expect(shells).toHaveLength(0)
    runner.dispose()
  })
})

describe('shell / env 纯函数', () => {
  it('findPowerShell：Windows 先 pwsh 再 powershell.exe；非 Windows 只找 pwsh', () => {
    const env = { Path: 'C:\\Tools;C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }
    const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const pwsh7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(findPowerShell('win32', env, (p) => p === ps5 || p === pwsh7)).toBe(pwsh7)
    expect(findPowerShell('win32', env, (p) => p === ps5)).toBe(ps5)
    expect(findPowerShell('win32', env, () => false)).toBeUndefined()
    expect(findPowerShell('linux', { PATH: '/opt/x:/usr/bin' }, (p) => p === '/usr/bin/pwsh')).toBe('/usr/bin/pwsh')
    expect(findPowerShell('darwin', { PATH: '/usr/bin' }, (p) => p.endsWith('powershell.exe'))).toBeUndefined()
  })

  it('bashQuoteValue / bashEnvPrefix 转义引号、反斜杠、换行和控制字符', () => {
    expect(bashQuoteValue(`a'b\\c\nd\x01`)).toBe(`$'a\\'b\\\\c\\nd\\x01'`)
    expect(bashEnvPrefix({ A: '1', B: 'x y' })).toBe(`export A=$'1' B=$'x y'; `)
    expect(bashEnvPrefix(undefined)).toBe('')
  })

  it('powershellInvocation 带全部参数，Windows 路径换成正斜杠', () => {
    expect(powershellInvocation('C:\\PS\\pwsh.exe', 'C:\\Temp\\a.ps1', 'win32')).toBe(
      `'C:/PS/pwsh.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:/Temp/a.ps1'`
    )
  })

  it('validateCommandEnv 和 compileWaitPattern', () => {
    expect(validateCommandEnv(undefined)).toBeUndefined()
    expect(validateCommandEnv({})).toBeUndefined()
    expect(validateCommandEnv({ _A1: 'v' })).toEqual({ _A1: 'v' })
    expect(() => validateCommandEnv({ 'a b': 'v' })).toThrow(/变量名/)
    expect(compileWaitPattern(undefined)).toBeUndefined()
    expect(compileWaitPattern('^ready$')!.test('x\nready\ny')).toBe(true)
    expect(() => compileWaitPattern('[')).toThrow(/正则/)
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ===== 真实 bash：Windows 用 Git Bash，其他平台用 /bin/bash；node-pty 或 bash 不可用时跳过 =====

let realPty: unknown
try {
  realPty = createRequire(import.meta.url)('node-pty')
} catch {
  realPty = undefined
}
const realBash = process.platform === 'win32' ? findWindowsBash() : fs.existsSync('/bin/bash') ? '/bin/bash' : undefined
const canRunReal = !!realPty && !!realBash && process.env.WSB_SKIP_REAL_PTY !== '1'

describe.skipIf(!canRunReal)('CommandRunner（真实 bash）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-real-'))
  const runner = new CommandRunner({ loadPty: async () => realPty as never })
  afterEach(() => undefined)

  it('退出码、cd / export 保留、管道退出码、脚本桥接', async () => {
    try {
      const r1 = await runner.run('real', root, { command: 'echo hi-from-bash', timeout_ms: 30000 })
      expect(r1.status).toBe('completed')
      expect(r1.exit_code).toBe(0)
      expect(r1.output.trim()).toBe('hi-from-bash')

      const r2 = await runner.run('real', root, { command: 'false', timeout_ms: 30000 })
      expect(r2.exit_code).toBe(1)

      fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
      await runner.run('real', root, { command: 'cd sub && export WSB_X=kept', timeout_ms: 30000 })
      const r3 = await runner.run('real', root, { command: 'echo "$WSB_X" && basename "$PWD"', timeout_ms: 30000 })
      expect(r3.output.replace(/\r/g, '').trim().split('\n')).toEqual(['kept', 'sub'])

      const r4 = await runner.run('real', root, { command: 'true | false | true', timeout_ms: 30000 })
      expect(r4.exit_code).toBe(0)
      expect(r4.pipeline_exit_codes).toEqual([0, 1, 0])

      const r5 = await runner.run('real', root, { command: 'echo 第一行\necho line2\nexit 7', timeout_ms: 30000 })
      expect(r5.exit_code).toBe(7)
      expect(r5.output.replace(/\r/g, '').trim().split('\n')).toEqual(['第一行', 'line2'])

      const r6 = await runner.run('real', root, { command: 'sleep 30', background: true })
      expect(r6.status).toBe('running')
      const c = await runner.cancel('real', r6.command_id)
      expect(c.status).toBe('cancelled')
    } finally {
      runner.dispose()
      // Windows 上 taskkill 是异步的，bash 退出前它的 cwd 还被占着；清理失败不能盖掉上面真正的断言错误
      await new Promise((res) => setTimeout(res, 500))
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch {
        // 留在临时目录里
      }
    }
  }, 90_000)

  it('子进程看不到白名单以外的环境变量，git 等工具仍能用', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-env-'))
    process.env.WSB_SECRET_TEST = 'leaked-value'
    const plain = new CommandRunner({ loadPty: async () => realPty as never })
    const allowed = new CommandRunner({ loadPty: async () => realPty as never, extraEnvAllow: ['WSB_SECRET_TEST'] })
    try {
      const r1 = await plain.run('real-env', root2, { command: 'echo "[${WSB_SECRET_TEST:-unset}]"', timeout_ms: 30000 })
      expect(r1.exit_code).toBe(0)
      expect(r1.output.trim()).toBe('[unset]')
      const r2 = await plain.run('real-env', root2, { command: 'command -v ls >/dev/null && echo has-path', timeout_ms: 30000 })
      expect(r2.output.trim()).toBe('has-path')
      const r3 = await allowed.run('real-env', root2, { command: 'echo "[${WSB_SECRET_TEST:-unset}]"', timeout_ms: 30000 })
      expect(r3.output.trim()).toBe('[leaked-value]')
    } finally {
      delete process.env.WSB_SECRET_TEST
      plain.dispose()
      allowed.dispose()
      await new Promise((res) => setTimeout(res, 500))
      try {
        fs.rmSync(root2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch {
        // 留在临时目录里
      }
    }
  }, 90_000)

  it.skipIf(!findPowerShell())('bash 的 env、PowerShell 执行（中文、env、退出码），终端不被污染', async () => {
    const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-ps-'))
    const r = new CommandRunner({ loadPty: async () => realPty as never })
    try {
      const tricky = `it's "q" $HOME \`echo no\` 中文`
      const b1 = await r.run('real-ps', root3, { command: 'printf "[%s]" "$WSB_ENV_T"', env: { WSB_ENV_T: tricky }, timeout_ms: 30000 })
      expect(b1.output.replace(/\r/g, '').trim()).toBe(`[${tricky}]`)
      const b2 = await r.run('real-ps', root3, { command: 'echo "[${WSB_ENV_T:-unset}]"', timeout_ms: 30000 })
      expect(b2.output.trim()).toBe('[unset]')
      const p1 = await r.run('real-ps', root3, {
        command: 'Write-Output "你好-$env:WSB_PS_T"\nexit 3',
        shell: 'powershell',
        env: { WSB_PS_T: "a'b" },
        timeout_ms: 60000
      })
      expect(p1.status).toBe('completed')
      expect(p1.exit_code).toBe(3)
      expect(p1.output).toContain("你好-a'b")
      const b3 = await r.run('real-ps', root3, { command: 'echo after-ps', timeout_ms: 30000 })
      expect(b3.output.trim()).toBe('after-ps')
    } finally {
      r.dispose()
      await new Promise((res) => setTimeout(res, 500))
      try {
        fs.rmSync(root3, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch {
        // 留在临时目录里
      }
    }
  }, 120_000)
})
