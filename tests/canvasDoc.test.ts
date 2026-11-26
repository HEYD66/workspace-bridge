// 画布上用户摆的东西：改动怎么应用（纯计算）、怎么存盘
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCanvasOps, CANVAS_LIMITS, CanvasOpError, emptyCanvasDoc, sanitizeCanvasDoc, type CanvasDoc, type CanvasOp } from '../src/shared/canvasDoc'
import { CanvasStore } from '../src/core/canvasStore'

const me = { id: 'user', name: '你' }
const run = (doc: CanvasDoc, ...ops: CanvasOp[]): CanvasDoc => applyCanvasOps(doc, ops, me, 1000)

describe('applyCanvasOps', () => {
  it('摆卡片：给了的项覆盖、没给的保留，null 去掉；不动原来那份', () => {
    const a = run(emptyCanvasDoc(), { op: 'move', nodes: [{ id: 'x', x: 1, y: 2, w: 300, h: 200, pinned: true }] })
    expect(a.nodes.x).toEqual({ x: 1, y: 2, w: 300, h: 200, pinned: true })
    expect(a.version).toBe(1)
    const b = run(a, { op: 'move', nodes: [{ id: 'x', x: 5, y: 6, h: null, pinned: null }] })
    expect(b.nodes.x).toEqual({ x: 5, y: 6, w: 300 })
    expect(a.nodes.x.x).toBe(1)
    expect(b.version).toBe(2)
  })

  it('没有实际变化：原样返回，版本不加', () => {
    const a = run(emptyCanvasDoc(), { op: 'move', nodes: [{ id: 'x', x: 1, y: 2 }] })
    expect(run(a, { op: 'move', nodes: [{ id: 'x', x: 1, y: 2 }] })).toBe(a)
    expect(run(a, { op: 'forget', ids: ['nope'] })).toBe(a)
    expect(run(a, { op: 'unarchive', ids: ['nope'] })).toBe(a)
  })

  it('便签：贴（带位置）、改、删；删的时候位置和收纳一起清掉', () => {
    let d = run(emptyCanvasDoc(), { op: 'addNote', id: 'n_1', text: '先别动这块', color: 'yellow', x: 10, y: 20 })
    expect(d.notes).toEqual([{ id: 'n_1', text: '先别动这块', color: 'yellow', by: 'user', byName: '你', createdAt: 1000, updatedAt: 1000 }])
    expect(d.nodes.n_1).toEqual({ x: 10, y: 20 })
    d = applyCanvasOps(d, [{ op: 'editNote', id: 'n_1', text: '可以动了', color: null }], { id: 'a1', name: 'Alice' }, 2000)
    expect(d.notes[0]).toMatchObject({ text: '可以动了', by: 'user', updatedAt: 2000 })
    expect(d.notes[0].color).toBeUndefined()
    d = run(d, { op: 'archive', ids: ['n_1'] }, { op: 'removeNote', id: 'n_1' })
    expect(d.notes).toEqual([])
    expect(d.nodes).toEqual({})
    expect(d.archived).toEqual([])
  })

  it('不给 id 的便签自动起 n_ 开头的 id，不重复', () => {
    const d = run(emptyCanvasDoc(), { op: 'addNote', text: 'a' }, { op: 'addNote', text: 'b' })
    expect(d.notes).toHaveLength(2)
    expect(d.notes[0].id).toMatch(/^n_/)
    expect(d.notes[0].id).not.toBe(d.notes[1].id)
  })

  it('收纳和放回：不重复记', () => {
    let d = run(emptyCanvasDoc(), { op: 'archive', ids: ['a', 'b'] }, { op: 'archive', ids: ['a'] })
    expect(d.archived).toEqual(['a', 'b'])
    d = run(d, { op: 'unarchive', ids: ['a'] })
    expect(d.archived).toEqual(['b'])
  })

  it('镜头：缩放夹在范围里', () => {
    expect(run(emptyCanvasDoc(), { op: 'viewport', x: 1, y: 2, zoom: 99 }).viewport).toEqual({ x: 1, y: 2, zoom: 4 })
    expect(run(emptyCanvasDoc(), { op: 'viewport', x: 1, y: 2, zoom: 0.001 }).viewport).toEqual({ x: 1, y: 2, zoom: 0.1 })
  })

  it('模板：存、改、删；主脑不算进成员，成员去重', () => {
    let d = run(emptyCanvasDoc(), { op: 'saveTemplate', name: ' 前后端 ', leadId: 'a', memberIds: ['a', 'b', 'b', 'c'] })
    expect(d.templates).toHaveLength(1)
    const id = d.templates[0].id
    expect(d.templates[0]).toEqual({ id, name: '前后端', leadId: 'a', memberIds: ['b', 'c'], createdAt: 1000 })
    d = applyCanvasOps(d, [{ op: 'saveTemplate', id, name: '改名', memberIds: ['b'] }], me, 5000)
    expect(d.templates[0]).toEqual({ id, name: '改名', memberIds: ['b'], createdAt: 1000 })
    expect(run(d, { op: 'removeTemplate', id }).templates).toEqual([])
  })

  it('接力线：加、重复的不再加、删；不能连自己', () => {
    let d = run(emptyCanvasDoc(), { op: 'addRelay', from: 'a', to: 'b' })
    expect(d.relays).toHaveLength(1)
    expect(d.relays[0]).toMatchObject({ from: 'a', to: 'b', createdAt: 1000 })
    expect(d.relays[0].id).toMatch(/^r_/)
    expect(run(d, { op: 'addRelay', from: 'a', to: 'b' })).toBe(d)
    d = run(d, { op: 'addRelay', from: 'b', to: 'a' })
    expect(d.relays).toHaveLength(2)
    expect(run(d, { op: 'removeRelay', id: d.relays[0].id }).relays.map((r) => r.from)).toEqual(['b'])
    expect(() => run(d, { op: 'addRelay', from: 'a', to: 'a' })).toThrow(CanvasOpError)
    expect(() => run(d, { op: 'removeRelay', id: 'r_none' })).toThrow(CanvasOpError)
  })

  it('看过的交付：记下看的时间；全部看过会清掉单条的记录；便签可以记贴在谁旁边', () => {
    let d = run(emptyCanvasDoc(), { op: 'ackTasks', refs: ['T-1', 'T-2'] })
    expect(d.acks).toEqual({ 'T-1': 1000, 'T-2': 1000 })
    d = applyCanvasOps(d, [{ op: 'ackAllTasks' }], me, 3000)
    expect(d.acks).toEqual({})
    expect(d.ackAll).toBe(3000)
    const many = applyCanvasOps(emptyCanvasDoc(), [{ op: 'ackTasks', refs: Array.from({ length: CANVAS_LIMITS.acks }, (_, i) => `T-${i}`) }], me, 1)
    const more = applyCanvasOps(many, [{ op: 'ackTasks', refs: ['T-new'] }], me, 2)
    expect(Object.keys(more.acks)).toHaveLength(CANVAS_LIMITS.acks)
    expect(more.acks['T-new']).toBe(2)
    expect(run(emptyCanvasDoc(), { op: 'addNote', id: 'n_1', text: 't', near: 'a1' }).notes[0].near).toBe('a1')
  })

  it('有一条不合规：整串都不做，原来那份不变', () => {
    const a = run(emptyCanvasDoc(), { op: 'move', nodes: [{ id: 'x', x: 1, y: 2 }] })
    const bad: CanvasOp[][] = [
      [{ op: 'move', nodes: [{ id: 'y', x: 3, y: 4 }] }, { op: 'removeNote', id: 'n_none' }],
      [{ op: 'move', nodes: [{ id: 'y', x: Number.NaN, y: 4 }] }],
      [{ op: 'move', nodes: [{ id: 'y', x: 1, y: 4, w: -5 }] }],
      [{ op: 'addNote', text: '   ' }],
      [{ op: 'addNote', text: 'x'.repeat(CANVAS_LIMITS.noteText + 1) }],
      [{ op: 'addNote', id: 'bad', text: 'x' }],
      [{ op: 'editNote', id: 'n_none', text: 'x' }],
      [{ op: 'viewport', x: 0, y: 0, zoom: 0 }],
      [{ op: 'saveTemplate', name: '', memberIds: [] }],
      [{ op: 'removeTemplate', id: 'tp_none' }],
      [{ op: 'nope' } as unknown as CanvasOp]
    ]
    for (const ops of bad) expect(() => applyCanvasOps(a, ops, me, 1)).toThrow(CanvasOpError)
    expect(a.nodes).toEqual({ x: { x: 1, y: 2 } })
  })

  it('上限：便签数、同名便签 id', () => {
    let d = emptyCanvasDoc()
    d = applyCanvasOps(d, Array.from({ length: CANVAS_LIMITS.notes }, (_, i) => ({ op: 'addNote' as const, id: `n_${i}`, text: 't' })), me, 1)
    expect(() => run(d, { op: 'addNote', text: '多一张' })).toThrow(/最多/)
    expect(() => run(run(emptyCanvasDoc(), { op: 'addNote', id: 'n_a', text: 't' }), { op: 'addNote', id: 'n_a', text: 't' })).toThrow(/已经有了/)
  })
})

