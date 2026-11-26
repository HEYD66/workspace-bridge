# Workspace Bridge 项目文档

本文说明项目是什么、由哪些部分组成、数据存在哪、安全边界在哪。快速上手与界面预览见 [README.md](README.md)；内置浏览器与环境伪装说明见 [docs/builtin-browser.md](docs/builtin-browser.md)。

## 1. 它是什么

一个 Windows 上的 Electron 桌面应用，形态接近 VS Code：

- 把本机的一个或多个文件夹（工作区）通过 MCP 开放给 AI；另有一个内置的「整台电脑」工作区，给某个 AI 打开开关后它能按绝对路径读写本机任意盘。外部 AI（Sesame、ChatGPT、Claude.ai 网页版、arena、局域网设备上的客户端）默认用带 token 的链接（`<地址>/mcp/<token>`）直连，也可以在设置里切到 OAuth。
- 也可以直接填 API Key 接入模型（DeepSeek、通义千问、Kimi、OpenAI、Claude 等），在应用里和它对话。这类「内置 AI」和外部 AI 用同一套 MCP 工具、同一套权限。
- 接入的 AI 都是完全权限（2026-11-12 起）：全部工具、读写文件、执行命令，都不用用户批准。每个 AI 只有一个开关：能不能用整台电脑。
- 多个 AI 各用自己的身份，可以分职位协作：共享记忆、互相派任务、提交审查。
- 用户自己在应用里看代码、改文件、搜索、开终端；每个 AI 的每一步操作都实时显示在右侧活动流。

## 2. 功能清单

