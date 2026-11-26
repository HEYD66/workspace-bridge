// 技能页看哪个工作区的技能。
// 项目级技能跟着工作区走，AI 用 install_skill 提交的技能写在它自己的工作区里，不一定是工作台当前打开的那个
// （AI 可能写进整台电脑，而工作台切不到整台电脑）。所以技能页可以单独选一个工作区来看，不动当前工作区。
import { useSyncExternalStore } from 'react'

interface WorkspaceLike {
  id: string
  name: string
  kind?: string
  /** 目录现在是否存在；不给按存在算 */
  exists?: boolean
}

interface ScopeState {
  activeWorkspaceId?: string
  workspaces: WorkspaceLike[]
}

// ---------- 用户选的工作区（活动面板的「在技能页打开」、技能页的下拉框都会改它，所以放在组件外面） ----------

let chosen: string | undefined
const listeners = new Set<() => void>()

/** 技能页改看这个工作区的技能；不给 = 跟着当前工作区 */
export function setSkillWorkspace(id: string | undefined): void {
  const next = id || undefined
  if (next === chosen) return
  chosen = next
  for (const l of listeners) l()
}

export function getSkillWorkspace(): string | undefined {
  return chosen
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 用户选的工作区 id（原样，还没和工作区列表核对；核对用 skillViewWorkspace） */
export function useSkillWorkspace(): string | undefined {
  return useSyncExternalStore(subscribe, getSkillWorkspace, getSkillWorkspace)
}

// ---------- 规则（纯函数，tests/skillScope.test.ts） ----------

/**
 * 技能页现在看的是哪个工作区的技能。返回 undefined 是当前工作区；返回 id 是别的工作区（调接口时要带上它）。
 * 选的工作区已经被移出、目录不在了，或者就是当前工作区：都按当前工作区看
 */
export function skillViewWorkspace(chosenId: string | undefined, state: ScopeState): string | undefined {
  if (!chosenId || chosenId === state.activeWorkspaceId) return undefined
  const w = state.workspaces.find((x) => x.id === chosenId)
  return w && w.exists !== false ? w.id : undefined
}

export interface SkillWorkspaceOption {
  id: string
  name: string
  /** 工作台的当前工作区 */
  current: boolean
  machine: boolean
}

/** 技能页能选的工作区：目录还在的，按工作区列表的顺序（整台电脑在最后） */
export function skillWorkspaceOptions(state: ScopeState): SkillWorkspaceOption[] {
  return state.workspaces
    .filter((w) => w.exists !== false)
    .map((w) => ({ id: w.id, name: w.name, current: w.id === state.activeWorkspaceId, machine: w.kind === 'machine' }))
}
