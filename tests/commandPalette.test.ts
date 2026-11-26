import { describe, expect, it } from 'vitest'
import { filterPalette, paletteScore, type PaletteItem } from '../src/renderer/src/components/CommandPalette'

const item = (id: string, title: string, keywords?: string): PaletteItem => ({ id, group: 'g', title, keywords, run: () => {} })

describe('命令面板匹配', () => {
  it('子串优先，开头命中分更高；子序列也能命中；不匹配返回 -1', () => {
    expect(paletteScore('审计', '打开：审计日志')).toBeGreaterThan(paletteScore('审日', '打开：审计日志'))
    expect(paletteScore('打开', '打开：审计日志')).toBeGreaterThan(paletteScore('审计', '打开：审计日志'))
    expect(paletteScore('sjrz', '打开：审计日志')).toBe(-1)
    expect(paletteScore('tun', 'start tunnel')).toBeGreaterThan(0)
    expect(paletteScore('', 'x')).toBe(0)
  })
  it('按分数排序，关键词也参与匹配，空查询原样返回', () => {
    const items = [item('a', '打开：概览', 'overview'), item('b', '打开：审计日志', 'audit'), item('c', '启动公网隧道', 'tunnel cloudflared')]
    expect(filterPalette(items, '').map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(filterPalette(items, 'audit').map((i) => i.id)).toEqual(['b'])
    expect(filterPalette(items, 'cloud').map((i) => i.id)).toEqual(['c'])
    expect(filterPalette(items, '打开').map((i) => i.id)).toEqual(['a', 'b'])
  })
})
