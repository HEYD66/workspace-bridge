import { describe, expect, it } from 'vitest'
import { CommandRunner, type ShellSpec } from '../src/core/commandRunner'

type DataCb = (data: string) => void

class TinyPty {
  readonly pid = 4321
  private readonly data: DataCb[] = []
  private line = ''
  private seq = 0
  private readonly token: string

  constructor(private readonly cwd: string, env: Record<string, string>) {
    this.token = /ShunCode;([a-zA-Z0-9_-]+);/.exec(Object.values(env).join(' '))?.[1] ?? ''
    setTimeout(() => this.prompt(0), 0)
  }

  onData(cb: DataCb): { dispose: () => void } {
    this.data.push(cb)
    return { dispose: () => undefined }
  }

  onExit(_cb: (e: { exitCode: number }) => void): { dispose: () => void } {
    return { dispose: () => undefined }
  }

  write(value: string): void {
    for (const ch of value) {
      if (ch === '\r') {
        const line = this.line
        this.line = ''
        this.emit(`${line}\r\n`)
        const echo = /^echo\s+([\s\S]*)$/.exec(line)
        if (echo) this.emit(`${echo[1]}\r\n`)
        this.prompt(echo ? 0 : 127)
      } else {
        this.line += ch
      }
    }
  }

  kill(): void {}

  private emit(value: string): void {
    for (const cb of this.data) cb(value)
  }

  private prompt(exitCode: number): void {
    this.seq++
    const encoded = Buffer.from(this.cwd).toString('base64')
    this.emit(`\x1b]633;ShunCode;${this.token};${this.seq};${exitCode};${encoded};${exitCode}\x07$ `)
  }
}

const shell: ShellSpec = { file: '/bin/bash', args: [], env: {}, kind: 'posix-bash' }

function makeRunner(): CommandRunner {
  return new CommandRunner({
    loadPty: async () => ({
      spawn: (_file: string, _args: string[], opts: { cwd: string; env: Record<string, string> }) => new TinyPty(opts.cwd, opts.env)
    }) as never,
    shellSpec: () => shell,
    platform: process.platform,
    flushMs: 5,
    echoTimeoutMs: 300
  })
}

describe('CommandRunner 命令记录', () => {
  it('命令结束后按 agent 保存输出尾部，并支持 limit / since', async () => {
    const runner = makeRunner()
    const first = await runner.run('agent-a', process.cwd(), { command: 'echo first' })
    const firstRecord = runner.recentRecords('agent-a')[0]
    expect(firstRecord).toMatchObject({ agentId: 'agent-a', command: 'echo first', exitCode: 0, output: 'first\n' })
    expect(firstRecord.durationMs).toBeGreaterThanOrEqual(0)

    await runner.run('agent-a', process.cwd(), { command: 'echo second' })
    await runner.run('agent-b', process.cwd(), { command: 'echo other' })
    expect(runner.recentRecords('agent-a', { limit: 1 })[0]?.command).toBe('echo second')
    expect(runner.recentRecords('agent-b')).toHaveLength(1)
    expect(runner.recentRecords('agent-a', { since: firstRecord.endedAt + 1 })).toHaveLength(1)
    expect(runner.recentRecords('agent-a', { since: Date.now() + 1 })).toHaveLength(0)
    expect(first.command_id).toMatch(/^cmd_[0-9a-f]{48}$/)
    runner.dispose()
  })

  it('运行中的命令不会提前出现在命令记录里', async () => {
    const runner = makeRunner()
    const result = await runner.run('agent-a', process.cwd(), { command: 'echo ready' })
    expect(runner.recentRecords('agent-a')).toHaveLength(1)
    expect(runner.recentRecords('agent-a')[0]?.command).toBe('echo ready')
    expect(result.status).toBe('completed')
    runner.dispose()
  })

  it('每个身份只保留最近 50 条记录', async () => {
    const runner = makeRunner()
    for (let i = 0; i < 52; i++) await runner.run('agent-a', process.cwd(), { command: `echo item-${i}` })
    const records = runner.recentRecords('agent-a', { limit: 50 })
    expect(records).toHaveLength(50)
    expect(records[0]?.command).toBe('echo item-51')
    expect(records.some((r) => r.command === 'echo item-0')).toBe(false)
    runner.dispose()
  })
})
