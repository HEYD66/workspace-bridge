import { describe, expect, it } from 'vitest'
import { duration, stripAnsi } from '../src/renderer/src/views/CommandsView'

describe('AI 命令页的显示辅助', () => {
  it('stripAnsi：去掉颜色和光标码，回车覆盖的行只留最后一段，Windows 换行变成 \\n', () => {
    expect(stripAnsi('\x1b[32mok\x1b[0m\n')).toBe('ok\n')
    expect(stripAnsi('progress 10%\rprogress 100%\n')).toBe('progress 100%\n')
    expect(stripAnsi('a\r\nb\r\n')).toBe('a\nb\n')
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text')
  })
  it('duration', () => {
    expect(duration(850)).toBe('850 毫秒')
    expect(duration(12_400)).toBe('12 秒')
    expect(duration(125_000)).toBe('2 分 5 秒')
    expect(duration(3_725_000)).toBe('1 小时 2 分')
  })
})