| 功能 | 说明 | 状态 |
|---|---|---|
| MCP 服务 | Streamable HTTP，只用 POST（不提供 SSE），默认 `http://127.0.0.1:8765/mcp` | 已验证 |
| 接入方式 | 网页 AI 认证方式 `authMode`：**link（默认）**= 和 ShunCode 一样，带 token 的链接 `/mcp/<token>` 在本机 / 局域网 / 公网都能直连，不暴露任何 OAuth 端点（Sesame 等客户端不弹登录卡片）；**oauth** = OAuth 2.1 + PKCE + 动态注册，只能在桌面批准，经隧道不接受路径令牌。两种模式都接受 `Authorization: Bearer <token>` | 单测已验证；真实 Sesame 连接待用户验收 |
| 局域网 / 公网 | 设置里开局域网（监听 0.0.0.0）；cloudflared 临时地址或自己的域名 | 已验证（真实设备未验收） |
| AI 身份 | 每个 AI 一个 token、颜色、职位、「允许用整台电脑」开关（默认关）。没有档位、命令执行开关、调用限额、工作区勾选（11-12 去掉） | 11-12，单测 + 真实应用实测通过 |
| 职位 | 只有名字和职责说明，写进给 AI 的连接说明里，不限制任何操作（11-12 起）。预设经理、架构师、开发、审查、测试、文档 | 11-12，单测通过 |
| 记忆 | 共享 + 每个 AI 私有；只有用户能置顶共享记忆，置顶内容随连接说明下发 | 已验证 |
| 任务板 | 待办 / 进行中 / 待审阅 / 完成 / 受阻；用户派的任务 AI 做完直接算完成，不用用户点通过；AI 派给 AI 的任务仍然要派活的 AI 审查通过才算完成（11-12 起）；新任务和审查结果作为【通知】附在 AI 下次工具调用的结果末尾。每个工作区一个任务板，各编各的号；任务页左侧上方可以在「当前工作区」和「整台电脑」的任务板之间切换（工作台切不到整台电脑，它的任务板只能这样看） | 已验证；看整台电脑的任务板是 11-10 加的，单测 + 真实应用实测通过 |
| 技能库 | `SKILL.md` 格式，项目级 + 用户级；放进目录或 AI 用 `install_skill` 提交后直接生效，文件被改动也不停用，用户可以手动停用（11-12 起，没有审阅这一步）。AI 提交的技能写在它调用时所在的工作区里。技能页可以选看任何一个工作区（含整台电脑）的技能，也可以导入现成的技能包（文件夹，或 `.zip` / `.skill` 文件，先预览再确认，同名默认不覆盖）；导入时可以选放进哪个工作区；技能详情里可以把技能挪到用户级或任意一个工作区的项目级 | 11-12，单测 + 真实应用实测通过；技能脚本工作台不运行，AI 可以自己用 `run_command` 跑 |
| 多工作区 | 同时开放多个文件夹，AI 用 `workspace` 参数指定；用户添加的工作区每个 AI 都能用（11-12 起不能按 AI 限定） | 已验证（11-02 起用 Sesame 实测） |
| 整台电脑 | 内置工作区（`kind: 'machine'`，不存进 workspaces 列表），每个 AI 在团队页有一个「允许用整台电脑」开关，默认关；打开后不论经本机、局域网还是隧道连接都能用；接受任意盘绝对路径，拒绝 UNC；数据目录照旧拦，凭据文件 11-12 起不拦；遍历跳过系统目录和 AppData；不能以整个盘为搜索起点、不能删 / 移整个盘；跨盘 move 自动复制后删除 | 11-05，单测通过；headless 实例实测 21/21（scripts/machine-live.ts） |
| 代码编辑 | 多根文件树、Material 文件图标、Monaco 编辑器（一个实例挂多模型）、标签页（预览/固定/拖动排序）、`Ctrl+S` 保存 + 版本冲突提示、AI 改动标记 | v0.4，已实现未验证 |
| 搜索 | 全文搜索（正则 / 大小写 / 全字 / 包含排除），`Ctrl+P` 快速打开 | v0.4，未验证 |
| 终端 | 底部面板，多标签，node-pty + xterm | v0.4，未验证 |
| 内置 AI | 填 API Key 接模型，在「对话」里聊天；可选自动接活 | v0.4，未验证（没调过真实提供方） |
| 命令执行 | `run_command` 等 4 个工具，持久 Git Bash 终端池，超时转后台；接入的 AI 都能用，不用批准（11-12 起） | 已验证（11-02 用 Sesame 实测；11-12 真实应用实测） |
| 检查点和回滚 | 改文件前自动存旧内容（不碰项目 .git），按会话 / 任务汇总改动，有冲突就整体不写 | 已验证（11-04 真实实例 + Sesame 隧道实测） |
| 截图 | 截窗口、列窗口、截本地网页 | 单测通过；Windows 上没真截过 |
| 代码诊断 | TS/JS 类型检查和语义导航（`get_diagnostics`、`lsp`） | 已实现 |
| 计划与进度 | AI 自己的待办清单和进度（只存内存，重启清空） | 已实现 |
| 隧道保留 | 关闭应用时可以让 cloudflared 继续跑，下次启动接管 | 单测通过 |
| 定时任务 | 活动栏「定时任务」。频率：每 N 分钟、每天几点（可选星期几）、一次。到点做的事：在群聊发消息（可 @ AI）、往任务板派任务（可以派到整台电脑）、给内置 AI 发消息。每个工作区有自己的列表（到点了不管开着哪个工作区都会运行）；错过的只补跑最近一次；「全部停下」期间到点的记成跳过；按本机时区。只有用户能建，没有对应的 MCP 工具 | 11-10，单测 + 真实应用实测通过；真实睡眠唤醒后的补跑没验证 |
| 急停 | 顶栏「全部停下」，所有 AI 的工具调用立刻返回 `PAUSED`，正在跑的命令取消。权限精简后这是拦住 AI 的主要办法，另外还有吊销和更换 token | 已验证 |
| 打包安装包、托盘、开机自启 | PLAN.md 的 M6 | 未开始；现在用 `start.bat` 或 `npm run dev` 启动 |

最近一次全量检查（2026-11-05）：`npm run typecheck` 0 错误，`npx vitest run` 23 个文件 400 通过 1 跳过，`npm run build` 成功。每项功能的实测细节见 HANDOFF.md。

## 3. 架构

