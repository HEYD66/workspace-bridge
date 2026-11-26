// 画布页记住的东西和侧栏、主区共用的界面状态。
// - 卡片位置、镜头、便签、收纳、接力线、看过的交付：存在工作台里（canvasAll / canvasUpdate），电脑和手机看到的是同一份。
//   位置和镜头在「总画布」那一份（CANVAS_ALL）里；便签、接力线、看过的交付按项目各存一份。
// - 几个开关（镜头跟随、不画离线的、小地图）：只是这个窗口的习惯，存在界面本地。
// - 搜索词、选中、「飞到这张卡片」的请求：不存。
import { useSyncExternalStore } from 'react'
import { CANVAS_ALL, type CanvasDoc, type CanvasOp } from '../../../shared/canvasDoc'
import type { CanvasUndoResult, CanvasUndoState } from '../../../shared/canvasUndo'
import type { XY } from './canvasBoard'

export interface Camera {
  x: number
  y: number
  z: number
}

export interface CanvasSaved {
  /** 工作台里存的那一份读回来了没有；没读回来之前不要摆卡片（会把记过的位置盖掉） */
  loaded: boolean
  /** 卡片、空框、便签、小窗的位置，按各自的 key */
  pos: Record<string, XY>
  cam?: Camera
  /** 每个项目一份，加上总画布那一份（键是 CANVAS_ALL） */
  docs: Record<string, CanvasDoc>
  /** 「撤销上一步」现在能不能撤、撤的是什么（工作台记的，只记用户自己的改动）；连的是旧版工作台时没有 */
  undoState?: CanvasUndoState
  /** 镜头跟着正在干活的 AI 走 */
  follow?: boolean
  /** 不画离线的 */
  hideOffline?: boolean
  /** 小地图收起来 */
  noMap?: boolean
}

type Flag = 'follow' | 'hideOffline' | 'noMap'
const KEY = 'wb.canvas.v1'

function loadFlags(): Pick<CanvasSaved, Flag> {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Record<Flag, unknown>> | null
    return { follow: r?.follow === true, hideOffline: r?.hideOffline === true, noMap: r?.noMap === true }
  } catch {
    return {}
  }
}

let saved: CanvasSaved = { loaded: false, pos: {}, docs: {}, ...loadFlags() }
const savedListeners = new Set<() => void>()

function setSaved(next: CanvasSaved, notify = true): void {
  saved = next
  if (notify) for (const l of savedListeners) l()
}

const posOf = (doc: CanvasDoc | undefined): Record<string, XY> => {
  const out: Record<string, XY> = {}
  for (const [k, v] of Object.entries(doc?.nodes ?? {})) if (Number.isFinite(v.x) && Number.isFinite(v.y)) out[k] = { x: v.x, y: v.y }
  return out
}

const samePos = (a: Record<string, XY>, b: Record<string, XY>): boolean => {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => b[k] && a[k].x === b[k].x && a[k].y === b[k].y)
}

// ----- 往工作台存：位置和镜头攒一下再发（拖动、缩放时一秒里会改很多次） -----
const moves = new Map<string, XY>()
const forgets = new Set<string>()
let viewport: Camera | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined
let inFlight = false
/** 存的过程中工作台那边又变了：存完再读一次 */
let stale = false

const dirty = (): boolean => moves.size > 0 || forgets.size > 0 || !!viewport || inFlight

function takeOps(): CanvasOp[] {
  const ops: CanvasOp[] = []
  if (forgets.size > 0) {
    const ids = [...forgets]
    for (let i = 0; i < ids.length; i += 400) ops.push({ op: 'forget', ids: ids.slice(i, i + 400) })
  }
  if (moves.size > 0) {
    const nodes = [...moves].map(([id, p]) => ({ id, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }))
    for (let i = 0; i < nodes.length; i += 400) ops.push({ op: 'move', nodes: nodes.slice(i, i + 400) })
  }
  if (viewport) ops.push({ op: 'viewport', x: viewport.x, y: viewport.y, zoom: viewport.z })
  forgets.clear()
  moves.clear()
  viewport = undefined
  return ops
}

