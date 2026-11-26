// 右栏的标签页：开、关、翻页、新标签页变网页、地址栏输的东西变成网址、最近打开
import { describe, expect, it } from 'vitest'
import { BROWSER_PARTITION, guestShortcut } from '../src/shared/browser'
import {
  activate,
  activeTab,
  addNewTab,
  addRecent,
  addressToUrl,
  browsableUrl,
  closeTab,
  defaultTabs,
  dirName,
  fileTabKey,
  fileTabsUnder,
  renameFileTabs,
  getPanelTabs,
  MAX_PANEL_TABS,
  MAX_RECENT,
  navigateTab,
  newTabId,
  newTabToTool,
  onRightPanelRequest,
  openBrowserTab,
  openFileTab,
  openTerminalTab,
  openTool,
  parseRecent,
  parseTabs,
  patchBrowserTab,
  pruneTerminalTabs,
  terminalTabIds,
  SEARCH_URL,
  siteLabel,
  tabTitle,
  updatePanelTabs,
  type PanelTab,
  type PanelTabs
} from '../src/renderer/src/lib/rightTabs'
import { cancelCloseFileTab, closeFileTab, getRightFiles, markRightFilesDeleted, onRightFileSignal, openRightFile, renameRightFiles, resetRightFiles, setRightFileDirty, type RightFileSignal } from '../src/renderer/src/lib/rightFiles'

const ids = (s: PanelTabs): string[] => s.tabs.map((t) => t.id)

describe('文件标签', () => {
  const F1 = { workspaceId: 'w_aaaa0001', path: 'src/app/main.ts' }
  const F2 = { workspaceId: 'w_aaaa0001', path: 'README.md' }

  it('在右栏打开文件：加在最后并翻到它，标签名是文件名；同一个文件只有一个标签，再开一次只是翻过去', () => {
    const a = openFileTab(defaultTabs(), F1, 'fa')
    expect(ids(a)).toEqual(['changes', 'tasks', 'activity', 'fa'])
    expect(a.active).toBe('fa')
    expect(tabTitle(a.tabs[3])).toBe('main.ts')
    const b = openFileTab(activate(a, 'tasks'), { ...F1, path: '.\\src\\app\\main.ts' }, 'other')
    expect(ids(b)).toEqual(ids(a))
    expect(b.active).toBe('fa')
    // 另一个项目里同名同路径的文件是另一个标签
    const c = openFileTab(b, { workspaceId: 'w_bbbb0002', path: F1.path }, 'fb')
    expect(ids(c)).toEqual(['changes', 'tasks', 'activity', 'fa', 'fb'])
  })

  it('正在看的是新标签页：就地变成文件标签（位置和 id 不变）；不是新标签页就加在最后', () => {
    const withNew = addNewTab(defaultTabs(), 'n1')
    const s = openFileTab(withNew, F2, 'unused', { replaceId: withNew.active })
    expect(s.tabs[3]).toEqual({ id: 'n1', kind: 'file', ...F2 })
    expect(s.active).toBe('n1')
    const t = openFileTab(defaultTabs(), F2, 'fa', { replaceId: 'activity' })
    expect(ids(t)).toEqual(['changes', 'tasks', 'activity', 'fa'])
  })

  it('路径是空的、标签满了：原样返回', () => {
    expect(openFileTab(defaultTabs(), { workspaceId: 'w', path: '' }, 'fa')).toEqual(defaultTabs())
    expect(openFileTab(defaultTabs(), { workspaceId: '', path: 'a.ts' }, 'fa')).toEqual(defaultTabs())
    let s = defaultTabs()
    for (let i = 0; s.tabs.length < MAX_PANEL_TABS; i++) s = openFileTab(s, { workspaceId: 'w', path: `f${i}.ts` }, `f${i}`)
    expect(openFileTab(s, F1, 'fa')).toBe(s)
  })

  it('存下来再读回来：文件标签还在；缺东西的、重复的丢掉', () => {
    const s = openFileTab(defaultTabs(), F1, 'fa')
    expect(parseTabs(JSON.parse(JSON.stringify(s)))).toEqual(s)
    const raw = { tabs: [{ id: 'fa', kind: 'file', ...F1 }, { id: 'fb', kind: 'file', ...F1 }, { id: 'fc', kind: 'file', workspaceId: 'w' }, { id: 'fd', kind: 'file', workspaceId: 'w', path: '' }], active: 'fb' }
    expect(parseTabs(raw)).toEqual({ tabs: [{ id: 'fa', kind: 'file', ...F1 }], active: 'fa' })
  })

  it('右栏里的文件在编辑器里有自己的身份，和整页编辑器里的同一个文件分开', () => {
    expect(fileTabKey(F1)).toBe('right:w_aaaa0001:src/app/main.ts')
    expect(fileTabKey(F1)).not.toBe(`${F1.workspaceId}:${F1.path}`)
  })

  it('在地址栏输网址不会把文件标签换成网页；终端没了时文件标签不受影响', () => {
    const s = openFileTab(defaultTabs(), F1, 'fa')
    expect(navigateTab(s, 'fa', 'https://example.com')).toBe(s)
    expect(pruneTerminalTabs(s, new Set(), 'spare')).toBe(s)
  })
})

