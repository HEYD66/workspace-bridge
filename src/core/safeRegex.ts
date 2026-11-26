// AI 给的正则（get_command_output 的 wait_for）不能在主进程里跑：(a+)+$ 这类嵌套量词遇到特定输入会灾难性回溯，
// 一次 exec 就能卡住主进程几分钟（工作台界面、急停、审批、所有 AI 连接一起冻住）。
// 这里把匹配放进一个 worker 线程，超时就 terminate（实测能打断正在回溯的 exec），主进程始终不卡。
//
// 计时从 worker 起好以后才开始（T-16）：以前 250 毫秒里包括了新建 worker 的时间，机器一忙（比如全量测试 99 个文件一起跑），
// 光起 worker 就超过 250 毫秒，简单的正则也会被报成「回溯爆炸」。第一次用、或上一个 worker 因超时被杀掉以后，都要重新起
import { Worker } from 'node:worker_threads'

/** 一次匹配最多跑多久（不含起 worker 的时间） */
export const REGEX_BUDGET_MS = 250
/** 起一个 worker 最多等多久：等不到就当这次没法匹配（机器忙到这个程度，报个错让 AI 过一会儿再试） */
export const REGEX_BOOT_MS = 10_000

const WORKER_CODE = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', ({ id, src, flags, text }) => {
  try {
    const m = new RegExp(src, flags).exec(text)
    parentPort.postMessage({ id, match: m ? m[0] : null })
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.message || e) })
  }
})
parentPort.postMessage({ ready: true })
`

export type SafeExecResult = { match: string | null } | { timedOut: true } | { error: string }

/** 不含任何正则元字符：直接按字面子串找，不用进 worker */
export function isLiteralPattern(src: string): boolean {
  return !/[\\^$.*+?()[\]{}|]/.test(src)
}

export class RegexSandbox {
  private worker?: Worker
  /** 每个 worker 起好没有：起好是 true，退出了或等太久是 false */
  private readonly ready = new WeakMap<Worker, Promise<boolean>>()
  private seq = 0
  private disposed = false
  /** 每条在等的匹配记着它发给了哪个 worker：旧 worker 退出时只结束它自己的，不误伤发给新 worker 的 */
  private readonly pending = new Map<number, { resolve: (r: SafeExecResult) => void; timer: NodeJS.Timeout; worker: Worker }>()

  constructor(private readonly bootMs = REGEX_BOOT_MS) {}

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(WORKER_CODE, { eval: true })
    w.unref()
    this.ready.set(
      w,
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.bootMs)
        timer.unref?.()
        const done = (ok: boolean): void => {
          clearTimeout(timer)
          w.off('message', onReady)
          w.off('exit', onExit)
          resolve(ok)
        }
        const onReady = (msg: { ready?: boolean }): void => {
          if (msg?.ready) done(true)
        }
        const onExit = (): void => done(false)
        w.on('message', onReady)
        w.on('exit', onExit)
      })
    )
    w.on('message', (msg: { id?: number; match?: string | null; error?: string }) => {
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      p.resolve(msg.error !== undefined ? { error: msg.error } : { match: msg.match ?? null })
    })
    // worker 退出（被 terminate 或崩了）：发给它的、还在等的按超时处理；下次用时重建
    w.on('exit', () => {
      if (this.worker === w) this.worker = undefined
      for (const [id, p] of this.pending) {
        if (p.worker !== w) continue
        clearTimeout(p.timer)
        p.resolve({ timedOut: true })
        this.pending.delete(id)
      }
    })
    w.on('error', () => undefined)
    this.worker = w
    return w
  }

  /** 拿一个已经起好的 worker；起不来返回 undefined。等的时候 worker 被别的匹配超时杀掉了，就再起一个（最多换两次） */
  private async readyWorker(): Promise<Worker | undefined> {
    for (let i = 0; i < 3; i++) {
      if (this.disposed) return undefined
      const w = this.ensure()
      const ok = await this.ready.get(w)
      if (ok && this.worker === w) return w
      if (!ok) {
        // 起不来（等太久或刚起就退出）：丢掉，下一轮或下次重建
        if (this.worker === w) this.worker = undefined
        void w.terminate()
      }
    }
    return undefined
  }

  /** 在 worker 里 exec；worker 起好后超过 budgetMs 还没结果就杀掉 worker 返回 timedOut。字面量模式直接在本线程 indexOf */
  async exec(src: string, flags: string, text: string, budgetMs = REGEX_BUDGET_MS): Promise<SafeExecResult> {
    if (isLiteralPattern(src)) {
      const i = flags.includes('i') ? text.toLowerCase().indexOf(src.toLowerCase()) : text.indexOf(src)
      return { match: i >= 0 ? text.slice(i, i + src.length) : null }
    }
    const w = await this.readyWorker()
    if (!w && this.disposed) return { error: '已经关闭，不再匹配' }
    if (!w) return { error: `匹配用的线程 ${Math.round(this.bootMs / 1000)} 秒内没起来（机器太忙），过一会儿再调一次` }
    const id = ++this.seq
    return new Promise<SafeExecResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ timedOut: true })
        // 卡住的 exec 只能连 worker 一起杀掉；马上丢掉引用，下一次匹配直接用新 worker，不会发到正在退出的旧 worker 上
        if (this.worker === w) this.worker = undefined
        void w.terminate()
      }, budgetMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer, worker: w })
      w.postMessage({ id, src, flags, text })
    })
  }

  dispose(): void {
    this.disposed = true
    const w = this.worker
    this.worker = undefined
    if (w) void w.terminate()
  }
}
