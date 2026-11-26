import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { createBridgeApi } from '../shared/bridgeClient'

// 方法名和通道名的对应表在 src/shared/bridgeClient.ts（远端查看的浏览器也用它），这里只负责把它接到 Electron 的 IPC 上
const api = createBridgeApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})

contextBridge.exposeInMainWorld('bridge', api)

// 只有本机窗口才有的小工具（手机、浏览器里远端查看时没有）：从电脑上拖进来的文件，它在硬盘上的位置
contextBridge.exposeInMainWorld('wbLocal', {
  pathOfFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
})