describe('文件标签：打开、没保存、关', () => {
  const F = { workspaceId: 'w_aaaa0001', path: 'docs/notes.md' }
  const fileTab = () => getPanelTabs().tabs.find((t) => t.kind === 'file' && t.path === F.path)

  it('openRightFile：加一个文件标签并翻到它，要右栏展开；带行号时记下要跳到哪', () => {
    let asked = 0
    const off = onRightPanelRequest(() => asked++)
    openRightFile({ ...F, line: 12, column: 3 })
    off()
    const tab = fileTab()
    expect(tab).toBeTruthy()
    expect(getPanelTabs().active).toBe(tab!.id)
    expect(asked).toBe(1)
    expect(getRightFiles().reveal).toMatchObject({ key: fileTabKey(F), line: 12, column: 3 })
  })

  it('没有没保存的改动：关就直接关', () => {
    const id = fileTab()!.id
    closeFileTab(id)
    expect(fileTab()).toBeUndefined()
    expect(getRightFiles().closing).toBeUndefined()
    expect(getRightFiles().reveal).toBeUndefined()
  })

  it('有没保存的改动：关的时候不关，翻到它等确认；取消后还在；确认过（force）才关，记号一起清掉', () => {
    openRightFile(F)
    const id = fileTab()!.id
    setRightFileDirty(fileTabKey(F), true)
    updatePanelTabs((s) => activate(s, 'tasks'))
    closeFileTab(id)
    expect(fileTab()).toBeTruthy()
    expect(getPanelTabs().active).toBe(id)
    expect(getRightFiles().closing).toBe(id)
    cancelCloseFileTab()
    expect(getRightFiles().closing).toBeUndefined()
    expect(getRightFiles().dirty.has(fileTabKey(F))).toBe(true)
    closeFileTab(id, true)
    expect(fileTab()).toBeUndefined()
    expect(getRightFiles().dirty.size).toBe(0)
  })

  it('resetRightFiles：记号全清', () => {
    setRightFileDirty('right:w:a.ts', true)
    resetRightFiles()
    expect(getRightFiles().dirty.size).toBe(0)
  })
})

