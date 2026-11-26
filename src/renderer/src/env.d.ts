import type { BridgeApi } from '../../shared/api'

declare global {
  interface Window {
    bridge: BridgeApi
    /** 只有本机窗口才有（远端查看时没有）：拖进来的文件在硬盘上的位置 */
    wbLocal?: { pathOfFile(file: File): string }
  }
}

export {}
