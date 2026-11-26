/**
 * 「这个工作区给哪些 AI 用」的选择框：加工作区时选完文件夹弹出来，设置页的工作区行上也能打开。
 * 框本身是 App 里挂着的 WorkspaceMembersDialog，这里只负责叫它出来
 */
export type WorkspaceDialogRequest = { kind: 'add'; root: string } | { kind: 'members'; workspaceId: string }

type Listener = (r: WorkspaceDialogRequest) => void
let listener: Listener | null = null

/** WorkspaceMembersDialog 挂上时登记；返回取消登记的函数 */
export function onWorkspaceDialog(l: Listener): () => void {
  listener = l
  return () => {
    if (listener === l) listener = null
  }
}

/** 添加工作区：先选文件夹，再选哪些 AI 能用。取消选文件夹什么都不做；框没挂上时按「谁都不给」加，之后在设置里选 */
export async function addWorkspaceFlow(): Promise<void> {
  const root = await window.bridge.pickWorkspaceFolder()
  if (!root) return
  if (listener) listener({ kind: 'add', root })
  else await window.bridge.addWorkspaceAt(root, [])
}

/** 改已有工作区能用的 AI */
export function editWorkspaceMembers(workspaceId: string): void {
  listener?.({ kind: 'members', workspaceId })
}