```
外部 AI ──HTTPS──> cloudflared ──┐
局域网 AI ──HTTP──────────────────┼──> McpHttpServer（127.0.0.1 或 0.0.0.0:8765）
本机 AI ──HTTP────────────────────┘      认证 → 每个会话绑定一个 AI 身份
                                           │
内置 AI（LlmService）──InMemoryTransport───┤
                                           ▼
                                  createMcpServer(agentId)
                         急停 / 工作区（整台电脑开关） / 活动记录
                                           │
                    ┌──────────────┬───────┴──────┬──────────────┐
               FileTools       MemoryStore     TaskStore      SkillStore    （每个工作区一套）
               + PathGuard + CheckpointStore
                                           │
                 CommandRunner / ApprovalQueue / PlanStore / Screenshot（全局一套）
                                           │
                                     EventLog（活动流 + JSONL 审计）
                                           │ IPC
工作台界面（React）<──── preload（window.bridge）<──── 主进程 main/index.ts
   用户自己的文件读写、搜索、终端也走 IPC，由 Bridge / SearchService / TerminalManager 处理
```

- 工作台平时只通过 Electron IPC 和主进程通信，不开任何 HTTP 管理端口。唯一的例外是用户在设置里手动打开的「远端查看」（`src/core/remoteView.ts`，默认关）：另开一个只监听 127.0.0.1 的随机端口，把同一套界面和后端接口经一条单独的临时隧道给用户自己的手机 / 平板用；入口链接带 32 位随机口令，进来后换成 cookie，每次开启都换口令和地址，关闭后立刻失效。拿到链接的人能做桌面窗口里能做的所有事。隧道和局域网只能碰到 `/mcp` 和 OAuth 路由（link 模式下连 OAuth 路由也没有，`/.well-known/*` 一律 404）。
- cloudflared 固定用 `--protocol http2`（TCP 443），不走 QUIC，避免 TUN 代理 / 限 UDP 网络下隧道时通时断。
- `src/core/` 不依赖 Electron，主进程和 headless 模式（`npm run headless`）共用。Electron 特有的东西（`net.fetch`、`safeStorage`、对话框、剪贴板）由主进程注入。
- 内置 AI 通过 `bridge.createAgentServer(agentId)` 拿到和 HTTP 会话完全一样的 MCP 服务，再用 SDK 的 `InMemoryTransport` 连一个 MCP Client，把工具列表交给模型。所以内置 AI 和外部 AI 的权限规则只有一份。

## 4. 代码结构