async function flush(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = undefined
  if (inFlight) return
  const ops = takeOps()
  if (ops.length === 0) return
  inFlight = true
  try {
    const doc = await window.bridge.canvasUpdate(CANVAS_ALL, ops)
    setSaved({ ...saved, docs: { ...saved.docs, [CANVAS_ALL]: doc } }, false)
  } catch {
    // 存不了就只在这次打开期间记着
  }
  inFlight = false
  if (moves.size > 0 || forgets.size > 0 || viewport) schedule(50)
  else if (stale) void pull()
}

function schedule(ms: number): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => void flush(), ms)
}

// ----- 从工作台读 -----
let pullTimer: ReturnType<typeof setTimeout> | undefined

/** 撤销的状态；旧版工作台没有这个调用，就当没有 */
async function readUndoState(): Promise<CanvasUndoState | undefined> {
  try {
    return await window.bridge.canvasUndoState()
  } catch {
    return undefined
  }
}

async function pull(): Promise<void> {
  stale = false
  let docs: Record<string, CanvasDoc>
  let undoState: CanvasUndoState | undefined
  try {
    ;[docs, undoState] = await Promise.all([window.bridge.canvasAll(), readUndoState()])
  } catch {
    // 读不到（比如连的是旧版工作台）：照样能用，只是不存
    if (!saved.loaded) setSaved({ ...saved, loaded: true })
    return
  }
  const all = docs[CANVAS_ALL]
  if (!saved.loaded) {
    const v = all?.viewport
    setSaved({ ...saved, loaded: true, docs, undoState, pos: posOf(all), cam: v && v.zoom > 0 ? { x: v.x, y: v.y, z: v.zoom } : undefined })
    return
  }
  // 手上还有没存完的改动：位置先用自己的，存完再读一次
  if (dirty()) {
    stale = true
    setSaved({ ...saved, docs, undoState })
    return
  }
  const pos = posOf(all)
  setSaved({ ...saved, docs, undoState, pos: samePos(pos, saved.pos) ? saved.pos : pos })
}

let started = false
function start(): void {
  if (started) return
  started = true
  void pull()
  window.bridge.onChanged((kind) => {
    if (kind !== 'canvas') return
    if (pullTimer) clearTimeout(pullTimer)
    pullTimer = setTimeout(() => void pull(), 120)
  })
  // 关窗口、刷新之前把攒着的发出去
  window.addEventListener('pagehide', () => void flush())
}

const subscribeSaved = (l: () => void): (() => void) => {
  start()
  savedListeners.add(l)
  return () => {
    savedListeners.delete(l)
  }
}

export const useCanvasSaved = (): CanvasSaved => useSyncExternalStore(subscribeSaved, () => saved, () => saved)
export const getCanvasSaved = (): CanvasSaved => saved

/** 记下一批位置（别的不动） */
export function patchPositions(patch: Record<string, XY>): void {
  const keys = Object.keys(patch)
  if (keys.length === 0) return
  for (const k of keys) {
    moves.set(k, patch[k])
    forgets.delete(k)
  }
  setSaved({ ...saved, pos: { ...saved.pos, ...patch } })
  schedule(250)
}

/** 整个换掉（一键整理、撤销整理用）：没给的位置都忘掉 */
export function replacePositions(pos: Record<string, XY>): void {
  for (const k of Object.keys(saved.pos)) {
    if (pos[k]) continue
    forgets.add(k)
    moves.delete(k)
  }
  for (const [k, p] of Object.entries(pos)) {
    moves.set(k, p)
    forgets.delete(k)
  }
  setSaved({ ...saved, pos })
  schedule(250)
}

