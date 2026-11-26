// T-8：通用右键菜单的纯逻辑 + 群聊右键用到的函数 + @ 候选「全体 / all」
import { describe, expect, it } from 'vitest'
import { clampPosition, disabledReason, edgeIndex, moveIndex, pressAction, tidyEntries, type MenuAction, type MenuEntry } from '../src/renderer/src/lib/contextMenu'
import { appendPiece, mentionOptions, mentionText, quoteBlock } from '../src/renderer/src/lib/groupChat'
import type { Agent } from '../src/core/types'

const act = (id: string, extra: Partial<MenuAction> = {}): MenuAction => ({ id, label: id, run: () => {}, ...extra })

describe('菜单项整理', () => {
  it('去掉开头、结尾和连着的分隔线', () => {
    const list = tidyEntries(['-', act('a'), '-', '-', act('b'), '-'])
    expect(list.map((e) => (e === '-' ? '-' : e.id))).toEqual(['a', '-', 'b'])
  })
  it('只有分隔线时整理成空', () => {
    expect(tidyEntries(['-', '-'])).toEqual([])
  })
  it('变灰原因：字符串是原因，true 没有原因', () => {
    expect(disabledReason(act('a', { disabled: '没选中文字' }))).toBe('没选中文字')
    expect(disabledReason(act('a', { disabled: true }))).toBeUndefined()
    expect(disabledReason(act('a'))).toBeUndefined()
  })
})

describe('上下键移动', () => {
  // 0:a  1:-  2:b(灰)  3:c  4:d(灰)
  const list: MenuEntry[] = [act('a'), '-', act('b', { disabled: true }), act('c'), act('d', { disabled: '不行' })]
  it('跳过分隔线和变灰的项', () => {
    expect(moveIndex(list, 0, 1)).toBe(3)
    expect(moveIndex(list, 3, -1)).toBe(0)
  })
  it('到头绕回来', () => {
    expect(moveIndex(list, 3, 1)).toBe(0)
    expect(moveIndex(list, 0, -1)).toBe(3)
  })
  it('还没选时，往下是第一项，往上是最后一个能点的', () => {
    expect(moveIndex(list, -1, 1)).toBe(0)
    expect(moveIndex(list, -1, -1)).toBe(3)
  })
  it('Home / End', () => {
    expect(edgeIndex(list, 'first')).toBe(0)
    expect(edgeIndex(list, 'last')).toBe(3)
  })
  it('一个能点的都没有返回 -1', () => {
    expect(moveIndex([act('x', { disabled: true }), '-'], -1, 1)).toBe(-1)
    expect(moveIndex([], 0, 1)).toBe(-1)
  })
})

describe('菜单位置不超出窗口', () => {
  it('放得下就左上角在鼠标处', () => {
    expect(clampPosition(100, 100, 200, 150, 1000, 800)).toEqual({ left: 100, top: 100 })
  })
  it('右边放不下翻到左边，下面放不下翻到上面', () => {
    expect(clampPosition(900, 700, 200, 150, 1000, 800)).toEqual({ left: 700, top: 550 })
  })
  it('翻过去也放不下就贴边，左上角不出窗口', () => {
    expect(clampPosition(50, 50, 200, 900, 220, 800)).toEqual({ left: 4, top: 4 })
    const p = clampPosition(10, 790, 300, 1000, 1000, 800)
    expect(p.left).toBe(10)
    expect(p.top).toBe(4)
  })
  it('刚好贴着右下边也算放得下', () => {
    expect(clampPosition(796 - 200, 796 - 100, 200, 100, 800, 800)).toEqual({ left: 596, top: 696 })
  })
})

describe('按下一项', () => {
  it('变灰的项什么都不做', () => {
    expect(pressAction(act('a', { disabled: true }), undefined)).toBe('ignore')
    expect(pressAction(act('a', { disabled: '原因', confirm: '确定？' }), 'a')).toBe('ignore')
  })
  it('危险操作第一次只进确认，确认中再按才执行', () => {
    const del = act('del', { danger: true, confirm: '再点一次删除' })
    expect(pressAction(del, undefined)).toBe('confirm')
    expect(pressAction(del, 'other')).toBe('confirm')
    expect(pressAction(del, 'del')).toBe('run')
  })
  it('普通项直接执行', () => {
    expect(pressAction(act('a'), undefined)).toBe('run')
  })
})

describe('群聊右键：@、引用、往草稿里加', () => {
  it('@ 的名字去掉空格，后面带一个空格', () => {
    expect(mentionText('arena 003')).toBe('@arena003 ')
  })
  it('引用：每行前加 >，空行保留成 >，末尾空一行', () => {
    expect(quoteBlock('第一行\r\n\r\n第三行', 'maya02')).toBe('> maya02：\n> 第一行\n>\n> 第三行\n\n')
    expect(quoteBlock('  只有一行  ')).toBe('> 只有一行\n\n')
  })
  it('草稿是空的直接放进去', () => {
    expect(appendPiece('', '@a ')).toBe('@a ')
  })
  it('@ 接在末尾，中间补空格', () => {
    expect(appendPiece('你好', '@a ')).toBe('你好 @a ')
    expect(appendPiece('你好 ', '@a ')).toBe('你好 @a ')
  })
  it('引用块另起一段', () => {
    expect(appendPiece('你好  \n', '> x\n\n')).toBe('你好\n\n> x\n\n')
  })
})

describe('@ 候选：所有人', () => {
  const agents = [
    { id: 'a1', name: 'arena-001', color: '#fff' },
    { id: 'm2', name: 'maya02', color: '#fff' }
  ] as unknown as Agent[]
  const ids = (q: string) => mentionOptions(agents, q).map((o) => o.id)
  it('输入「全体」「全」「all」「ALL」「everyone」都能匹配到所有人，并排第一', () => {
    for (const q of ['全体', '全', '全体成员', 'all', 'ALL', 'al', 'everyone', '所有']) expect(ids(q)[0]).toBe('*')
  })
  it('插进去的还是「所有人」', () => {
    expect(mentionOptions(agents, '全体')[0].insert).toBe('所有人')
  })
  it('输入 AI 的名字不会带上所有人', () => {
    expect(ids('maya')).toEqual(['m2'])
    expect(ids('arena')).toEqual(['a1'])
  })
  it('输入 a：开头匹配的所有人、arena-001 排前面，名字中间带 a 的 maya02 排后面', () => {
    expect(ids('a')).toEqual(['*', 'a1', 'm2'])
  })
  it('什么都没输入时列出全部', () => {
    expect(ids('')).toEqual(['*', 'a1', 'm2'])
  })
})