```
src/core/                 不依赖 Electron
  bridge.ts               组装一切：配置、工作区运行时、MCP 服务、OAuth、隧道、活动日志；工作台调用的方法都在这里
  mcpServer.ts            全部 MCP 工具；register() 统一做急停、工作区解析（整台电脑开关）、活动记录、通知
  httpServer.ts           Streamable HTTP、token / OAuth 认证（linkMode 选项切换链接直连）、会话绑定身份、Host / Origin 校验
  oauth.ts                OAuth 2.1 授权服务（PKCE、动态注册、配对码授权页、token 签发 / 轮换 / 吊销）
  tunnel.ts               cloudflared 进程管理（含关闭应用时保留隧道、下次接管）
  config.ts               config.json 读写和旧配置迁移
  fileTools.ts            文件读写：version 冲突检测、GBK、CRLF、回收站
  trash.ts                回收站：列出、恢复到原位置、彻底删除（往里放的是文件工具、补丁、检查点回滚、技能）
  pathGuard.ts            路径越界、符号链接、数据目录拦截（AI 不拦凭据文件和 .git，用户界面拦 .git）；mode 'agent' / 'user'；machine 模式（整台电脑）
  patchApplier.ts         apply_patch 的补丁解析和多文件写入
  checkpoints.ts          检查点：改前快照、改动汇总、回滚
  commandRunner.ts        run_command 系列：持久 bash 终端池、后台命令、环境变量白名单
  plans.ts                set_todos / update_plan / report_progress（只存内存）
  codeIntel.ts            get_diagnostics / lsp（TS 语言服务）
  screenshot.ts           截窗口（PowerShell + PrintWindow）、截本地网页（无头 Edge / Chrome）
  imageInfo.ts            read_image 的图片尺寸解析
  redact.ts               活动流和审计落盘前把令牌换成 [REDACTED]
  memory.ts  tasks.ts     记忆、任务板
  roles.ts                预设职位（名字 + 职责说明）
  skills.ts               技能库：扫描、frontmatter、手动停用、install、importPackage（用户导入）、changeScope（挪到用户级，或某个工作区的项目级）
  skillImport.ts          导入现成的技能包：在文件夹或 zip 里找含 SKILL.md 的目录、定名字
  zipReader.ts            最小的 zip 读取（只读、内存里解，不落盘；不支持 zip64 和加密）
  search.ts               工作台的全文搜索和文件列表（SearchService）；有 ripgrep 时走 ripgrep.ts，结果逐条过 PathGuard.isAllowedResult
  ripgrep.ts  fastRead.ts ripgrep 查找和调用（JS 正则转 rg 写法、.git 和数据目录的排除 glob）；共用的读文件（4 次 IO、二进制扩展名）
  threadpool.ts           入口第一个 import：UV_THREADPOOL_SIZE=16
  chat.ts                 群聊：每频道一个 jsonl（大厅 general、工作区 ws:<id>），已读游标、@ 解析、wait、归档
  processTools.ts         list_processes / kill_process（保护名单：系统进程、工作台自己和子进程、隧道）
  overview.ts             概览统计（CallStats：24 小时调用，启动时从审计补）
  auditReader.ts          审计日志查询、统计、导出 CSV
  rateLimit.ts            每个 AI 的调用限额（滑动窗口，内存）
  scheduler.ts            定时任务：算下次运行时间、到点执行、补跑和跳过、存 schedules.json；动作的校验和执行在 bridge.ts（saveSchedule / normalizeScheduleAction）
  backup.ts  diagnostics.ts 设置备份与恢复（不导出 API Key）、诊断报告（不含 token）
  connectTest.ts  playground.ts 接入向导的「测试连接」、工具试用台（都用 AI 自己的 token 走真实 HTTP）
  terminal.ts             内嵌终端（TerminalManager，node-pty）
  llm/                    内置 AI：providers.ts 请求和流式解析，store.ts 提供方和模型绑定，runner.ts 执行循环，service.ts 对话会话和自动接活
  events.ts  jsonStore.ts  encoding.ts  headless.ts  types.ts
src/shared/
  api.ts                  window.bridge 的接口类型
  tools.ts                MCP 工具目录（名字、分组、说明）和 toolAllowed / effectiveTools，主进程和界面共用
src/main/index.ts         Electron 主进程和全部 IPC（只接受本窗口发来的调用）
src/preload/index.ts      window.bridge，必须输出 CJS（窗口开了 sandbox）
src/renderer/src/
  App.tsx                 VS Code 式外壳：活动栏、侧栏、主区、底部终端、右侧活动流、顶栏、状态栏、快捷键
  lib/nav.ts              分区和选中条目的导航状态（navigate / useNav）
  lib/editorStore.ts      打开的文件和标签页（openFile / useEditor）
  lib/monaco.ts           Monaco 初始化：语言推断、深色主题、内联 worker
  lib/useBridge.ts  format.ts  markdown.ts
  views/                  FilesView（转发出口）、ExplorerPanel（多根文件树）、EditorArea（标签页 + 编辑区）、SearchView、ChatView、TerminalView、TasksView、MemoryView、SkillsView、TeamView、SettingsView、ActivityPanel、
                          OverviewView（概览）、GroupChatView（群聊频道）、CommandsView（AI 命令）、ChangesView（改动/回滚）、AuditView（审计日志）、PlaygroundView（工具试用）、
                          SchedulesView（定时任务：侧栏列表 + 编辑页；按工作区分列表的规则是里面的 isStray / schedulesInWorkspace / ownerForSave）
  components/             CommandPalette、ConnectGuide（接入向导）、BackupCard、QuickOpen 等
  App.tsx 注意            App 里「state 还没到」那个提前 return 之后不能再写 hook（会 React #310 白屏）
  components/             ui（通用组件）、CodeEditor（Monaco 封装）、DiffView、FileIcon、QuickOpen、WorkspaceSwitcher、ModelProviders、AgentModel、OAuthApproval（OAuth 连接确认）、EventItem
scripts/e2e-smoke.ts      端到端冒烟：启动 Electron，MCP 客户端模拟 AI，通过 CDP 操作界面并截图
scripts/tunnel-smoke.ts   真实 cloudflared 隧道冒烟
scripts/checkpoint-smoke.ts  临时实例（18767 端口）上测检查点和回滚
scripts/checkpoint-live.ts   连真实工作台测检查点
scripts/screenshot-smoke.ts  截图冒烟
tests/                    vitest 单元和集成测试
start.bat                 双击启动：清掉 ELECTRON_RUN_AS_NODE，缺依赖时安装，构建后启动
```

