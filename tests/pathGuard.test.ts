import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathGuard } from '../src/core/pathGuard'

let base: string
let root: string
let outside: string
let dataDir: string
let guard: PathGuard

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-guard-'))
  root = path.join(base, 'ws')
  outside = path.join(base, 'outside')
  dataDir = path.join(root, 'appdata')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(outside)
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
  // junction 不需要管理员权限，能模拟符号链接逃逸
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
  guard = new PathGuard(root, [dataDir])
})

afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

describe('PathGuard', () => {
  it('解析相对路径与根目录', () => {
    expect(guard.resolve('src/a.ts').rel).toBe('src/a.ts')
    expect(guard.resolve('.').rel).toBe('.')
    expect(guard.resolve('').rel).toBe('.')
    expect(guard.resolve('src\\a.ts').rel).toBe('src/a.ts')
  })

  it('无盘符的 /foo 视为工作区相对路径', () => {
    expect(guard.resolve('/src/a.ts').rel).toBe('src/a.ts')
  })

  it('接受工作区内的绝对路径', () => {
    expect(guard.resolve(path.join(root, 'src', 'b.ts')).rel).toBe('src/b.ts')
  })

  it.each([['../outside/secret.txt'], ['src/../../outside/secret.txt'], ['C:/Windows/System32/drivers/etc/hosts']])(
    '拒绝越界：%s',
    (p) => {
      expect(() => guard.resolve(p)).toThrow(/OUTSIDE_WORKSPACE/)
    }
  )

  it('拒绝工作区外的绝对路径', () => {
    expect(() => guard.resolve(path.join(outside, 'secret.txt'))).toThrow(/OUTSIDE_WORKSPACE/)
  })

  it('拒绝经 junction 逃逸', () => {
    expect(() => guard.resolve('escape/secret.txt')).toThrow(/OUTSIDE_WORKSPACE/)
    expect(() => guard.resolve('escape/new.txt')).toThrow(/OUTSIDE_WORKSPACE/)
  })

  it.each([['.env'], ['config/.env.local'], ['certs/server.KEY'], ['.git/config'], ['a/.ssh/id_rsa'], ['id_ed25519.pub']])(
    'AI 侧不再按名字拦凭据文件和 .git 内部：%s',
    (p) => {
      expect(guard.resolve(p).rel).toBe(p)
    }
  )

  it('工作台（用户）侧：凭据文件放行，.git 内部照样不让直接改', () => {
    const user = new PathGuard(root, [dataDir], { mode: 'user' })
    expect(user.resolve('.env').rel).toBe('.env')
    expect(() => user.resolve('.git/config')).toThrow(/SENSITIVE_FILE/)
    // 两边都保护本应用数据目录
    expect(() => user.resolve('appdata/config.json')).toThrow(/PROTECTED/)
    expect(() => guard.resolve('appdata/config.json')).toThrow(/PROTECTED/)
  })

  it('搜索和遍历跳过 .git 和隐藏目录里的东西，但能直接点名读', () => {
    expect(guard.isTraverseSkip(path.join(root, '.git'))).toBe(true)
    expect(guard.isTraverseSkip(path.join(root, 'src'))).toBe(false)
    expect(guard.denyGlobs()).toEqual(['.git'])
  })

  it('拒绝 Windows 特殊写法', () => {
    expect(() => guard.resolve('.env.')).toThrow(/INVALID_PATH/)
    expect(() => guard.resolve('a.txt:stream')).toThrow(/INVALID_PATH/)
    expect(() => guard.resolve('src/CON')).toThrow(/INVALID_PATH/)
    expect(() => guard.resolve('src/nul.txt')).toThrow(/INVALID_PATH/)
    expect(() => guard.resolve('a\0b')).toThrow(/INVALID_PATH/)
  })

  it('拒绝应用数据目录', () => {
    expect(() => guard.resolve('appdata/config.json')).toThrow(/PROTECTED/)
    expect(guard.isHidden(path.join(dataDir, 'config.json'))).toBe(true)
  })

  it('普通文件名不误伤', () => {
    expect(guard.resolve('src/env.ts').rel).toBe('src/env.ts')
    expect(guard.resolve('docs/keys.md').rel).toBe('docs/keys.md')
    expect(guard.resolve('.gitignore').rel).toBe('.gitignore')
  })
})