describe('终端标签', () => {
  const T1 = { termId: 'term-1', cwd: 'D:\\AProgram\\MCP' }
  const T2 = { termId: 'term-2', cwd: '/home/me/site/' }

  it('标签名是终端所在目录的名字', () => {
    expect(dirName('D:\\AProgram\\MCP')).toBe('MCP')
    expect(dirName('D:/AProgram/MCP/')).toBe('MCP')
    expect(dirName('/home/me/site')).toBe('site')
    expect(dirName('D:\\')).toBe('D:')
    expect(dirName('/')).toBe('/')
    expect(dirName('')).toBe('终端')
    expect(tabTitle({ id: 'x', kind: 'terminal', ...T1 })).toBe('MCP')
  })

  it('把终端放进右栏：加在最后并翻到它；一个终端只有一个标签，再放一次只是翻过去', () => {
    const a = openTerminalTab(defaultTabs(), T1, 'ta')
    expect(ids(a)).toEqual(['changes', 'tasks', 'activity', 'ta'])
    expect(a.active).toBe('ta')
    expect(terminalTabIds(a)).toEqual(['term-1'])
    const b = openTerminalTab(activate(a, 'tasks'), T1, 'other')
    expect(ids(b)).toEqual(ids(a))
    expect(b.active).toBe('ta')
    const c = openTerminalTab(b, T2, 'tb')
    expect(terminalTabIds(c)).toEqual(['term-1', 'term-2'])
    expect(c.tabs.map(tabTitle).slice(-2)).toEqual(['MCP', 'site'])
  })

  it('在新标签页上点的「终端」：那个新标签页就地变成终端标签（位置和 id 不变）', () => {
    const withNew = activate(openBrowserTab(addNewTab(defaultTabs(), 'n1'), 'https://example.com/', 'b1'), 'n1')
    const s = openTerminalTab(withNew, T1, 'unused', { replaceId: 'n1' })
    expect(ids(s)).toEqual(['changes', 'tasks', 'activity', 'n1', 'b1'])
    expect(s.tabs[3]).toEqual({ id: 'n1', kind: 'terminal', ...T1 })
    expect(s.active).toBe('n1')
    // replaceId 不是新标签页（是工具页、网页）：不换它，加在最后
    const t = openTerminalTab(withNew, T1, 'ta', { replaceId: 'b1' })
    expect(ids(t)).toEqual(['changes', 'tasks', 'activity', 'n1', 'b1', 'ta'])
  })

  it('标签满了放不进去：原样返回（终端留在底部面板）', () => {
    let s = defaultTabs()
    for (let i = 0; s.tabs.length < MAX_PANEL_TABS; i++) s = openBrowserTab(s, `https://example.com/${i}`, `b${i}`)
    expect(openTerminalTab(s, T1, 'ta')).toBe(s)
  })

  it('终端没了（关了、应用重开过）：它的标签去掉；正在看的被去掉就翻到旁边；没有要去掉的原样返回', () => {
    const s = openTerminalTab(openTerminalTab(defaultTabs(), T1, 'ta'), T2, 'tb')
    expect(pruneTerminalTabs(s, new Set(['term-1', 'term-2']), 'spare')).toBe(s)
    const one = pruneTerminalTabs(s, new Set(['term-1']), 'spare')
    expect(ids(one)).toEqual(['changes', 'tasks', 'activity', 'ta'])
    expect(one.active).toBe('ta')
    const none = pruneTerminalTabs(s, new Set(), 'spare')
    expect(ids(none)).toEqual(['changes', 'tasks', 'activity'])
    expect(none.active).toBe('activity')
    // 只剩终端标签、终端又都没了：补一个新标签页
    const only = openTerminalTab({ tabs: [{ id: 'n1', kind: 'newtab' }], active: 'n1' }, T1, 'x', { replaceId: 'n1' })
    expect(pruneTerminalTabs(only, new Set(), 'spare')).toEqual({ tabs: [{ id: 'spare', kind: 'newtab' }], active: 'spare' })
  })

  it('存下来再读回来：终端标签还在；缺东西的、重复指同一个终端的丢掉', () => {
    const s = openTerminalTab(defaultTabs(), T1, 'ta')
    expect(parseTabs(JSON.parse(JSON.stringify(s)))).toEqual(s)
    const raw = { tabs: [{ id: 'ta', kind: 'terminal', ...T1 }, { id: 'tb', kind: 'terminal', ...T1 }, { id: 'tc', kind: 'terminal', termId: 'term-3' }, { id: 'td', kind: 'terminal', termId: 'bad id!', cwd: '/x' }], active: 'tb' }
    expect(parseTabs(raw)).toEqual({ tabs: [{ id: 'ta', kind: 'terminal', ...T1 }], active: 'ta' })
  })

  it('在地址栏输网址只对新标签页和网页标签管用，终端标签不会被换成网页', () => {
    const s = openTerminalTab(defaultTabs(), T1, 'ta')
    expect(navigateTab(s, 'ta', 'https://example.com')).toBe(s)
  })
})