## 5. MCP 工具

工具目录以 [src/shared/tools.ts](src/shared/tools.ts) 为准，目前 56 个：

| 分组 | 工具 |
|---|---|
| 身份与团队 | `whoami` `team_list` `list_workspaces` `wait_for_resume`（「全部停下」期间等用户恢复） |
| 文件读取 | `list_dir` `read_file` `read_files` `search` `find_files` `file_info` `read_image` |
| 代码诊断 | `get_diagnostics` `lsp` |
| 截图 | `screenshot` |
| 文件修改 | `write_file` `edit_file` `apply_patch` `mkdir` `move` `delete`（进回收站） `trash_list` `trash_restore`（放回原位置） `trash_empty`（彻底删除，恢复不了） |
| 检查点与回滚 | `checkpoint_list` `changes_summary` `checkpoint_rollback`（`only_step` 只退单独一步） |
| 命令执行 | `run_command`（bash / PowerShell，可带 env） `get_command_output`（可 wait_for 等输出） `send_command_input` `cancel_command` `list_commands` |
| 进程和端口 | `list_processes` `kill_process`（工作台自己和系统进程不能结束） |
| 群聊 | `chat_channels`（大厅 + 能用的工作区频道） `chat_send`（发到频道 / 私聊，@名字 点名） `chat_read` `chat_wait`（挂着等新消息，最长 60 秒） |
| 计划与进度 | `set_todos` `update_plan` `report_progress` |
| 记忆 | `memory_search` `memory_read` `memory_save` `memory_delete` |
| 任务 | `task_list` `task_get` `task_create` `task_claim` `task_update` `task_review` `task_assign` `task_delete`（任何任务都能删） |
| 技能 | `list_skills` `load_skill` `read_skill_resource` `install_skill` |

- 除了 `whoami`、`team_list`、`list_workspaces`、`wait_for_resume`、`trash_list`、`trash_empty` 等和工作区无关的工具，每个工具都有可选参数 `workspace`（名字或 id），不传用这个 AI 的默认工作区。
- `read_file` 返回 `version`，`write_file` / `edit_file` 带 `expected_version`；别人先改了就返回 `CONFLICT`，不会静默覆盖。
- `read_file` 单次回包不超过 256 KB，超了按行截断并给 `next_start_line`；`read_files` 一次最多 20 个文件、总共 256 KB；`search` 默认每文件 20 处、总共 100 处，带 `truncated_reason`；`find_files` 只走目录不读内容。
- **命令执行**：接入的 AI 都能用 `run_command`、`send_command_input`，不用批准。命令没有沙箱，只拿 `ENV_ALLOWLIST` 里的环境变量；只拦工作台数据目录（存着令牌）。
- `run_command` 前台默认等 30 秒（`timeout_ms` 最长 120 秒），到时间返回 `status=running` 和命令 id，不杀进程。
- 工具结果是 JSON 文本（`read_file` 例外：文本头 + `---` + 原文）。给 AI 的【通知】是结果里单独的最后一个文本块，不拼在 JSON 后面。
- 开关「整台电脑」不断开会话，下一次调用就生效并带通知。添加或移出工作区、手动断开、闲置 30 分钟会关会话：旧会话再请求得到 404，`error.data` 里有 `code: SESSION_CLOSED` 和 `reason`。
- 回收站是整个工作台共用的（`src/core/trash.ts`）；条目清单里的 `absPath` 是原来的绝对位置，恢复靠它。
- 握手时返回的 instructions 里有：使用规则、这个 AI 的身份和职位职责、能用的工作区、置顶记忆、分给它的任务、可用技能。
- 加新工具：在 `mcpServer.ts` 里用 `register()`（或 `tool()` / `coord()`）注册，同时加进 `tools.ts` 的 `TOOL_CATALOG`。

