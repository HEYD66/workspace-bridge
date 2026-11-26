// 画布零件调后台的一小层：只是把 window.bridge 上画布相关的两个入口包一下，零件都从这里调，
// 入口的名字以后要是变了只改这一处。
import type { CanvasDoc, CanvasOp } from '../../../../shared/canvasDoc'

interface CanvasBridge {
  canvasUpdate(id: string, ops: CanvasOp[]): Promise<CanvasDoc>
  canvasAll(): Promise<Record<string, CanvasDoc>>
}

const api = (): CanvasBridge => window.bridge as unknown as CanvasBridge

/** 改某个项目的画布（id 是工作区 id，或 CANVAS_ALL） */
export function canvasUpdate(id: string, ops: CanvasOp[]): Promise<CanvasDoc> {
  return api().canvasUpdate(id, ops)
}

export function canvasAll(): Promise<Record<string, CanvasDoc>> {
  return api().canvasAll()
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
