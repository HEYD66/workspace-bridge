// T-13：资源管理器、任务卡、工作区、技能、编辑器标签、记忆卡的右键菜单项
import { describe, expect, it, vi } from 'vitest'
import { isAction, type MenuAction, type MenuEntry } from '../src/renderer/src/lib/contextMenu'
import {
  editorTabMenu,
  explorerMenu,
  joinRoot,
  memoryMenu,
  skillMenu,
  tabsToClose,
  taskMenu,
  workspaceMenu
} from '../src/renderer/src/lib/menus'

const ids = (list: MenuEntry[]): string[] => list.map((e) => (e === '-' ? '-' : e.id))
const item = (list: MenuEntry[], id: string): MenuAction => {
  const hit = list.find((e) => isAction(e) && e.id === id)
  if (!hit || hit === '-') throw new Error(`没有菜单项 ${id}`)
  return hit
}
const noop = () => {}

describe('拼绝对路径', () => {
  it('Windows 根目录用反斜杠', () => {
    expect(joinRoot('D:\\AProgram\\MCP', 'src/a.ts')).toBe('D:\\AProgram\\MCP\\src\\a.ts')
    expect(joinRoot('D:\\AProgram\\MCP\\', 'src/a.ts')).toBe('D:\\AProgram\\MCP\\src\\a.ts')
  })
  it('根自己（.）就是根目录', () => {
    expect(joinRoot('D:\\AProgram\\MCP', '.')).toBe('D:\\AProgram\\MCP')
    expect(joinRoot('/home/a', '.')).toBe('/home/a')
  })
  it('Unix 根目录用斜杠', () => {
    expect(joinRoot('/home/a', 'b/c.md')).toBe('/home/a/b/c.md')
  })
})

describe('资源管理器右键', () => {
  const acts = {
    newFile: noop,
    newDir: noop,
    rename: noop,
    remove: noop,
    reveal: noop,
    copyPath: noop,
    copyRelPath: noop,
    refresh: noop
  }
  it('文件：没有新建，有重命名、删除、显示、复制路径、刷新（原有功能都在）', () => {
    const list = explorerMenu({ isDir: false, isRoot: false }, acts)
    expect(ids(list)).toEqual(['rename', 'delete', '-', 'reveal', 'copy-path', 'copy-rel', '-', 'refresh'])
  })
  it('文件夹：多了新建文件、新建文件夹', () => {
    const list = explorerMenu({ isDir: true, isRoot: false }, acts)
    expect(ids(list).slice(0, 3)).toEqual(['new-file', 'new-dir', '-'])
    expect(ids(list)).toContain('delete')
  })
  it('根：能新建，不能重命名、删除', () => {
    const list = explorerMenu({ isDir: true, isRoot: true }, acts)
    expect(ids(list)).not.toContain('rename')
    expect(ids(list)).not.toContain('delete')
    expect(ids(list)).toContain('new-file')
    expect(ids(list)).toContain('reveal')
  })
  it('删除是危险项，但不二次确认（后面还有原来的确认弹窗）', () => {
    const del = item(explorerMenu({ isDir: false, isRoot: false }, acts), 'delete')
    expect(del.danger).toBe(true)
    expect(del.confirm).toBeUndefined()
  })
  it('点菜单项调到对应动作', () => {
    const newDir = vi.fn()
    item(explorerMenu({ isDir: true, isRoot: false }, { ...acts, newDir }), 'new-dir').run()
    expect(newDir).toHaveBeenCalledOnce()
  })
})

describe('任务卡右键', () => {
  const agents = [
    { id: 'a1', name: 'maya02' },
    { id: 'a2', name: 'arena-003' }
  ]
  const acts = { open: noop, setStatus: noop, assign: noop, copyRef: noop, copyTitle: noop, mention: noop, remove: noop }
  it('当前负责人和当前状态灰掉并写原因', () => {
    const list = taskMenu({ ref: 'T-13', status: 'in_progress', assigneeId: 'a1' }, agents, acts)
    expect(item(list, 'assign:a1').disabled).toBe('已经是负责人')
    expect(item(list, 'assign:a2').disabled).toBeUndefined()
    expect(item(list, 'status:in_progress').disabled).toBe('现在就是这个状态')
    expect(item(list, 'status:review').disabled).toBeUndefined()
  })
  it('没有负责人：改回待认领和 @负责人 灰掉', () => {
    const list = taskMenu({ ref: 'T-1', status: 'todo', assigneeId: null }, agents, acts)
    expect(item(list, 'unassign').disabled).toBe('现在就没有负责人')
    expect(item(list, 'mention').disabled).toBe('还没有负责人')
  })
  it('负责人不在团队里：@ 灰掉', () => {
    const list = taskMenu({ ref: 'T-1', status: 'todo', assigneeId: 'gone' }, agents, acts)
    expect(item(list, 'mention').disabled).toBe('负责人已经不在团队里')
  })
  it('五个状态都有，删除要点两次', () => {
    const list = taskMenu({ ref: 'T-1', status: 'todo' }, agents, acts)
    expect(ids(list).filter((i) => i.startsWith('status:'))).toHaveLength(5)
    const del = item(list, 'delete')
    expect(del.danger).toBe(true)
    expect(del.confirm).toBeTruthy()
  })
  it('点动作传对参数', () => {
    const setStatus = vi.fn()
    const assign = vi.fn()
    const mention = vi.fn()
    const list = taskMenu({ ref: 'T-1', status: 'todo', assigneeId: 'a2' }, agents, { ...acts, setStatus, assign, mention })
    item(list, 'status:done').run()
    item(list, 'assign:a1').run()
    item(list, 'unassign').run()
    item(list, 'mention').run()
    expect(setStatus).toHaveBeenCalledWith('done')
    expect(assign.mock.calls).toEqual([['a1'], [null]])
    expect(mention).toHaveBeenCalledWith('arena-003')
    expect(item(list, 'mention').label).toBe('在群聊 @arena-003')
  })
})