/** 忘掉几个位置（便签、小窗删掉以后） */
export function forgetPositions(keys: readonly string[]): void {
  const pos = { ...saved.pos }
  let changed = false
  for (const k of keys) {
    if (!(k in pos)) continue
    delete pos[k]
    forgets.add(k)
    moves.delete(k)
    changed = true
  }
  if (!changed) return
  setSaved({ ...saved, pos })
  schedule(250)
}

/** 镜头变了：只存，不通知界面（界面自己拿着镜头，免得每动一下都重画） */
export function saveCamera(cam: Camera): void {
  viewport = { ...cam }
  setSaved({ ...saved, cam }, false)
  schedule(400)
}

export function setCanvasFlag(flag: Flag, on: boolean): void {
  setSaved({ ...saved, [flag]: on })
  try {
    localStorage.setItem(KEY, JSON.stringify({ follow: saved.follow === true, hideOffline: saved.hideOffline === true, noMap: saved.noMap === true }))
  } catch {
    // 存不了就只在这次打开期间记着
  }
}

/**
 * 改画布上存的东西（便签、收纳、接力线、看过的交付……）。id 是项目的工作区 id，或者 CANVAS_ALL。
 * 成功返回新的那一份；不合规或者存不了时抛错，调用方决定怎么告诉用户。
 */
export async function canvasOp(id: string, ops: CanvasOp[]): Promise<CanvasDoc> {
  const doc = await window.bridge.canvasUpdate(id, ops)
  setSaved({ ...saved, docs: { ...saved.docs, [id]: doc } })
  return doc
}

/**
 * 撤销用户在画布上的上一步（Ctrl+Z 调这个）。先把攒着没发出去的位置发掉（刚拖完就按 Ctrl+Z，撤的应该是这次拖动），
 * 再让工作台撤，然后重新读一遍画布。结果原样返回：message 可以直接提示用户；status 是 partial / conflict 时有的东西没撤。
 * 连的是旧版工作台（没有撤销）时抛错
 */
export async function undoCanvas(): Promise<CanvasUndoResult> {
  for (let i = 0; i < 200 && dirty(); i++) {
    if (inFlight) await new Promise((r) => setTimeout(r, 20))
    else await flush()
  }
  const result = await window.bridge.canvasUndo()
  await pull()
  return result
}

// ========== 界面状态（不存盘） ==========

export interface CanvasUi {
  /** 搜索词 */
  query: string
  /** 选中的卡片 key */
  selected: readonly string[]
  /** 「飞到这里」的请求：card 是卡片 key，group 是框 id；n 每次加一，同一个目标点两次也算 */
  focus?: { kind: 'card' | 'group'; id: string; n: number }
}

let ui: CanvasUi = { query: '', selected: [] }
const uiListeners = new Set<() => void>()

function setUi(next: CanvasUi): void {
  ui = next
  for (const l of uiListeners) l()
}

const subscribeUi = (l: () => void): (() => void) => {
  uiListeners.add(l)
  return () => {
    uiListeners.delete(l)
  }
}

export const useCanvasUi = (): CanvasUi => useSyncExternalStore(subscribeUi, () => ui, () => ui)
export const getCanvasUi = (): CanvasUi => ui

export function setCanvasQuery(query: string): void {
  if (query !== ui.query) setUi({ ...ui, query })
}

export function setCanvasSelected(selected: readonly string[]): void {
  if (selected.length === ui.selected.length && selected.every((k, i) => k === ui.selected[i])) return
  setUi({ ...ui, selected })
}

export function focusOnCanvas(kind: 'card' | 'group', id: string): void {
  setUi({ ...ui, selected: kind === 'card' ? [id] : ui.selected, focus: { kind, id, n: (ui.focus?.n ?? 0) + 1 } })
}

/** 名字、职位、手上任务里有没有这个词（不分大小写）；空词都算有 */
export function matchesQuery(query: string, texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return texts.some((t) => !!t && t.toLowerCase().includes(q))
}
