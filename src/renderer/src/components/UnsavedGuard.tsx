// 有没保存的改动时关窗口要先问一句。两处编辑器都算：「文件」页的编辑区和右栏的文件标签。
// 电脑上的窗口：把没保存的文件名单告诉主进程，关窗口时由它弹系统对话框（src/main/index.ts 的 close 处理）。
// 远端的浏览器：用浏览器自己的「离开此页？」提示
import { useEffect, useMemo } from 'react'
import { useEditor } from '../lib/editorStore'
import { useRightFiles } from '../lib/rightFiles'
import { fileTabKey, usePanelTabs } from '../lib/rightTabs'

export function UnsavedGuard(): null {
  const editor = useEditor()
  const right = useRightFiles()
  const panel = usePanelTabs()
  const names = useMemo(() => {
    const list = editor.tabs.filter((t) => t.dirty).map((t) => t.path)
    for (const t of panel.tabs) if (t.kind === 'file' && right.dirty.has(fileTabKey(t))) list.push(t.path)
    return [...new Set(list)]
  }, [editor.tabs, right.dirty, panel.tabs])
  const sig = names.join('\n')

  useEffect(() => {
    // 给脚本看的（上线切换前先查一下，有没保存的就不去关旧窗口）：<html data-unsaved-files="2">
    document.documentElement.setAttribute('data-unsaved-files', String(sig ? sig.split('\n').length : 0))
    if (!window.bridge.isRemote) {
      void window.bridge.setUnsaved(sig ? sig.split('\n') : []).catch(() => undefined)
      return
    }
    if (!sig) return
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [sig])
  return null
}