describe('标签页', () => {
  it('默认是变更、任务、活动三页，看的是活动；以前记的「开着哪一页」接着用', () => {
    expect(ids(defaultTabs())).toEqual(['changes', 'tasks', 'activity'])
    expect(defaultTabs().active).toBe('activity')
    expect(parseTabs(null, 'tasks').active).toBe('tasks')
    expect(parseTabs(undefined, 'nope').active).toBe('activity')
    expect(parseTabs({ tabs: 'x' }).active).toBe('activity')
  })

  it('parseTabs：不认的丢掉，工具页不重复，新标签页只留一个，网页地址要能打开；一个不剩回到默认', () => {
    const s = parseTabs({
      active: 'b1',
      tabs: [
        { id: 'tasks', kind: 'tool' },
        { id: 'tasks', kind: 'tool' },
        { id: 'bogus', kind: 'tool' },
        { id: 'n1', kind: 'newtab' },
        { id: 'n2', kind: 'newtab' },
        { id: 'b1', kind: 'browser', url: 'http://localhost:5173/', title: '首页' },
        { id: 'b2', kind: 'browser', url: 'javascript:alert(1)' },
        { id: 'b 3', kind: 'browser', url: 'https://a.example/' },
        { id: 'activity', kind: 'browser', url: 'https://a.example/' },
        null,
        7
      ]
    })
    expect(s.tabs).toEqual([
      { id: 'tasks', kind: 'tool' },
      { id: 'n1', kind: 'newtab' },
      { id: 'b1', kind: 'browser', url: 'http://localhost:5173/', title: '首页' }
    ])
    expect(s.active).toBe('b1')
    expect(parseTabs({ active: 'gone', tabs: [{ id: 'changes', kind: 'tool' }] }).active).toBe('changes')
    expect(ids(parseTabs({ active: 'x', tabs: [{ id: 'b', kind: 'browser', url: 'chrome://settings' }] }))).toEqual(['changes', 'tasks', 'activity'])
    const many = { active: 't0', tabs: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, kind: 'browser', url: `https://a.example/${i}` })) }
    expect(parseTabs(many).tabs).toHaveLength(MAX_PANEL_TABS)
  })

  it('openTool：开着就翻过去；关掉的加回来，排在别的工具页后面、网页前面', () => {
    const base = openBrowserTab(defaultTabs(), 'https://a.example/', 'b1')
    expect(base.active).toBe('b1')
    expect(openTool(base, 'changes')).toEqual({ ...base, active: 'changes' })
    const closed = closeTab(base, 'tasks', 'spare')
    expect(ids(closed)).toEqual(['changes', 'activity', 'b1'])
    const back = openTool(closed, 'tasks')
    expect(ids(back)).toEqual(['changes', 'tasks', 'activity', 'b1'])
    expect(back.active).toBe('tasks')
    const none = closeTab(closeTab(closeTab(base, 'changes', 's'), 'tasks', 's'), 'activity', 's')
    expect(ids(openTool(none, 'activity'))).toEqual(['activity', 'b1'])
    expect(ids(openTool(openTool(none, 'activity'), 'changes'))).toEqual(['changes', 'activity', 'b1'])
  })

  it('addNewTab：加在最后并翻过去；已经有一个就不再加；满了不加', () => {
    const a = addNewTab(defaultTabs(), 'n1')
    expect(ids(a)).toEqual(['changes', 'tasks', 'activity', 'n1'])
    expect(a.active).toBe('n1')
    const b = addNewTab(activate(a, 'tasks'), 'n2')
    expect(ids(b)).toEqual(ids(a))
    expect(b.active).toBe('n1')
    let full = defaultTabs()
    for (let i = 0; i < 40; i++) full = openBrowserTab(full, `https://a.example/${i}`, `b${i}`)
    expect(full.tabs).toHaveLength(MAX_PANEL_TABS)
    expect(addNewTab(full, 'n9')).toBe(full)
  })

  it('closeTab：关正在看的翻到右边那个，没有就左边；关别的不动；关到一个不剩补一个新标签页', () => {
    const s = defaultTabs('tasks')
    expect(closeTab(s, 'tasks', 'sp')).toEqual({ tabs: [{ id: 'changes', kind: 'tool' }, { id: 'activity', kind: 'tool' }], active: 'activity' })
    expect(closeTab(defaultTabs('activity'), 'activity', 'sp').active).toBe('tasks')
    expect(closeTab(s, 'changes', 'sp').active).toBe('tasks')
    expect(closeTab(s, 'nope', 'sp')).toBe(s)
    const last = closeTab(closeTab(closeTab(s, 'changes', 'sp'), 'tasks', 'sp'), 'activity', 'sp')
    expect(last).toEqual({ tabs: [{ id: 'sp', kind: 'newtab' }], active: 'sp' })
  })

  it('新标签页：输了网址变成网页标签（id 不变）；点了工具就打开那个工具页、自己关掉', () => {
    const a = addNewTab(defaultTabs(), 'n1')
    const web = navigateTab(a, 'n1', 'http://localhost:5173/')
    expect(web.tabs[3]).toEqual({ id: 'n1', kind: 'browser', url: 'http://localhost:5173/' })
    expect(web.active).toBe('n1')
    expect(navigateTab(a, 'n1', 'javascript:1')).toBe(a)
    expect(navigateTab(a, 'tasks', 'https://a.example/')).toBe(a)
    // 网页标签改地址：标题清掉，等新网页报
    const titled = patchBrowserTab(web, 'n1', { title: '首页' })
    expect(navigateTab(titled, 'n1', 'https://b.example/x').tabs[3]).toEqual({ id: 'n1', kind: 'browser', url: 'https://b.example/x' })
    const tool = newTabToTool(a, 'n1', 'changes')
    expect(ids(tool)).toEqual(['changes', 'tasks', 'activity'])
    expect(tool.active).toBe('changes')
    // 那个工具页之前被关掉了：加回来
    const reopened = newTabToTool(addNewTab(closeTab(defaultTabs(), 'tasks', 'sp'), 'n2'), 'n2', 'tasks')
    expect(ids(reopened)).toEqual(['changes', 'tasks', 'activity'])
    expect(reopened.active).toBe('tasks')
    // 只剩一个新标签页时点工具
    const only = newTabToTool({ tabs: [{ id: 'n3', kind: 'newtab' }], active: 'n3' }, 'n3', 'activity')
    expect(only).toEqual({ tabs: [{ id: 'activity', kind: 'tool' }], active: 'activity' })
  })

  it('openBrowserTab：排在发起的那个标签后面；focus=false 不翻过去；地址不认、id 重复、满了都不开', () => {
    const a = openBrowserTab(defaultTabs(), 'https://a.example/', 'b1')
    const b = openBrowserTab(a, 'https://a.example/2', 'b2')
    const pop = openBrowserTab(b, 'https://a.example/pop', 'b3', { afterId: 'b1' })
    expect(ids(pop)).toEqual(['changes', 'tasks', 'activity', 'b1', 'b3', 'b2'])
    expect(pop.active).toBe('b3')
    expect(openBrowserTab(b, 'https://a.example/bg', 'b4', { focus: false }).active).toBe('b2')
    expect(openBrowserTab(b, 'data:text/html,x', 'b5')).toBe(b)
    expect(openBrowserTab(b, 'https://a.example/', 'b1')).toBe(b)
  })

  it('patchBrowserTab：地址、标题变了才算变；换了地址旧标题不作数；别的标签不受影响', () => {
    const a = openBrowserTab(defaultTabs(), 'https://a.example/', 'b1')
    const t = patchBrowserTab(a, 'b1', { title: '甲' })
    expect(activeTab(t)).toEqual({ id: 'b1', kind: 'browser', url: 'https://a.example/', title: '甲' })
    expect(patchBrowserTab(t, 'b1', { title: '甲' })).toBe(t)
    expect(patchBrowserTab(t, 'b1', { url: 'https://a.example/' })).toBe(t)
    expect(activeTab(patchBrowserTab(t, 'b1', { url: 'https://a.example/next' }))).toEqual({ id: 'b1', kind: 'browser', url: 'https://a.example/next' })
    expect(activeTab(patchBrowserTab(t, 'b1', { url: 'https://a.example/next', title: '乙' }))).toEqual({ id: 'b1', kind: 'browser', url: 'https://a.example/next', title: '乙' })
    expect(patchBrowserTab(t, 'b1', { url: 'javascript:1' })).toBe(t)
    expect(patchBrowserTab(t, 'tasks', { title: 'x' })).toBe(t)
    expect(patchBrowserTab(t, 'nope', { title: 'x' })).toBe(t)
  })

  it('tabTitle / siteLabel / newTabId', () => {
    expect(tabTitle({ id: 'changes', kind: 'tool' })).toBe('变更')
    expect(tabTitle({ id: 'n', kind: 'newtab' })).toBe('新标签页')
    expect(tabTitle({ id: 'b', kind: 'browser', url: 'http://localhost:5173/a' })).toBe('localhost:5173')
    expect(tabTitle({ id: 'b', kind: 'browser', url: 'https://www.example.com/a', title: ' 首页 ' })).toBe('首页')
    expect(siteLabel('https://www.example.com/a?b')).toBe('example.com')
    expect(siteLabel('file:///D:/work/%E9%A2%84%E8%A7%88.html')).toBe('预览.html')
    expect(siteLabel('about:blank')).toBe('空白页')
    const a = newTabId()
    expect(a).toMatch(/^t_[a-z0-9]+$/)
    expect(newTabId()).not.toBe(a)
    expect(parseTabs({ active: a, tabs: [{ id: a, kind: 'newtab' }] }).tabs).toEqual([{ id: a, kind: 'newtab' }])
  })
})