常见错误码：`PAUSED` `REVOKED` `CONFLICT` `OUTSIDE_WORKSPACE` `PROTECTED`（文件工具和命令碰数据目录都是这个；11-12 起没有 `PROTECTED_PATH` 了） `ALREADY_EXISTS` `TOO_MANY_COMMANDS` `NOTHING_TO_ROLLBACK` `WORKSPACE_FORBIDDEN`（没开整台电脑的开关） `WORKSPACE_NOT_FOUND` `NO_WORKSPACE` `REVIEW_REQUIRED`（AI 派给 AI 的任务不能直接完成） `SKILL_NOT_FOUND` `SKILL_NOT_ENABLED`（用户手动停用了）。11-12 去掉的：`TOOL_DISABLED` `READ_ONLY` `ROLE_FORBIDDEN` `EXEC_DISABLED` `PENDING_APPROVAL` `SKILL_CHANGED_SINCE_ENABLED`，以及文件工具对凭据文件的 `SENSITIVE_FILE`。

## 6. 权限和安全边界

2026-11-12 用户要求精简权限：去掉所有要用户审批的地方，工作区只分「用户添加的工作区」和「整台电脑」，接入的 AI 都是完全权限。现在对 AI（外部和内置都一样），一次工具调用只检查：

1. 身份没被吊销
2. 没有急停（「全部停下」）
3. 工作区：用户添加的工作区都能用；整台电脑要这个 AI 的「允许用整台电脑」开关打开（默认关），否则 `WORKSPACE_FORBIDDEN`
4. 路径守卫：不能越出工作区（含经符号链接、junction 越出；整台电脑工作区接受任意盘绝对路径，拒绝 UNC）；应用数据目录拒绝（`PROTECTED`，里面有令牌）；不能删、移整个盘。`.env`、私钥、`.git` 内部文件工具都能读写（和命令行一致）；搜索和遍历跳过 `.git` 目录

没有档位、命令执行开关、调用限额、工具开关、审批队列、技能审阅。仍然留着的限制：

- `kill_process` 不能结束工作台自己和系统进程；命令和文件工具都碰不到数据目录。
- 群聊每个 AI 每分钟最多发 20 条（防止两个 AI 互相刷屏），不能设置。
- AI 派给 AI 的任务要派活的 AI 审查；不能审查自己的交付。
- OAuth 模式下新客户端连接要在桌面核对配对码后批准（这是「让不让连进来」，不是对操作的审批）；默认的链接直连没有这一步。
- 技能包里的附带文件不能用凭据文件的名字（`install_skill` 会拒绝）。用户自己在技能页导入的技能包不受这一条限制。

**风险**：拿到任何一个 AI 的连接链接的人（包括经公网隧道），都能在这台电脑上读写用户添加的工作区、执行任意命令（命令不受工作区限制，以当前 Windows 用户的权限运行）。链接等同于这台电脑的登录密码。拦住的办法只有「全部停下」、吊销、更换 token、关隧道。

**旧配置**：升级后第一次启动时，旧的档位、命令执行开关、限额、工作区勾选、全局停用工具、职位权限读进来就丢了；勾过整台电脑的 AI 开关保持打开，其余是关。旧配置原样留一份在数据目录的 `config.before-simplify.json`（只留一次）。

用户自己在工作台的操作（文件树、编辑器、搜索）只拦 `.git` 内部和应用数据目录，能看能改凭据文件。用户的写入以「你」（灰色）记进活动流。

工作台底部的终端以当前 Windows 用户的权限运行，不受任何限制，AI 没有途径调用它（AI 的命令走 `run_command` 自己的终端池）。

其他约束：