describe('工作区右键', () => {
  const acts = { switchTo: noop, reveal: noop, copyPath: noop, members: noop, manage: noop, remove: noop }
  it('当前工作区不能再切换；目录不在不能显示', () => {
    const list = workspaceMenu({ active: true, exists: false }, acts)
    expect(item(list, 'switch').disabled).toBe('已经是当前工作区')
    expect(item(list, 'reveal').disabled).toBe('目录已经不在了')
  })
  it('移出列表要点两次，说明不删文件', () => {
    const rm = item(workspaceMenu({ active: false, exists: true }, acts), 'remove')
    expect(rm.danger).toBe(true)
    expect(rm.confirm).toContain('不删文件')
  })
})

describe('技能右键', () => {
  const acts = { open: noop, setEnabled: noop, openDir: noop, copyName: noop, remove: noop }
  it('启用中的显示停用', () => {
    const setEnabled = vi.fn()
    const list = skillMenu({ status: 'enabled' }, { ...acts, setEnabled })
    expect(ids(list)).toContain('disable')
    expect(ids(list)).not.toContain('enable')
    item(list, 'disable').run()
    expect(setEnabled).toHaveBeenCalledWith(false)
  })
  it('格式有问题的不能启用', () => {
    expect(item(skillMenu({ status: 'invalid' }, acts), 'enable').disabled).toBe('技能格式有问题，修好才能启用')
    expect(item(skillMenu({ status: 'disabled' }, acts), 'enable').disabled).toBeUndefined()
  })
  it('删除要点两次', () => {
    expect(item(skillMenu({ status: 'enabled' }, acts), 'delete').confirm).toBeTruthy()
  })
})

describe('编辑器标签右键', () => {
  const acts = { close: noop, closeOthers: noop, closeRight: noop, closeAll: noop, copyPath: noop, copyRelPath: noop, reveal: noop }
  it('只有一个标签：关闭其他、关闭右侧灰掉', () => {
    const list = editorTabMenu(0, 1, acts)
    expect(item(list, 'close-others').disabled).toBe('没有别的标签')
    expect(item(list, 'close-right').disabled).toBe('右边没有标签')
  })
  it('最后一个标签：关闭右侧灰掉，关闭其他能用', () => {
    const list = editorTabMenu(2, 3, acts)
    expect(item(list, 'close-right').disabled).toBe('右边没有标签')
    expect(item(list, 'close-others').disabled).toBeUndefined()
  })
  it('算出要关的标签', () => {
    const tabs = ['a', 'b', 'c', 'd']
    expect(tabsToClose(tabs, 1, 'others')).toEqual(['a', 'c', 'd'])
    expect(tabsToClose(tabs, 1, 'right')).toEqual(['c', 'd'])
    expect(tabsToClose(tabs, 3, 'right')).toEqual([])
    expect(tabsToClose(tabs, 1, 'all')).toEqual(tabs)
  })
})

describe('记忆卡右键', () => {
  const acts = { edit: noop, copyContent: noop, copyTitle: noop, togglePin: noop, remove: noop }
  it('置顶和取消置顶二选一', () => {
    expect(ids(memoryMenu({ pinned: false }, acts))).toContain('pin')
    expect(ids(memoryMenu({ pinned: true }, acts))).toContain('unpin')
    expect(ids(memoryMenu({ pinned: true }, acts))).not.toContain('pin')
  })
  it('删除要点两次', () => {
    const del = item(memoryMenu({ pinned: false }, acts), 'delete')
    expect(del.danger).toBe(true)
    expect(del.confirm).toBeTruthy()
  })
})