describe('地址栏', () => {
  it('browsableUrl：只认 http、https、file 和 about:blank', () => {
    expect(browsableUrl('https://a.example/x?y#z')).toBe('https://a.example/x?y#z')
    expect(browsableUrl(' http://localhost:3000 ')).toBe('http://localhost:3000/')
    expect(browsableUrl('about:blank')).toBe('about:blank')
    expect(browsableUrl('file:///D:/a/b.html')).toBe('file:///D:/a/b.html')
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'app://bundle/index.html', '', 'not a url', 7, null]) expect(browsableUrl(bad)).toBeUndefined()
    expect(browsableUrl(`https://a.example/${'x'.repeat(5000)}`)).toBeUndefined()
  })

  it('addressToUrl：网址原样；localhost / IP 补 http；域名补 https；本地路径当文件；别的拿去搜', () => {
    expect(addressToUrl('https://a.example/x')).toBe('https://a.example/x')
    expect(addressToUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(addressToUrl('localhost')).toBe('http://localhost/')
    expect(addressToUrl('127.0.0.1:8765/health')).toBe('http://127.0.0.1:8765/health')
    expect(addressToUrl('192.168.1.5')).toBe('http://192.168.1.5/')
    expect(addressToUrl('example.com')).toBe('https://example.com/')
    expect(addressToUrl('docs.example.com/guide?a=1')).toBe('https://docs.example.com/guide?a=1')
    expect(addressToUrl('example.com:8443/x')).toBe('https://example.com:8443/x')
    expect(addressToUrl('D:\\work\\预览.html')).toBe('file:///D:/work/%E9%A2%84%E8%A7%88.html')
    expect(addressToUrl('c:/a b/c.html')).toBe('file:///c:/a%20b/c.html')
    expect(addressToUrl('file:///D:/a.html')).toBe('file:///D:/a.html')
    expect(addressToUrl('about:blank')).toBe('about:blank')
    expect(addressToUrl('怎么 配置 隧道')).toBe(`${SEARCH_URL}${encodeURIComponent('怎么 配置 隧道')}`)
    expect(addressToUrl('electron')).toBe(`${SEARCH_URL}electron`)
    expect(addressToUrl('a.b c')).toBe(`${SEARCH_URL}${encodeURIComponent('a.b c')}`)
    expect(addressToUrl('javascript:alert(1)')).toBe(`${SEARCH_URL}${encodeURIComponent('javascript:alert(1)')}`)
    expect(addressToUrl('   ')).toBeUndefined()
  })
})

