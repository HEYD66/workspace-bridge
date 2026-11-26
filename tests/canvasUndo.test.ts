// T-17：画布「撤销上一步」的后台。只撤用户自己的改动；之后被 AI 改过的不硬撤；1 秒内连着的改动算一步
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CANVAS_ALL, applyCanvasOps, emptyCanvasDoc, type CanvasOp } from '../src/shared/canvasDoc'
import { CanvasUndoHistory, describeStep, diffCanvasDocs } from '../src/shared/canvasUndo'
import { CanvasStore } from '../src/core/canvasStore'

const me = { id: 'user', name: '你' }
const ai = { id: 'a1', name: 'AI 一号' }
const W = 'w1'

describe('CanvasStore 的撤销', () => {
  let dir: string
  let store: CanvasStore
  let seen: string[]
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-undo-'))
    seen = []
    store = new CanvasStore(path.join(dir, 'canvas.json'), (id) => seen.push(id))
  })
  afterEach(() => {
    store.flush()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  /** 先摆好：两张便签（项目那份）、两张卡片的位置（总画布那份）。用另一个 store 摆好、存盘，再重新打开：撤销记录是空的 */
  const setup = (): void => {
    const file = path.join(dir, 'canvas.json')
    const first = new CanvasStore(file)
    first.update(W, [{ op: 'addNote', id: 'n_a', text: '买菜' }, { op: 'addNote', id: 'n_b', text: '写周报' }], me, 0)
    first.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a1', x: 0, y: 0 }, { id: 'a2', x: 100, y: 0 }, { id: 'n_a', x: 10, y: 10 }] }], me, 0)
    first.flush()
    store = new CanvasStore(file, (id) => seen.push(id))
    seen = []
    expect(store.undoState().canUndo).toBe(false)
  }

  it('一开始没有能撤的；撤了返回 empty', () => {
    expect(store.undoState()).toEqual({ canUndo: false, count: 0 })
    expect(store.undo()).toMatchObject({ status: 'empty', message: '没有能撤销的了', skipped: [] })
  })

  it('删便签 + 忘掉它的位置（两份画布、两次调用）算一步；撤销后便签回到原来的位置和叠放顺序', () => {
    setup()
    store.update(W, [{ op: 'removeNote', id: 'n_a' }], me, 10_000)
    store.update(CANVAS_ALL, [{ op: 'forget', ids: ['n_a'] }], me, 10_300)
    expect(store.undoState()).toEqual({ canUndo: true, label: '删掉便签「买菜」', count: 1 })
    const r = store.undo()
    expect(r).toMatchObject({ status: 'done', label: '删掉便签「买菜」', message: '撤销了：删掉便签「买菜」', skipped: [] })
    expect(r.state).toEqual({ canUndo: false, count: 0 })
    expect(store.get(W).notes.map((n) => n.id)).toEqual(['n_a', 'n_b'])
    expect(store.get(W).notes[0]).toMatchObject({ text: '买菜', by: 'user' })
    expect(store.get(CANVAS_ALL).nodes.n_a).toEqual({ x: 10, y: 10 })
    // 两份画布都变了，都通知
    expect(seen.slice(-2).sort()).toEqual([CANVAS_ALL, W].sort())
  })

  it('拖一张卡片分好几次发位置：算一步，撤回拖之前；隔了 1 秒以上的是两步', () => {
    setup()
    for (let i = 1; i <= 5; i++) store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a1', x: i * 10, y: i }] }], me, 20_000 + i * 250)
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a2', x: 500, y: 500 }] }], me, 30_000)
    expect(store.undoState()).toMatchObject({ count: 2, label: '挪动 1 张卡片' })
    store.undo()
    expect(store.get(CANVAS_ALL).nodes.a2).toEqual({ x: 100, y: 0 })
    expect(store.get(CANVAS_ALL).nodes.a1).toEqual({ x: 50, y: 5 })
    store.undo()
    expect(store.get(CANVAS_ALL).nodes.a1).toEqual({ x: 0, y: 0 })
    expect(store.undoState().canUndo).toBe(false)
  })

  it('一键整理：先忘掉所有位置、再分几批发新位置，也只算一步，撤销后全回原处', () => {
    setup()
    store.update(CANVAS_ALL, [{ op: 'forget', ids: ['a1', 'a2', 'n_a'] }], me, 40_000)
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a1', x: 1, y: 1 }] }], me, 40_250)
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a2', x: 2, y: 2 }, { id: 'n_a', x: 3, y: 3 }] }], me, 40_300)
    expect(store.undoState()).toMatchObject({ count: 1, label: '挪动 3 张卡片' })
    expect(store.undo().status).toBe('done')
    expect(store.get(CANVAS_ALL).nodes).toEqual({ a1: { x: 0, y: 0 }, a2: { x: 100, y: 0 }, n_a: { x: 10, y: 10 } })
  })

  it('AI 的改动、视角、「看过了」、终端重新连上都不记', () => {
    setup()
    store.update(W, [{ op: 'addNote', text: 'AI 贴的' }], ai, 50_000)
    store.update(CANVAS_ALL, [{ op: 'viewport', x: 1, y: 2, zoom: 1.5 }], me, 52_000)
    store.update(W, [{ op: 'ackTasks', refs: ['T-1'] }, { op: 'ackAllTasks' }], me, 54_000)
    store.update(CANVAS_ALL, [{ op: 'addWidget', id: 'wd_t', kind: 'terminal', workspaceId: W }], ai, 56_000)
    store.update(CANVAS_ALL, [{ op: 'editWidget', id: 'wd_t', termId: 'term-2' }], me, 58_000)
    expect(store.undoState()).toEqual({ canUndo: false, count: 0 })
  })

  it('撤之前 AI 又改了那张便签：不硬撤，这一步扔掉，再撤就是更早的那一步', () => {
    setup()
    store.update(W, [{ op: 'editNote', id: 'n_b', text: '写月报' }], me, 60_000)
    store.update(W, [{ op: 'editNote', id: 'n_a', text: '买菜和水果' }], me, 70_000)
    store.update(W, [{ op: 'editNote', id: 'n_a', text: 'AI 改成这样' }], ai, 70_500)
    const r = store.undo()
    expect(r.status).toBe('conflict')
    expect(r.skipped).toEqual(['便签「买菜和水果」（之后又被改过）'])
    expect(r.message).toContain('没法撤销「改便签「买菜」」')
    expect(store.get(W).notes.find((n) => n.id === 'n_a')?.text).toBe('AI 改成这样')
    expect(store.undoState()).toMatchObject({ count: 1, label: '改便签「写周报」' })
    expect(store.undo().status).toBe('done')
    expect(store.get(W).notes.find((n) => n.id === 'n_b')?.text).toBe('写周报')
  })

  it('一步里有的被 AI 改过、有的没有：能撤的撤，没撤的列出来', () => {
    setup()
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a1', x: 7, y: 7 }, { id: 'a2', x: 8, y: 8 }] }], me, 80_000)
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a2', x: 9, y: 9 }] }], ai, 80_100)
    const r = store.undo()
    expect(r.status).toBe('partial')
    expect(r.skipped).toEqual(['卡片位置（之后又被改过）'])
    expect(r.message).toBe('撤销了一部分：挪动 2 张卡片。没撤的：卡片位置（之后又被改过）')
    expect(store.get(CANVAS_ALL).nodes.a1).toEqual({ x: 0, y: 0 })
    expect(store.get(CANVAS_ALL).nodes.a2).toEqual({ x: 9, y: 9 })
  })

  it('贴便签再给它摆位置：一步；撤销把便签和位置都拿掉。很久以后自动给新卡片排的位置不单算一步', () => {
    setup()
    store.update(W, [{ op: 'addNote', id: 'n_new', text: '新便签' }], me, 90_000)
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'n_new', x: 40, y: 40 }] }], me, 90_200)
    expect(store.undoState()).toMatchObject({ count: 1, label: '贴便签「新便签」' })
    // 新来了一个 AI，界面自动给它排了位置
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'a9', x: 300, y: 0 }] }], me, 99_000)
    expect(store.undoState()).toMatchObject({ count: 1, label: '贴便签「新便签」' })
    store.undo()
    expect(store.get(W).notes.some((n) => n.id === 'n_new')).toBe(false)
    expect(store.get(CANVAS_ALL).nodes.n_new).toBeUndefined()
    expect(store.get(CANVAS_ALL).nodes.a9).toEqual({ x: 300, y: 0 })
  })

  it('关小窗、删接力线、收纳卡片都能撤回来；接力线 id 不变；终端小窗撤回来时带着原来的 termId', () => {
    setup()
    store.update(CANVAS_ALL, [{ op: 'addWidget', id: 'wd_f', kind: 'file', workspaceId: W, path: 'docs/README.md', x: 5, y: 5 }], me, 100_000)
    store.update(W, [{ op: 'addRelay', from: 'a1', to: 'a2' }], me, 110_000)
    const relayId = store.get(W).relays[0].id
    store.update(CANVAS_ALL, [{ op: 'removeWidget', id: 'wd_f' }], me, 120_000)
    expect(store.undoState().label).toBe('关掉小窗「README.md」')
    store.update(W, [{ op: 'removeRelay', id: relayId }], me, 130_000)
    expect(store.undoState().label).toBe('删掉接力线')
    store.update(W, [{ op: 'archive', ids: ['a1', 'a2'] }], me, 140_000)
    expect(store.undoState()).toMatchObject({ label: '收纳 2 张卡片', count: 5 })

    store.undo()
    expect(store.get(W).archived).toEqual([])
    store.undo()
    expect(store.get(W).relays).toEqual([expect.objectContaining({ id: relayId, from: 'a1', to: 'a2' })])
    store.undo()
    expect(store.get(CANVAS_ALL).widgets).toEqual([expect.objectContaining({ id: 'wd_f', path: 'docs/README.md' })])
    expect(store.get(CANVAS_ALL).nodes.wd_f).toEqual({ x: 5, y: 5 })
    expect(store.undoState().label).toBe('连接力线')
  })

  it('撤回删掉的接力线时已经有一条一样的线：不重复加，告诉用户', () => {
    setup()
    store.update(W, [{ op: 'addRelay', from: 'a1', to: 'a2' }], me, 0)
    store.undo()
    store.update(W, [{ op: 'addRelay', from: 'a1', to: 'a2' }], me, 150_000)
    store.update(W, [{ op: 'removeRelay', id: store.get(W).relays[0].id }], me, 160_000)
    store.update(W, [{ op: 'addRelay', from: 'a1', to: 'a2' }], ai, 160_500)
    const r = store.undo()
    expect(r.status).toBe('conflict')
    expect(r.skipped).toEqual(['接力线（已经有一条一样的线）'])
    expect(store.get(W).relays).toHaveLength(1)
  })

  it('撤销自己不算一步；最多记 30 步，多了丢最早的；项目删掉后它的步也不要了', () => {
    for (let i = 0; i < 35; i++) store.update(W, [{ op: 'addNote', id: `n_${i}`, text: `第 ${i} 张` }], me, i * 2000)
    expect(store.undoState()).toMatchObject({ count: 30, label: '贴便签「第 34 张」' })
    store.undo()
    expect(store.undoState()).toMatchObject({ count: 29, label: '贴便签「第 33 张」' })
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'x', x: 1, y: 1 }, { id: 'y', x: 1, y: 1 }] }], me, 190_000)
    store.update(CANVAS_ALL, [{ op: 'move', nodes: [{ id: 'x', x: 2, y: 2 }] }], me, 200_000)
    store.forget(W)
    expect(store.undoState()).toMatchObject({ count: 1, label: '挪动 1 张卡片' })
  })

  it('撤销后照常写盘：重新打开文件看到的是撤回后的样子；撤销记录本身不存盘', () => {
    setup()
    store.update(W, [{ op: 'removeNote', id: 'n_b' }], me, 170_000)
    store.undo()
    store.flush()
    const again = new CanvasStore(path.join(dir, 'canvas.json'))
    expect(again.get(W).notes.map((n) => n.id)).toEqual(['n_a', 'n_b'])
    expect(again.undoState().canUndo).toBe(false)
  })
})

