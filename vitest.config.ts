import { defineConfig } from 'vitest/config'

// 不少测试会起真实进程（bash、PowerShell、ripgrep、node 子进程、Electron 之外的 HTTP 服务），
// 全量并行跑 30 多个文件时机器很忙，默认 5 秒的单测超时经常不够，偶发失败。放宽到 30 秒
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 同时最多跑 4 个测试文件。不限的话 60 多个文件一起启动，开头那一阵机器过载，起真实进程的测试会偶发失败
    // （11-14 实测：不限时 pageInteract 的浏览器清理每次都失败，commandCharacters 也失败过一次，整套 102～106 秒；
    // 限成 4 个全部通过，整套 86 秒，反而更快）
    maxWorkers: 4
  }
})
