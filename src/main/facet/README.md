# 从千面 Facet 原样迁入的指纹与环境模块

来源：[千面 Facet](https://github.com/HEYD66/facet)（v0.2.24，MIT License），
提交 `fbf3a8f`（2026-11-11），`src/main/` 下的同名文件（共 12 个文件）。

| 文件 | 干什么 |
|---|---|
| `fingerprint.cjs` | 设备预设、指纹设置的校验、生成一套指纹（`preset`）、拼出注入脚本（`script`）、UA 和 UA-CH |
| `fingerprint-catalog.cjs` + `fingerprint-catalog.json` | 设备库：显卡、屏幕、CPU 线程数、内存怎么搭配才像一台真电脑 |
| `gpu-identity.cjs` | 显卡的渲染器字符串、WebGPU 信息 |
| `fingerprint-inject.js` | 注入网页的脚本：screen、deviceMemory、WebGL / WebGPU、Canvas 和音频加噪 |
| `environment-contexts.cjs` + `environment-target-readiness.cjs` | 页面里的 iframe 和 Worker 也套上同一套 |
| `environment-service-worker.cjs` | Service Worker 也套上同一套 |
| `webrtc-policy.cjs` | WebRTC 策略：不走代理的 UDP 不发，真实 IP 不会经 WebRTC 漏出去 |
| `ip-services.cjs` + `network-error.cjs` | 问出口 IP 在哪国、什么时区（几家查询服务轮着问） |
| `exit-locale.cjs` | 出口在哪国，就用那国的时区和常用语言 |

怎么用的：`src/main/browserGuests.ts` 用 `require` 加载它们（构建时由 `electron.vite.config.ts` 里的
`wb-copy-facet` 原样拷到 `out/main/facet/`，不打包——它们之间互相 `require`，还要按路径读旁边的文件）。

**别在这里改。** 要更新就从 Facet 重新拷一遍，再跑 `tests/builtinBrowser.test.ts` 和 `scripts/verify-browser-fp.mjs`。

前 8 个是 02:20 拷的，后 4 个是 03:15 补的（用户拿 ipip.la 的伪装检测一测只有 60 分：WebRTC 漏真实 IP、时区和语言跟出口对不上）。

照着 Facet 的写法在 `browserGuests.ts` 里重写、没有原样搬的：权限白名单（`controller.cjs` 里那几行）、关 DNS 预取
（`browser-network-policy.cjs` 里的 `dnsPrefetchingEnabled=false`）、`applyEnvironment`（`environment.cjs`，去掉了视口那一步）。

没有搬的：每个实例一个 mihomo 内核和节点订阅、视口和缩放（`viewport.cjs`）、Shared Worker（依赖 Facet 自己的浏览器通道）、
拼写词典延后下载、扩展、多实例。右栏的内置浏览器只有一套环境；走哪条路由「代理」设置定（默认跟系统代理，也可以填 Facet 的节点端口）。
