import { describe, expect, it, vi } from 'vitest'
import { blankMenu, cardMenu, frameMenu, hitOf, lineMenu, noteMenu, widgetMenu, type HitTarget } from '../src/renderer/src/lib/canvasMenu'
import { isAction, type MenuAction, type MenuEntry } from '../src/renderer/src/lib/contextMenu'

const ids = (m: MenuEntry[]): string[] => m.map((e) => (isAction(e) ? e.id : '-'))
const item = (m: MenuEntry[], id: string): MenuAction => {
  const hit = m.find((e) => isAction(e) && e.id === id)
  if (!hit || !isAction(hit)) throw new Error(`菜单里没有 ${id}：${ids(m).join(',')}`)
  return hit
}
const noop = (): void => {}
const cardActs = { panel: noop, chat: noop, assign: noop, note: noop, settings: noop, stop: noop, archive: noop }
const blankActs = { note: noop, widget: noop, newAgent: noop, fit: noop, arrange: noop, undo: noop }
const frameActs = { select: noop, tidy: noop, team: noop, chat: noop, show: noop }

/** 假元素：attrs 是它自己和它外面一层层元素上有的属性（选择器 → dataset） */
const el = (attrs: Record<string, Record<string, string>>): HitTarget => ({
  closest: (selector) => {
    for (const part of selector.split(',').map((s) => s.trim())) if (attrs[part]) return { dataset: attrs[part] }
    return null
  }
})