describe('canvasUndo 纯计算', () => {
  const apply = (ops: CanvasOp[], actor = me) => applyCanvasOps(emptyCanvasDoc(), ops, actor, 1)

  it('diffCanvasDocs 只比用户摆的东西，视角和「看过了」不算', () => {
    const a = apply([{ op: 'addNote', id: 'n_1', text: 'x' }])
    const b = applyCanvasOps(a, [{ op: 'viewport', x: 1, y: 1, zoom: 2 }, { op: 'ackAllTasks' }], me, 2)
    expect(diffCanvasDocs(a, b)).toEqual([])
    const c = applyCanvasOps(a, [{ op: 'removeNote', id: 'n_1' }, { op: 'archive', ids: ['k'] }], me, 3)
    expect(diffCanvasDocs(a, c).map((d) => `${d.kind}:${d.id}:${d.before ? 'b' : ''}${d.after ? 'a' : ''}`).sort()).toEqual(['archived:k:a', 'note:n_1:b'])
  })

  it('同一样东西一步里改回原样：这一步就没了', () => {
    const h = new CanvasUndoHistory()
    const a = apply([{ op: 'move', nodes: [{ id: 'k', x: 0, y: 0 }] }])
    const b = applyCanvasOps(a, [{ op: 'move', nodes: [{ id: 'k', x: 5, y: 5 }] }], me, 2)
    h.record(W, a, b, 1000)
    h.record(W, b, a, 1500)
    expect(h.state()).toEqual({ canUndo: false, count: 0 })
  })

  it('一步里好几类改动：说前两类，后面用「等」', () => {
    const h = new CanvasUndoHistory()
    const a = apply([{ op: 'addNote', id: 'n_1', text: '一' }, { op: 'addNote', id: 'n_2', text: '二' }, { op: 'addRelay', from: 'p', to: 'q' }])
    const b = applyCanvasOps(a, [{ op: 'removeNote', id: 'n_1' }, { op: 'removeNote', id: 'n_2' }, { op: 'removeRelay', id: a.relays[0].id }, { op: 'archive', ids: ['p'] }], me, 2)
    h.record(W, a, b, 1000)
    const step = h.pop()
    expect(step && describeStep(step)).toBe('删掉 2 张便签，删掉接力线等')
  })
})