describe('最近打开', () => {
  it('addRecent：新的在前，同一个地址只留一条，最多 8 条；空白页、不认的地址不记', () => {
    let list = addRecent([], { url: 'https://a.example/', title: '甲' }, 1)
    list = addRecent(list, { url: 'https://b.example/' }, 2)
    list = addRecent(list, { url: 'https://a.example/' }, 3)
    expect(list).toEqual([
      { url: 'https://a.example/', title: '甲', ts: 3 },
      { url: 'https://b.example/', ts: 2 }
    ])
    expect(addRecent(list, { url: 'about:blank' }, 4)).toBe(list)
    expect(addRecent(list, { url: 'javascript:1' }, 4)).toBe(list)
    for (let i = 0; i < 12; i++) list = addRecent(list, { url: `https://c.example/${i}` }, 10 + i)
    expect(list).toHaveLength(MAX_RECENT)
    expect(list[0].url).toBe('https://c.example/11')
  })

  it('parseRecent：坏的丢掉、重复的丢掉、最多 8 条', () => {
    expect(parseRecent('x')).toEqual([])
    expect(parseRecent([{ url: 'https://a.example/', ts: 5, title: '甲' }, { url: 'https://a.example/' }, { url: 'ftp://x' }, null, { url: 'about:blank' }])).toEqual([{ url: 'https://a.example/', title: '甲', ts: 5 }])
    expect(parseRecent(Array.from({ length: 20 }, (_, i) => ({ url: `https://a.example/${i}` })))).toHaveLength(MAX_RECENT)
  })
})

