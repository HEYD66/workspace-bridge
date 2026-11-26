# 内置浏览器：环境伪装、CDP、AI 怎么用

右栏的网页标签是 Electron 自带的 Chromium。这份文档讲三件事：环境是怎么伪装的、CDP 怎么开的、AI 是怎么知道并用上它的。
代码：`src/main/browserGuests.ts`、`src/shared/browser.ts`、`src/renderer/src/views/BrowserTab.tsx`、`src/main/facet/`。

## 环境伪装

目标是和千面 Facet 的一个实例一样。拿 `https://ipip.la/disguise.html` 量：第一版（只有硬件指纹）60 分，
补上网络和地区之后在同一条线路上 100 分（2026-11-15，系统代理出口在美国）。

| 项 | 做法 | 来历 |
|---|---|---|
| 硬件指纹 | 显卡、屏幕、CPU 线程数、内存从设备库挑一套；Canvas、音频加固定噪声；UA 是普通 Chrome | `facet/fingerprint*.cjs` 等，原样 |
| WebRTC | `disable_non_proxied_udp`：不走代理的 UDP 不发，真实公网 IP、本机网卡地址都漏不出去 | `facet/webrtc-policy.cjs`，原样 |
| 时区和语言 | 跟出口 IP 走：经网页自己那条路去问出口在哪国，用当地时区和常用语言（`navigator.language`、`Intl`、`Accept-Language` 一致） | `facet/ip-services.cjs`、`exit-locale.cjs`，原样 |
| 权限 | 白名单：网页复制、读用户选中的文件可以；通知、摄像头、麦克风、定位、读剪贴板默认拒绝 | 照 Facet `controller.cjs` |
| DNS 预取 | 关掉：不然 Chromium 会绕过代理、用本机 DNS 去查页面里的域名 | 照 Facet `browser-network-policy.cjs` |
| 代理 | 默认跟系统代理；可以填 `direct` 或一个代理地址（比如 Facet 的节点端口） | 照 Facet 的 `setProxy` |

- **只有一套**，全部标签共用，存在 `<数据目录>/browser.json`。硬件那一套种子固定，每次重开都一样，点「换一套」才变。
- **什么时候装**：网页先停在空白页，主进程把 WebRTC 策略、时区语言、指纹都装好才加载真正的地址（`prepareBrowserTab`），
  所以第一页的第一段脚本、第一个请求看到的就是伪装后的。装不上时网页不会自己打开，会提示原因，由用户点「照样打开」。
- **出口地区**：存着的 10 分钟内直接用；过期了先用旧的、后台重查；从没查到过时第一个标签最多等 6 秒。
  查不到（断网、查询服务都不通）时时区和语言用系统的，标签上会提示一下。换了节点要在设置里点「重新查」。
- **iframe、Worker、Service Worker** 也是同一套。
- **在哪改**：右栏「+」→ 新标签页最下面的「浏览器」：指纹（开关、换一套）、时区和语言跟出口 IP 走（开关、重新查）、网络（现在怎么走、代理）、CDP。
  改动对之后打开的标签生效，已经开着的要关掉重开。
- **没有的**：每个实例一个代理内核和节点订阅（这里只能填一个现成的代理地址）、视口和缩放模拟、Shared Worker、扩展、多实例。
  DNS 由代理那一头解析：系统代理（Clash 之类）自己怎么查 DNS，这里管不到。
- 环境变量 `WB_EXIT_PROBE_URL`：`off` 不查出口；设成一个地址就只问它（验收脚本用）。

## CDP

- **默认打开**，只监听 `127.0.0.1`。端口默认 `9333`；被占用就往后找，最多找 10 个；都被占着这次就不开。
  实际地址显示在新标签页最下面的「浏览器」里，可以复制。
- **怎么定端口**（启动时，按顺序）：命令行带了 `--remote-debugging-port` 就用它的；环境变量 `WB_CDP_PORT`（`off` 不开，数字是指定端口）；
  `browser.json` 里的 `cdp.enabled` / `cdp.port`。
- **开关要重启才生效**：远程调试端口是进程启动参数。界面上改了开关会提示。
- **它是整个应用的调试端口**：`/json/list` 里除了网页标签（`type: "webview"`），还有工作台自己的界面（`type: "page"`，`app://bundle/…`）。
  能连上这个端口的本机程序，等于能操作工作台本身。用户明确说了安全上不设限，所以没有另做只暴露网页标签的网关。
- 没有加 `--remote-allow-origins`：带 `Origin` 头的 WebSocket 连接会被 Chromium 拒绝（浏览器里的网页连不进来）。脚本连接时别带这个头。

## AI 怎么知道、怎么用

三处告知，从粗到细：

1. **握手说明**（每个 AI 一连上就看到）：多了一节「内置浏览器」，写着 CDP 地址和先调哪个工具。
2. **`browser_info` 工具**：现状（CDP 地址、开着的标签和每个的 ws 地址、指纹开没开）加一段用法说明和能直接跑的例子。
3. **这份文档**和新标签页上的地址，给人看。

三个工具（工具目录里的「内置浏览器」一组）：

| 工具 | 干什么 |
|---|---|
| `browser_info` | 现状和用法。操作网页前先调一次 |
| `browser_open { url, focus? }` | 在右栏开一个标签（用户看得见），等加载完，返回 `tab`、`target`、`ws`。`focus: false` 在后台开 |
| `browser_close { tab }` | 关一个标签 |

操作网页本身不走工具，走 CDP：连 `ws` 地址发 `Page.navigate`、`Runtime.evaluate`、`Input.*`、`Page.captureScreenshot` 等。
不在这台电脑上的 AI（经隧道接进来的）连不到 `127.0.0.1`，要用 `run_command` 在这台电脑上跑脚本去连。

给 AI 的注意事项都写在 `browser_info` 的 `usage` 里（`src/shared/browser.ts` 的 `browserUsage`）：别碰 `type: "page"` 的那个 target、
别用 `Target.createTarget`、别改视口、指纹开着时别再覆盖 UA。

## 验证

- `tests/builtinBrowser.test.ts`：设置的读写、端口怎么选、说明文字、Facet 模块、三个工具（用假的浏览器实现）。
- `scripts/verify-browser-fp.mjs`（隔离实例，启动三次，不依赖外网——出口查询指到脚本自己起的服务）：指纹、时区、语言在第一页、iframe、Worker、
  第二个标签、开着开发者工具时都生效；WebRTC 没有 UDP 候选；权限默认拒绝；换一套、各个开关；代理设置（走代理、直连、跟系统）；
  CDP 默认开、端口被占时换下一个、关掉后不开；握手说明和三个工具。
- 对着真实检测站：`_smoke_out/arena-sbx/ipip-check.mjs <构建目录> <标记>` 在隔离实例里打开 `ipip.la/disguise.html`，把结果和截图存到 `_smoke_out/arena-sbx/look/`。
  它走这台电脑当时的线路，分数会随线路变，不进自动检查。

## 没做、没验的

- 检测站只跑了 ipip.la 一家（伪装检测 100 分，WebRTC 专项「无候选」，DNS 专项「未检测到 DNS 服务器」——它没法判断）。别的检测站没跑。
- Shared Worker 没套环境；Service Worker 的 UA-CH 是原生的（Facet 里也是这样）。
- `navigator.languages` 只有一项（比如 `["en-US"]`），真的 Chrome 一般是 `["en-US","en"]`；这是照 Facet 的做法，没改。
- 已经开着的标签不会跟着「换一套」变。
- AI 没有「在已有标签里跳转」的工具，要跳转用 CDP 的 `Page.navigate`。
