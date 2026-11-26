import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeIntelFor } from '../src/core/codeIntel'
import { FileTools } from '../src/core/fileTools'
import { aspectRatio, sniffImage } from '../src/core/imageInfo'
import { PathGuard } from '../src/core/pathGuard'
import { PlanStore, planToTodos } from '../src/core/plans'

let base: string
let root: string
let guard: PathGuard

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-code-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export interface Shape {\n  area(): number\n}\nexport function add(a: number, b: number): number {\n  return a + b\n}\nexport class Square implements Shape {\n  constructor(private side: number) {}\n  area(): number {\n    return this.side * this.side\n  }\n}\n')
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), "import { add } from './util'\nconst n: number = 'oops'\nexport const total = add(1, 2)\nconsole.log(n, total)\n")
  fs.writeFileSync(path.join(root, 'notes.md'), '# hi\n')
  fs.mkdirSync(path.join(base, 'outside'))
  fs.writeFileSync(path.join(base, 'outside', 'secretish.ts'), 'export const hidden = 1\n')
  guard = new PathGuard(root)
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

describe('get_diagnostics', () => {
  it('报出故意写错的类型', () => {
    const r = codeIntelFor(guard).diagnostics('src/main.ts', undefined, 100) as any
    expect(r.counts.error).toBe(1)
    expect(r.diagnostics[0]).toMatchObject({ path: 'src/main.ts', line: 2, column: 7, code: 'TS2322', severity: 'error' })
    expect(r.projects).toEqual(['tsconfig.json'])
  })
  it('目录范围 + 严重级别过滤', () => {
    const all = codeIntelFor(guard).diagnostics(undefined, undefined, 100) as any
    expect(all.files_checked).toBe(2)
    expect(all.counts.error).toBe(1)
    const warnOnly = codeIntelFor(guard).diagnostics('src', ['warning'], 100) as any
    expect(warnOnly.diagnostics).toEqual([])
  })
  it('修好之后重新检查是干净的（按修改时间失效缓存）', () => {
    const f = path.join(root, 'src', 'main.ts')
    const old = fs.readFileSync(f, 'utf8')
    fs.writeFileSync(f, old.replace("'oops'", '42'))
    const t = new Date(Date.now() + 5000)
    fs.utimesSync(f, t, t)
    const r = codeIntelFor(guard).diagnostics('src/main.ts', undefined, 100) as any
    expect(r.counts.error).toBe(0)
    fs.writeFileSync(f, old)
    const t2 = new Date(Date.now() + 10000)
    fs.utimesSync(f, t2, t2)
  })
  it('非 TS/JS 文件说明不支持', () => {
    const r = codeIntelFor(guard).diagnostics('notes.md', undefined, 100) as any
    expect(r.supported).toBe(false)
  })
  it('工作区外的路径被拒绝', () => {
    expect(() => codeIntelFor(guard).diagnostics('../outside/secretish.ts', undefined, 10)).toThrow()
  })
})

describe('lsp', () => {
  it('definition 跳到另一个文件', () => {
    const r = codeIntelFor(guard).lsp({ operation: 'definition', path: 'src/main.ts', line: 3, column: 22 }) as any
    expect(r.provider_state).toBe('ready')
    expect(r.definitions[0]).toMatchObject({ path: 'src/util.ts', line: 4, name: 'add' })
  })
  it('references / hover / implementation / symbols', () => {
    const ci = codeIntelFor(guard)
    const refs = ci.lsp({ operation: 'references', path: 'src/util.ts', line: 4, column: 17 }) as any
    expect(refs.references.map((x: any) => x.path).sort()).toEqual(['src/main.ts', 'src/main.ts', 'src/util.ts'])
    const noDecl = ci.lsp({ operation: 'references', path: 'src/util.ts', line: 4, column: 17, include_declaration: false }) as any
    expect(noDecl.total).toBe(2)
    const hover = ci.lsp({ operation: 'hover', path: 'src/main.ts', line: 3, column: 22 }) as any
    expect(hover.signature).toContain('add(a: number, b: number): number')
    const impl = ci.lsp({ operation: 'implementation', path: 'src/util.ts', line: 1, column: 18 }) as any
    expect(impl.implementations.some((i: any) => i.preview.includes('class Square'))).toBe(true)
    const doc = ci.lsp({ operation: 'document_symbols', path: 'src/util.ts' }) as any
    expect(doc.symbols.map((s: any) => s.name)).toEqual(expect.arrayContaining(['Shape', 'add', 'Square']))
    const ws = ci.lsp({ operation: 'workspace_symbols', query: 'Squ' }) as any
    expect(ws.symbols[0]).toMatchObject({ name: 'Square', path: 'src/util.ts' })
  })
  it('位置越界给出明确错误', () => {
    expect(() => codeIntelFor(guard).lsp({ operation: 'hover', path: 'src/main.ts', line: 99, column: 1 })).toThrow(/一共 \d+ 行/)
  })
})