describe('主进程：网页标签', () => {
  it('会话分区是单独的一个，重开应用还在', () => {
    expect(BROWSER_PARTITION).toBe('persist:wb-browser')
  })

  it('guestShortcut：F12 / Ctrl+Shift+I 开发者工具，F5 / Ctrl+R 刷新，Ctrl+L / T / W 转给工作台；别的不管', () => {
    const down = (key: string, mod: { control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => guestShortcut({ type: 'keyDown', key, ...mod })
    expect(down('F12')).toBe('devtools')
    expect(down('I', { control: true, shift: true })).toBe('devtools')
    expect(down('F5')).toBe('reload')
    expect(down('r', { control: true })).toBe('reload')
    expect(down('R', { control: true, shift: true })).toBe('reload')
    expect(down('l', { control: true })).toBe('address')
    expect(down('t', { control: true })).toBe('new')
    expect(down('w', { control: true })).toBe('close')
    expect(down('w', { meta: true })).toBe('close')
    expect(down('w')).toBeUndefined()
    expect(down('t', { control: true, shift: true })).toBeUndefined()
    expect(down('l', { control: true, alt: true })).toBeUndefined()
    expect(down('c', { control: true })).toBeUndefined()
    expect(guestShortcut({ type: 'keyUp', key: 'F12' })).toBeUndefined()
    expect(guestShortcut({ type: 'keyDown', key: 'F5', isAutoRepeat: true })).toBeUndefined()
  })
})

describe('文件标签跟着改名 / 找某个路径下面的标签', () => {
  const file = (id: string, path: string, workspaceId = 'w1'): PanelTab => ({ id, kind: 'file', workspaceId, path })
  const base = (): PanelTabs => ({ tabs: [...defaultTabs().tabs, file('f1', 'src/a.ts'), file('f2', 'src/sub/b.ts'), file('f3', 'srcx/c.ts'), file('f4', 'src/a.ts', 'w2')], active: 'f2' })

  it('fileTabsUnder：文件本身、目录下面的都算；名字只是开头一样的不算；别的工作区的不算', () => {
    expect(fileTabsUnder(base(), 'w1', 'src').map((t) => t.id)).toEqual(['f1', 'f2'])
    expect(fileTabsUnder(base(), 'w1', './src/a.ts').map((t) => t.id)).toEqual(['f1'])
    expect(fileTabsUnder(base(), 'w1', 'sr')).toEqual([])
    expect(fileTabsUnder(base(), 'w1', '.')).toEqual([])
  })

  it('renameFileTabs：改一个文件的名字，标签的 id、位置、谁在前面都不变', () => {
    const s = base()
    const { next, pairs } = renameFileTabs(s, 'w1', 'src/a.ts', 'src/z.ts')
    expect(pairs).toEqual([[fileTabKey({ workspaceId: 'w1', path: 'src/a.ts' }), fileTabKey({ workspaceId: 'w1', path: 'src/z.ts' })]])
    expect(next.tabs.map((t) => t.id)).toEqual(s.tabs.map((t) => t.id))
    expect(next.tabs.find((t) => t.id === 'f1')).toEqual(file('f1', 'src/z.ts'))
    expect(next.tabs.find((t) => t.id === 'f4')).toEqual(file('f4', 'src/a.ts', 'w2'))
    expect(next.active).toBe('f2')
  })

  it('renameFileTabs：移动目录，下面开着的文件都跟过去；反斜杠和开头的 ./ 也认', () => {
    const { next, pairs } = renameFileTabs(base(), 'w1', '.\\src', 'lib/core/')
    expect(pairs).toHaveLength(2)
    expect(next.tabs.flatMap((t) => (t.kind === 'file' ? [`${t.workspaceId}:${t.path}`] : []))).toEqual(['w1:lib/core/a.ts', 'w1:lib/core/sub/b.ts', 'w1:srcx/c.ts', 'w2:src/a.ts'])
  })

  it('renameFileTabs：新路径上本来开着另一个标签（移动时覆盖了它），那个去掉；正看着的被去掉了就翻到跟过来的那个', () => {
    const s: PanelTabs = { tabs: [...defaultTabs().tabs, file('f1', 'a.txt'), file('f2', 'b.txt')], active: 'f2' }
    const { next } = renameFileTabs(s, 'w1', 'a.txt', 'b.txt')
    expect(next.tabs.filter((t) => t.kind === 'file')).toEqual([file('f1', 'b.txt')])
    expect(next.active).toBe('f1')
  })

  it('renameFileTabs：没有开着的受影响、或者前后是同一个路径，原样返回', () => {
    const s = base()
    expect(renameFileTabs(s, 'w1', 'other', 'x').next).toBe(s)
    expect(renameFileTabs(s, 'w1', 'src', './src/').next).toBe(s)
    expect(renameFileTabs(s, 'w3', 'src', 'lib').pairs).toEqual([])
  })
})

describe('右栏的文件换了地方 / 没了：信号先到，标签后改', () => {
  it('renameRightFiles：先把「旧身份 → 新身份」发出去（那时标签还是旧路径），再换标签；没有受影响的标签时不发', () => {
    resetRightFiles()
    updatePanelTabs(() => defaultTabs())
    openRightFile({ workspaceId: 'w1', path: 'docs/a.md' })
    const seen: { sig: RightFileSignal; pathThen: string | undefined }[] = []
    const off = onRightFileSignal((sig) => seen.push({ sig, pathThen: getPanelTabs().tabs.flatMap((t) => (t.kind === 'file' ? [t.path] : []))[0] }))
    renameRightFiles('w1', 'nothing', 'x')
    expect(seen).toEqual([])
    renameRightFiles('w1', 'docs', 'notes')
    off()
    expect(seen).toEqual([{ sig: { type: 'renamed', pairs: [['right:w1:docs/a.md', 'right:w1:notes/a.md']] }, pathThen: 'docs/a.md' }])
    expect(getPanelTabs().tabs.flatMap((t) => (t.kind === 'file' ? [t.path] : []))).toEqual(['notes/a.md'])
  })

  it('markRightFilesDeleted：只发信号，标签一个不关', () => {
    resetRightFiles()
    updatePanelTabs(() => defaultTabs())
    openRightFile({ workspaceId: 'w1', path: 'docs/a.md' })
    openRightFile({ workspaceId: 'w1', path: 'b.md' })
    const seen: RightFileSignal[] = []
    const off = onRightFileSignal((sig) => seen.push(sig))
    markRightFilesDeleted('w1', 'docs')
    markRightFilesDeleted('w1', 'none')
    off()
    expect(seen).toEqual([{ type: 'deleted', keys: ['right:w1:docs/a.md'] }])
    expect(getPanelTabs().tabs.filter((t) => t.kind === 'file')).toHaveLength(2)
  })
})