describe('sanitizeCanvasDoc', () => {
  it('坏的整份给空的；坏的项丢掉，好的留下', () => {
    expect(sanitizeCanvasDoc(null)).toEqual(emptyCanvasDoc())
    expect(sanitizeCanvasDoc('x')).toEqual(emptyCanvasDoc())
    const d = sanitizeCanvasDoc({
      version: 7,
      nodes: { ok: { x: 1, y: 2, w: 3, pinned: true }, bad: { x: 'a', y: 2 }, bad2: null },
      notes: [{ id: 'n_1', text: 't', by: 'user', byName: '你', createdAt: 5, updatedAt: 6 }, { id: 'n_2' }, null, { id: 'n_1', text: '重复', by: 'user' }],
      archived: ['a', 'a', 5],
      templates: [{ id: 'tp_1', name: 'n', memberIds: ['a', 7], createdAt: 1 }, { id: 'tp_2' }],
      relays: [{ id: 'r_1', from: 'a', to: 'b' }, { id: 'r_2', from: 'a', to: 'a' }, { id: 'r_1', from: 'c', to: 'd' }, null],
      acks: { 'T-1': 5, 'T-2': 'x' },
      ackAll: 3,
      viewport: { x: 1, y: 2, zoom: 0 }
    })
    expect(d).toEqual({
      version: 7,
      nodes: { ok: { x: 1, y: 2, w: 3, pinned: true } },
      notes: [{ id: 'n_1', text: 't', by: 'user', byName: '你', createdAt: 5, updatedAt: 6 }],
      archived: ['a'],
      templates: [{ id: 'tp_1', name: 'n', memberIds: ['a'], createdAt: 1 }],
      relays: [{ id: 'r_1', from: 'a', to: 'b', createdAt: 0 }],
      widgets: [],
      acks: { 'T-1': 5 },
      ackAll: 3
    })
  })
})