describe('画布右键菜单', () => {
  it('AI 卡片：七项都在；叫停是红的、要再点一次；没连着时叫停灰掉并说明原因；没有项目时派活灰掉', () => {
    const m = cardMenu({ name: 'Alice', canAssign: true, online: true }, cardActs)
    expect(ids(m)).toEqual(['panel', 'chat', 'assign', 'note', '-', 'settings', 'archive', '-', 'stop'])
    const stop = item(m, 'stop')
    expect(stop.danger).toBe(true)
    expect(stop.confirm).toContain('Alice')
    expect(stop.disabled).toBe(false)
    expect(item(m, 'assign').disabled).toBe(false)

    const off = cardMenu({ name: 'Bob', canAssign: false, online: false }, cardActs)
    expect(item(off, 'stop').disabled).toBe('它现在没连着，没有可以停的')
    expect(item(off, 'assign').disabled).toBe('先在首页添加一个项目，才能派活')
  })

  it('AI 卡片：每一项调的是传进来的那个动作', () => {
    const acts = { panel: vi.fn(), chat: vi.fn(), assign: vi.fn(), note: vi.fn(), settings: vi.fn(), stop: vi.fn(), archive: vi.fn() }
    const m = cardMenu({ name: 'Alice', canAssign: true, online: true }, acts)
    for (const id of Object.keys(acts)) void item(m, id).run()
    for (const f of Object.values(acts)) expect(f).toHaveBeenCalledTimes(1)
  })

  it('空白处：贴便签、开小窗、新建 AI、全部放进屏幕、一键整理；整理过才有撤销', () => {
    expect(ids(blankMenu({ canUndo: false }, blankActs))).toEqual(['note', 'widget', 'new-agent', '-', 'fit', 'arrange'])
    expect(ids(blankMenu({ canUndo: true }, blankActs))).toEqual(['note', 'widget', 'new-agent', '-', 'fit', 'arrange', 'undo'])
  })

  it('框里的空白处：前面是空白处那几项，后面接这个框的几项', () => {
    const m = blankMenu({ canUndo: false, frame: { title: 'alpha-proj', cards: 2, hasTeam: true, hasChat: true } }, blankActs, frameActs)
    expect(ids(m)).toEqual(['note', 'widget', 'new-agent', '-', 'fit', 'arrange', '-', 'frame-show', 'frame-select', 'frame-tidy', 'frame-team', 'frame-chat'])
  })

  it('框：「没在项目里」那个框没有分工和群聊；空框选不了、排不了，并说明原因；名字太长会截短', () => {
    const lobby = frameMenu({ title: '没在项目里', cards: 0, hasTeam: false, hasChat: false }, frameActs)
    expect(ids(lobby)).toEqual(['frame-show', 'frame-select', 'frame-tidy'])
    expect(item(lobby, 'frame-select').disabled).toBe('这个框里没有 AI')
    expect(item(lobby, 'frame-tidy').disabled).toBe('不到两张卡片，不用排')
    const one = frameMenu({ title: '一个名字特别特别特别长的项目', cards: 1, hasTeam: true, hasChat: true }, frameActs)
    expect(item(one, 'frame-select').disabled).toBe(false)
    expect(item(one, 'frame-tidy').disabled).toBe('不到两张卡片，不用排')
    expect(item(one, 'frame-show').label).toBe('把「一个名字特别特别特别…」放进屏幕')
  })

  it('便签：改字、删掉（要再点一次）', () => {
    const m = noteMenu({ edit: noop, remove: noop })
    expect(ids(m)).toEqual(['note-edit', '-', 'note-remove'])
    expect(item(m, 'note-remove').confirm).toBeTruthy()
  })

  it('小窗：只有文件小窗有「在编辑器里打开」；终端写的是从画布上拿掉、不关终端', () => {
    const acts = { show: noop, openFile: noop, remove: noop }
    expect(ids(widgetMenu({ kind: 'file' }, acts))).toEqual(['widget-show', 'widget-open', '-', 'widget-remove'])
    expect(ids(widgetMenu({ kind: 'web' }, acts))).toEqual(['widget-show', '-', 'widget-remove'])
    const term = widgetMenu({ kind: 'terminal' }, acts)
    expect(item(term, 'widget-remove').label).toBe('从画布上拿掉（终端不关）')
    expect(item(term, 'widget-remove').confirm).toBeTruthy()
  })

  it('线：派活的线只能看；接力线能删（要再点一次），删不了的不给这一项', () => {
    const acts = { open: noop, remove: noop }
    expect(ids(lineMenu({ kind: 'task', canRemove: false }, acts))).toEqual(['line-open'])
    expect(ids(lineMenu({ kind: 'relay', canRemove: true }, acts))).toEqual(['line-open', '-', 'line-remove'])
    expect(ids(lineMenu({ kind: 'relay', canRemove: false }, acts))).toEqual(['line-open'])
  })

  it('点到了什么：面板和按钮条、正在打字的地方、小窗的内容区不归画布管', () => {
    expect(hitOf(null)).toEqual({ kind: 'none' })
    expect(hitOf(el({ '[data-cv-ui]': {}, '[data-cv-card]': { cvCard: 'a-1@w1' } }))).toEqual({ kind: 'none' })
    // 小窗的内容区（data-cv-nodrag）：终端、网页、文件各有各的右键
    expect(hitOf(el({ '[data-cv-nodrag]': {}, '[data-cv-widget]': { cvNote: 'wd_1' }, '[data-cv-note]': { cvNote: 'wd_1' } }))).toEqual({ kind: 'none' })
    expect(hitOf(el({ textarea: {}, '[data-cv-note]': { cvNote: 'n1' } }))).toEqual({ kind: 'none' })
  })

  it('点到了什么：小窗的标题栏算小窗（它身上也有便签的标记）；便签、卡片、任务条、框的标题、框里的空白、外面的空白', () => {
    expect(hitOf(el({ '[data-cv-widget]': { cvNote: 'wd_1' }, '[data-cv-note]': { cvNote: 'wd_1' } }))).toEqual({ kind: 'widget', id: 'wd_1' })
    expect(hitOf(el({ '[data-cv-note]': { cvNote: 'n1' } }))).toEqual({ kind: 'note', id: 'n1' })
    expect(hitOf(el({ '[data-cv-card]': { cvCard: 'a-1@w1' }, '[data-cv-frame]': { cvFrame: 'w1' } }))).toEqual({ kind: 'card', key: 'a-1@w1' })
    expect(hitOf(el({ '[data-cv-task]': { cvTask: 'w1|T-3' }, '[data-cv-frame]': { cvFrame: 'w1' } }))).toEqual({ kind: 'task', task: 'w1|T-3' })
    expect(hitOf(el({ '[data-cv-frame-head]': { cvFrameHead: 'w1' }, '[data-cv-frame]': { cvFrame: 'w1' } }))).toEqual({ kind: 'frame', id: 'w1' })
    expect(hitOf(el({ '[data-cv-frame]': { cvFrame: 'w1' } }))).toEqual({ kind: 'blank', frame: 'w1' })
    expect(hitOf(el({}))).toEqual({ kind: 'blank' })
    // 线上的标签是个按钮，也要弹菜单
    expect(hitOf(el({ '[data-cv-line-label]': { cvLineLabel: 'relay:r1' } }))).toEqual({ kind: 'line', id: 'relay:r1' })
  })
})