describe('read_image 的格式识别', () => {
  it('PNG / GIF / SVG / BMP', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGP4z8DAwMDAxAAAHAYDAb2/6uYAAAAASUVORK5CYII=', 'base64')
    expect(sniffImage(png)).toMatchObject({ format: 'png', width: 2, height: 3 })
    const gif = Buffer.from('R0lGODlhBQAEAIAAAP///wAAACwAAAAABQAEAAACBISPqQUAOw==', 'base64')
    expect(sniffImage(gif)).toMatchObject({ format: 'gif', width: 5, height: 4 })
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"></svg>'))).toMatchObject({ format: 'svg', width: 24, height: 12 })
    const bmp = Buffer.alloc(54)
    bmp.write('BM', 0, 'ascii')
    bmp.writeInt32LE(640, 18)
    bmp.writeInt32LE(-480, 22)
    expect(sniffImage(bmp)).toMatchObject({ format: 'bmp', width: 640, height: 480 })
    expect(sniffImage(Buffer.from('hello world'))).toBeNull()
    expect(aspectRatio(1920, 1080)).toBe('16:9')
  })
  it('readBinary 走路径守卫', async () => {
    const t = new FileTools(guard, path.join(base, 'trash'))
    fs.writeFileSync(path.join(root, 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGP4z8DAwMDAxAAAHAYDAb2/6uYAAAAASUVORK5CYII=', 'base64'))
    const r = await t.readBinary('a.png', 1024)
    expect(r.path).toBe('a.png')
    expect(r.data?.length).toBe(r.size)
    await expect(t.readBinary('../outside/secretish.ts', 1024)).rejects.toThrow()
  })
})

describe('待办清单 / 计划 / 进度', () => {
  it('set_todos + revision 校验 + patch + 完成', () => {
    const s = new PlanStore()
    const a = s.setTodos('ag', { todos: [{ id: 'a', title: '读代码', status: 'in_progress' }, { id: 'b', title: '改代码', status: 'pending' }], newTask: true })
    expect(a.task?.revision).toBe(1)
    expect(() => s.setTodos('ag', { todos: [], mode: 'patch', taskId: a.task!.taskId, expectedRevision: 9 })).toThrow(/第 1 版/)
    expect(() => s.setTodos('ag', { todos: [{ id: 'a', title: 'x', status: 'in_progress' }, { id: 'b', title: 'y', status: 'in_progress' }] })).toThrow(/一项 in_progress/)
    const b = s.setTodos('ag', { todos: [{ id: 'a', title: '读代码', status: 'completed' }], mode: 'patch', taskId: a.task!.taskId, expectedRevision: 1 })
    expect(b.task?.todos.map((t) => t.status)).toEqual(['completed', 'pending'])
    expect(() => s.setTodos('ag', { todos: b.task!.todos, lifecycle: 'completed' })).toThrow(/还没完成：b/)
    const p = s.reportProgress('ag', { message: '跑测试' })
    expect(p.link).toBe('none')
    s.setTodos('ag', { todos: [{ id: 'a', title: '读代码', status: 'completed' }, { id: 'b', title: '改代码', status: 'in_progress' }] })
    const p2 = s.reportProgress('ag', { message: '改到一半', percent: 50 })
    expect(p2).toMatchObject({ todoId: 'b', link: 'auto' })
    const done = s.setTodos('ag', { todos: [{ id: 'a', title: '读代码', status: 'completed' }, { id: 'b', title: '改代码', status: 'completed' }], lifecycle: 'completed' })
    expect(done.task?.lifecycle).toBe('completed')
    expect(s.list('other')).toEqual([])
  })
  it('update_plan 同名步骤沿用 id', () => {
    const first = planToTodos([{ step: 'A', status: 'completed' }, { step: 'B', status: 'in_progress' }], undefined)
    const next = planToTodos([{ step: 'B', status: 'completed' }, { step: 'C', status: 'in_progress' }], first)
    expect(next[0].id).toBe(first[1].id)
    expect(new Set([...first, ...next].map((t) => t.id)).size).toBe(3)
  })
})