- 共享记忆的置顶只有用户能设，防止一个 AI 往所有 AI 的提示里塞指令。
- 默认 link 模式：链接里的 token 是 `wb_` + 32 位 base64url（192 位随机数），链接等同密码；泄露后在成员详情「更换 token」即作废旧链接。认证时路径令牌优先于 Authorization 头。切换 authMode 立即生效（每个请求都重新认证），切到 link 时拒掉未批准的 OAuth 请求。
- OAuth 模式只能在桌面批准：授权页只显示配对码，没有「同意」按钮；token 只存哈希。
- 技能没有审阅：AI 用 `install_skill` 写的技能别的 AI 马上能加载，内容没有人看过。用户可以在技能页手动停用或删除。
- 内置 AI 的 API Key 只存在主进程，用 Electron `safeStorage` 加密（不可用时明文），不发给界面。
- 开关某个 AI 的「允许用整台电脑」、增删工作区、更换 token、吊销，都会断开受影响 AI 的会话，让它重新握手拿新的说明。
- 换职位、改职位的职责说明不断开：只给它留一条通知，让它调 whoami 看新职位。内置 AI 一律发 'reset'，下一轮重建。

## 7. 数据存放

数据目录默认 `%APPDATA%\workspace-bridge\bridge`，环境变量 `WB_DATA_DIR` 可以改。

```
config.json                 AI 身份（含明文静态 token）、职位、工作区列表、当前工作区、端口、局域网、隧道（含 token）
config.before-simplify.json 权限精简前的 config.json 原样副本（含明文 token；只在从旧版本升级时出现，只留一次）
oauth.json                  OAuth 客户端和授权（token 只存哈希）
llm.json                    模型提供方（API Key 加密）和每个 AI 的模型绑定
chats/<agentId>.json        内置 AI 的对话记录
workspaces/<路径哈希>/       每个工作区一个：workspace.txt（路径）、memory.json、tasks.json、skills.json（项目级技能状态）、checkpoints/（blobs/ + index.json）
schedules.json              定时任务（全部工作区的都在这一个文件里，每条记着所属工作区 workspaceId）
user-skills.json            用户级技能状态
skill-pins/                 旧版本留下的技能快照，11-12 起不再使用，可以删
trash/                      回收站
audit/YYYY-MM-DD.jsonl      审计日志
electron/                   只在设了 WB_DATA_DIR 时出现：Electron 的 userData
```

- 工作区 id 是 `w_` 加路径哈希的前 8 位，同一个文件夹移出再加回来 id 不变，数据也还在。整台电脑的 id 固定（`MACHINE_WORKSPACE_ID`），数据目录哈希用单独的种子，和「主目录」这类普通工作区分开。
- 检查点保留上限 2000 个 / 14 天 / 1 GB，单文件超过 20 MB 不存。
- 技能文件本身在 `<工作区>/.bridge/skills/<名字>/` 和用户级 `~/.workspace-bridge/skills/<名字>/`（`WB_USER_SKILLS_DIR` 可改）。
- `config.json` 里有明文 token，不要分享数据目录。

## 8. 开发

```bash
npm install
npm run dev          # 开发模式，界面热更新；改了主进程或 preload 要重启
npm run typecheck
npm test             # vitest
npm run build        # 输出到 out/
npm start            # 运行 out/ 里的构建产物
npx tsx scripts/e2e-smoke.ts .e2e-out   # 先 build
npx tsx scripts/tunnel-smoke.ts
npm run headless -- --workspace D:/某个目录 --workspace D:/另一个目录
npm run headless -- --machine   # 只开整台电脑，不传 --workspace
```

或者双击 `start.bat`（每次先构建再启动，不是开发模式）。

约定：

- 界面文案用中文，简短、说人话；深色主题的颜色类见 `index.css`，通用组件在 `components/ui.tsx`。
- `Field` 组件不用 `<label>`（`<label>` 会把点击转给里面第一个按钮）。
- 共享类型放 `src/core/types.ts`（不能引入 Node 模块），界面接口放 `src/shared/api.ts`，三处同步：`api.ts`、`preload/index.ts`、`main/index.ts` 的 IPC。
- 主进程的 IPC 只接受本窗口发来的调用（`e.sender === win.webContents`），参数在主进程里再校验一遍类型。
- 依赖：`@modelcontextprotocol/sdk`、`zod`、`diff`、`iconv-lite`、`monaco-editor`、`@xterm/*`、`node-pty`（原生模块，自带 win32-x64 预编译）、`marked`、`dompurify`、`material-icon-theme`（只用它的图标和映射表）。
