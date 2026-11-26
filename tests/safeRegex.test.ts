// T-16：wait_for 正则的 250 毫秒只算匹配本身，不算起 worker 的时间。
// 以前机器一忙（全量测试一起跑），光起 worker 就超过 250 毫秒，简单的正则也被报成「回溯爆炸」（第 44 批第一遍检查就挂在这上面）
import { describe, expect, it } from 'vitest'
import { isLiteralPattern, RegexSandbox } from '../src/core/safeRegex'

/** 让主线程忙一阵：模拟机器忙，worker 起好的消息要等这段过去才收得到 */
function busy(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* 占着主线程 */
  }
}

describe('RegexSandbox', () => {
  it('起 worker 的时间不算进匹配时限：刚开始匹配主线程就忙了 400 毫秒，简单的正则照样匹配上', async () => {
    const box = new RegexSandbox()
    try {
      const p = box.exec('x{10}', '', `${'y'.repeat(100)}${'x'.repeat(20)}`, 250)
      busy(400)
      expect(await p).toEqual({ match: 'x'.repeat(10) })
      // worker 起好以后接着用，不用再起
      expect(await box.exec('\\d+', '', 'abc123def')).toEqual({ match: '123' })
    } finally {
      box.dispose()
    }
  })

  it('真的回溯爆炸还是会超时；超时杀掉 worker 以后，下一次换新的 worker 照常匹配', async () => {
    const box = new RegexSandbox()
    try {
      expect(await box.exec('(a+)+$', '', `${'a'.repeat(40)}b`, 200)).toEqual({ timedOut: true })
      expect(await box.exec('b$', '', `${'a'.repeat(40)}b`)).toEqual({ match: 'b' })
    } finally {
      box.dispose()
    }
  }, 15_000)

  it('两条同时等 worker 起好：都能拿到各自的结果', async () => {
    const box = new RegexSandbox()
    try {
      const [a, b] = await Promise.all([box.exec('a.c', '', 'xxabcxx'), box.exec('[0-9]{3}', '', 'ab1234')])
      expect(a).toEqual({ match: 'abc' })
      expect(b).toEqual({ match: '123' })
    } finally {
      box.dispose()
    }
  })

  it('写错的正则报错误，不算超时；字面量不进 worker', async () => {
    const box = new RegexSandbox()
    try {
      const bad = await box.exec('(', '', 'x')
      expect('error' in bad && bad.error).toBeTruthy()
      expect(isLiteralPattern('ready now')).toBe(true)
      expect(isLiteralPattern('a.b')).toBe(false)
      expect(await box.exec('READY', 'i', 'server ready')).toEqual({ match: 'ready' })
    } finally {
      box.dispose()
    }
  })

  it('worker 起不来（等太久）：返回错误说明，不报成回溯爆炸', async () => {
    // 起 worker 的等待上限设成 1 毫秒，再让主线程忙一下，起好的消息一定来不及
    const box = new RegexSandbox(1)
    try {
      const p = box.exec('a+', '', 'aaa')
      busy(50)
      const r = await p
      expect(r).not.toHaveProperty('timedOut')
      expect('error' in r && r.error).toContain('没起来')
    } finally {
      box.dispose()
    }
  })

  it('dispose 以后不再起新的 worker', async () => {
    const box = new RegexSandbox()
    box.dispose()
    const r = await box.exec('a+', '', 'aaa')
    expect('error' in r).toBe(true)
  })
})