describe('CanvasStore', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-canvas-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('每个项目一份；存盘后重新打开还在；有变化才通知', () => {
    const file = path.join(dir, 'sub', 'canvas.json')
    const seen: string[] = []
    const store = new CanvasStore(file, (id) => seen.push(id))
    expect(store.get('w1')).toEqual(emptyCanvasDoc())
    store.update('w1', [{ op: 'move', nodes: [{ id: 'a', x: 1, y: 2 }] }], me)
    store.update('w1', [{ op: 'move', nodes: [{ id: 'a', x: 1, y: 2 }] }], me)
    store.update('w2', [{ op: 'addNote', id: 'n_1', text: '便签' }], me, 9)
    expect(seen).toEqual(['w1', 'w2'])
    expect(store.get('w1').version).toBe(1)
    store.flush()
    const again = new CanvasStore(file)
    expect(again.get('w1').nodes).toEqual({ a: { x: 1, y: 2 } })
    expect(again.get('w2').notes[0]).toMatchObject({ id: 'n_1', text: '便签', createdAt: 9 })
    expect(again.workspaceIds().sort()).toEqual(['w1', 'w2'])
  })

  it('不合规的改动抛错，什么都不变、不通知', () => {
    const seen: string[] = []
    const store = new CanvasStore(path.join(dir, 'canvas.json'), (id) => seen.push(id))
    expect(() => store.update('w1', [{ op: 'removeNote', id: 'n_none' }], me)).toThrow(CanvasOpError)
    expect(seen).toEqual([])
    expect(store.get('w1')).toEqual(emptyCanvasDoc())
  })

  it('项目删掉后它的画布也没了；文件坏了从空的开始', () => {
    const file = path.join(dir, 'canvas.json')
    const store = new CanvasStore(file)
    store.update('w1', [{ op: 'archive', ids: ['a'] }], me)
    store.forget('w1')
    store.flush()
    expect(new CanvasStore(file).workspaceIds()).toEqual([])
    fs.writeFileSync(file, '{坏的')
    expect(new CanvasStore(file).get('w1')).toEqual(emptyCanvasDoc())
  })

  it('工具卡片：放、改、拿掉；位置跟着记和忘', () => {
    const who = { id: 'user', name: '你' }
    let doc = applyCanvasOps(emptyCanvasDoc(), [{ op: 'addWidget', id: 'wd_a', kind: 'file', workspaceId: 'w1', path: 'src/a.ts', x: 10, y: 20, w: 500, h: 300 }], who, 1000)
    expect(doc.widgets).toEqual([{ id: 'wd_a', kind: 'file', workspaceId: 'w1', path: 'src/a.ts', createdAt: 1000 }])
    expect(doc.nodes.wd_a).toEqual({ x: 10, y: 20, w: 500, h: 300 })
    doc = applyCanvasOps(doc, [{ op: 'addWidget', kind: 'terminal', workspaceId: 'w1' }, { op: 'addWidget', kind: 'web', workspaceId: 'w1', url: 'https://example.com', title: '文档' }], who, 2000)
    expect(doc.widgets.map((w) => w.kind)).toEqual(['file', 'terminal', 'web'])
    const term = doc.widgets[1]
    expect(term.id).toMatch(/^wd_/)
    doc = applyCanvasOps(doc, [{ op: 'editWidget', id: term.id, termId: 'term-7', title: '跑测试' }], who, 3000)
    expect(doc.widgets[1]).toMatchObject({ termId: 'term-7', title: '跑测试' })
    doc = applyCanvasOps(doc, [{ op: 'editWidget', id: term.id, termId: null }], who, 3000)
    expect(doc.widgets[1].termId).toBeUndefined()
    // 文件没路径、网页没网址、种类不对、id 重复：都不行，而且整串不生效
    expect(() => applyCanvasOps(doc, [{ op: 'addWidget', kind: 'file', workspaceId: 'w1' }], who, 1)).toThrow(/path/)
    expect(() => applyCanvasOps(doc, [{ op: 'addWidget', kind: 'web', workspaceId: 'w1' }], who, 1)).toThrow(/url/)
    expect(() => applyCanvasOps(doc, [{ op: 'addWidget', kind: 'video' as 'web', workspaceId: 'w1', url: 'x' }], who, 1)).toThrow(/kind/)
    expect(() => applyCanvasOps(doc, [{ op: 'addWidget', id: 'wd_a', kind: 'terminal', workspaceId: 'w1' }], who, 1)).toThrow(/已经有了/)
    expect(() => applyCanvasOps(doc, [{ op: 'editWidget', id: 'wd_a', path: null }], who, 1)).toThrow(/path/)
    expect(() => applyCanvasOps(doc, [{ op: 'removeWidget', id: 'wd_none' }], who, 1)).toThrow(/没有卡片/)
    doc = applyCanvasOps(doc, [{ op: 'removeWidget', id: 'wd_a' }], who, 4000)
    expect(doc.widgets.map((w) => w.kind)).toEqual(['terminal', 'web'])
    expect(doc.nodes.wd_a).toBeUndefined()
    // 存盘再读回来还在；坏的项丢掉
    const back = sanitizeCanvasDoc(JSON.parse(JSON.stringify({ ...doc, widgets: [...doc.widgets, { id: 'wd_bad', kind: 'file', workspaceId: 'w1' }, { id: 'x', kind: 'nope', workspaceId: 'w1' }] })))
    expect(back.widgets).toEqual(doc.widgets)
  })
})
