// 接入向导：选地址 → 按客户端生成配置片段。纯函数，界面（ConnectGuide）和主进程的「测试连接」共用同一套地址规则
//
// token 放哪（和 httpServer 的规则一致）：
// - 链接直连模式（link）：本机、局域网、公网都用 /mcp/<token> 路径令牌
// - OAuth 模式：本机用路径令牌；局域网、公网在隧道开着时不接受路径令牌，统一用 Authorization: Bearer 请求头

export type ConnectWhich = 'local' | 'lan' | 'public'

/** ConnectionInfo（shared/api.ts）里用到的字段；core 也能传进来 */
export interface ConnectSource {
  url: string
  token: string
  lanUrls: string[]
  publicUrl?: string
  authMode: 'link' | 'oauth'
  /** 工作台自带的 stdio 桥（数据目录里的 stdio-bridge.cjs）的绝对路径；写不出来时没有 */
  stdioBridge?: string
}

export interface ConnectTarget {
  which: ConnectWhich
  label: string
  /** 填进客户端的地址：路径令牌时带 /<token> */
  url: string
  /** 不带 token 的地址 */
  baseUrl: string
  /** 要用请求头认证时给 token（片段里写 Authorization: Bearer） */
  bearer?: string
}

export const SERVER_KEY = 'workspace-bridge'

/** 能选的地址：本机一直有；局域网开着才有（第一个 IP）；公网隧道运行中才有 */
export function connectTargets(src: ConnectSource): ConnectTarget[] {
  const link = src.authMode === 'link'
  const make = (which: ConnectWhich, label: string, base: string): ConnectTarget => {
    const pathToken = link || which === 'local'
    return pathToken ? { which, label, url: `${base}/${src.token}`, baseUrl: base } : { which, label, url: base, baseUrl: base, bearer: src.token }
  }
  const out = [make('local', '本机', src.url)]
  if (src.lanUrls[0]) out.push(make('lan', '局域网', src.lanUrls[0]))
  if (src.publicUrl) out.push(make('public', '公网', src.publicUrl))
  return out
}

export function pickTarget(src: ConnectSource, which: ConnectWhich): ConnectTarget | undefined {
  return connectTargets(src).find((t) => t.which === which)
}

export type ClientId = 'command' | 'config-file' | 'claude-code' | 'codex' | 'cursor' | 'vscode' | 'windsurf' | 'cline' | 'claude-desktop' | 'web' | 'generic'

export interface ClientSnippet {
  id: ClientId
  label: string
  /** 代码块的语言提示（只做显示） */
  lang: 'shell' | 'toml' | 'json' | 'text'
  code: string
  /** 代码块上面逐项填的字段（「命令」那种表单：名称、命令、参数），每项单独复制 */
  fields?: { label: string; value: string }[]
  /** 代码块的标题（比如「粘贴 JSON 用」）；不给不显示 */
  codeTitle?: string
  /** 有「保存为配置文件」按钮 */
  exportConfig?: boolean
  /** 放哪、要不要重启 */
  notes: string[]
  /** 写法不确定，以客户端文档为准 */
  unsure?: boolean
}

const json = (v: unknown) => JSON.stringify(v, null, 2)
const authHeader = (t: ConnectTarget) => (t.bearer ? { Authorization: `Bearer ${t.bearer}` } : undefined)
/** JSON 配置里的一项：url + 可选 headers */
const httpEntry = (t: ConnectTarget, extra: Record<string, unknown> = {}, urlKey = 'url') => ({
  ...extra,
  [urlKey]: t.url,
  ...(t.bearer ? { headers: authHeader(t) } : {})
})

/** mcp-remote 桥接（只会 stdio 的客户端用）。请求头经环境变量传，避免 Windows 上 args 里的空格被拆开 */
function mcpRemote(t: ConnectTarget) {
  return t.bearer
    ? { command: 'npx', args: ['-y', 'mcp-remote', t.url, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: `Bearer ${t.bearer}` } }
    : { command: 'npx', args: ['-y', 'mcp-remote', t.url] }
}
const RESTART_NOTE = '改完要完全退出客户端再打开（只关窗口可能还在后台）。'

/** 跑 stdio 桥用的可执行文件 */
export const NODE_COMMAND = 'node'

/** 用工作台自带的 stdio 桥连这个地址：command + args。要请求头认证时 token 用 --token 传 */
export function stdioEntry(script: string, t: Pick<ConnectTarget, 'url' | 'bearer'>): { command: string; args: string[] } {
  return { command: NODE_COMMAND, args: [script, t.url, ...(t.bearer ? ['--token', t.bearer] : [])] }
}

/** 配置文件的内容（mcpServers 格式，AWS Quick 的「导入」、Claude Desktop、Kiro 等都认） */
export function stdioConfigJson(script: string, t: Pick<ConnectTarget, 'url' | 'bearer'>): string {
  return json({ mcpServers: { [SERVER_KEY]: stdioEntry(script, t) } })
}

/** 「参数」一栏的写法：带空格或引号的值用双引号括起来 */
export function joinArgs(args: string[]): string {
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

function stdioSnippets(script: string, t: ConnectTarget): ClientSnippet[] {
  const entry = stdioEntry(script, t)
  const where = t.which === 'local' ? [] : ['桥在这台电脑上跑，一般选「本机」地址就行；选别的地址也能用。']
  return [
    {
      id: 'command',
      label: '命令（本地）',
      lang: 'json',
      fields: [
        { label: '名称', value: SERVER_KEY },
        { label: '命令', value: entry.command },
        { label: '参数', value: joinArgs(entry.args) }
      ],
      codeTitle: '要「粘贴 JSON」的客户端用这段：',
      code: json({ mcpServers: { [SERVER_KEY]: entry } }),
      notes: [
        'AWS Quick：添加 MCP → 本地，按上面三项填（或者点「粘贴 JSON」贴下面这段），再点「测试连接」。别的只会 stdio 的客户端也照这个填。',
        '参数第一个是工作台自带的小程序 stdio-bridge.cjs（在工作台数据目录里，不用联网装 npm 包），它把 stdio 转成工作台的 HTTP 接口。需要这台电脑装了 Node.js 18 以上，命令行能运行 node。',
        '会话断了（工作台重启、空闲超时、在团队页被断开）它会自己重新握手，客户端不用重连；工作台没开时最多等 60 秒再报错。',
        ...where,
        '参数里有 token，等同密码。换了 token 要回来重新复制。'
      ]
    },
    {
      id: 'config-file',
      label: '配置文件（导入）',
      lang: 'json',
      code: stdioConfigJson(script, t),
      exportConfig: true,
      notes: [
        'AWS Quick：添加 MCP → 导入，点下面「保存为配置文件」，把显示的路径填进「配置文件路径」，点「加载文件」。按路径读配置文件的客户端都这样用。',
        '也可以把上面这段合并进已有的配置文件（Kiro 的 ~/.kiro/settings/mcp.json、Claude Desktop 的 claude_desktop_config.json 等）的 mcpServers 里。',
        '保存的文件在工作台数据目录的 connect 文件夹里：里面有 token，接入的 AI 用文件工具和命令都碰不到。换了 token 要重新保存。',
        ...where
      ]
    }
  ]
}

/** 某个地址下各客户端的配置片段。web（网页 AI）总是用公网地址，不看选的是哪个 */
export function clientSnippets(src: ConnectSource, t: ConnectTarget): ClientSnippet[] {
  const hdr = t.bearer ? ` --header "Authorization: Bearer ${t.bearer}"` : ''
  const pub = pickTarget(src, 'public')
  const list: ClientSnippet[] = [
    ...(src.stdioBridge ? stdioSnippets(src.stdioBridge, t) : []),
    {
      id: 'claude-code',
      label: 'Claude Code',
      lang: 'shell',
      code: `claude mcp add --transport http ${SERVER_KEY} ${t.url}${hdr}`,
      notes: ['在终端里运行。默认只对当前项目生效，所有项目都要用就加 --scope user。', '不用重启，在 Claude Code 里输入 /mcp 能看到连接状态。']
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      lang: 'toml',
      code: [
        '# ~/.codex/config.toml',
        `[mcp_servers.${SERVER_KEY}]`,
        `url = "${t.url}"`,
        ...(t.bearer ? [`http_headers = { Authorization = "Bearer ${t.bearer}" }`] : []),
        '# 如果你的 Codex 版本不支持 url，用 mcp-remote 桥接：',
        `# command = "npx"`,
        `# args = ["-y", "mcp-remote", "${t.url}"${t.bearer ? `, "--header", "Authorization: Bearer ${t.bearer}"` : ''}]`
      ].join('\n'),
      notes: ['写进 ~/.codex/config.toml（Windows 是 %USERPROFILE%\\.codex\\config.toml），重新启动 codex 生效，用 codex mcp list 检查。'],
      unsure: !!t.bearer
    },
    {
      id: 'cursor',
      label: 'Cursor',
      lang: 'json',
      code: json({ mcpServers: { [SERVER_KEY]: httpEntry(t) } }),
      notes: ['全局写在 ~/.cursor/mcp.json，只给一个项目用就写在项目里的 .cursor/mcp.json。', '保存后到 Cursor 设置的 MCP 页确认它是绿的，不亮就关掉再打开一次。']
    },
    {
      id: 'vscode',
      label: 'VS Code',
      lang: 'json',
      code: json({ servers: { [SERVER_KEY]: httpEntry(t, { type: 'http' }) } }),
      notes: ['写在项目的 .vscode/mcp.json（Copilot 的 Agent 模式用）。', '保存后点文件里 workspace-bridge 上方的「Start」，不用重启 VS Code。']
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      lang: 'json',
      code: json({ mcpServers: { [SERVER_KEY]: httpEntry(t, {}, 'serverUrl') } }),
      notes: ['写在 ~/.codeium/windsurf/mcp_config.json（Cascade 面板的 MCP 图标 → 配置）。', '保存后在 MCP 面板点刷新。'],
      unsure: true
    },
    {
      id: 'cline',
      label: 'Cline',
      lang: 'json',
      code: json({ mcpServers: { [SERVER_KEY]: httpEntry(t, { type: 'streamableHttp' }) } }),
      notes: ['在 Cline 的 MCP Servers → Configure 打开 cline_mcp_settings.json，合并进 mcpServers。', 'type 一定要写 streamableHttp，不写会按旧的 SSE 连，连不上。保存后自动重连。'],
      unsure: true
    },
    src.stdioBridge
      ? {
          id: 'claude-desktop',
          label: 'Claude Desktop',
          lang: 'json',
          code: stdioConfigJson(src.stdioBridge, t),
          notes: ['设置 → 开发者 → 编辑配置，打开 claude_desktop_config.json，合并进 mcpServers。用的是工作台自带的 stdio 桥，需要装 Node.js 18 以上，不用 npx 联网装包。', RESTART_NOTE]
        }
      : {
          id: 'claude-desktop',
          label: 'Claude Desktop',
          lang: 'json',
          code: json({ mcpServers: { [SERVER_KEY]: mcpRemote(t) } }),
          notes: ['设置 → 开发者 → 编辑配置，打开 claude_desktop_config.json，合并进 mcpServers。需要先装 Node.js（用 npx 跑 mcp-remote 桥接）。', RESTART_NOTE]
        },
    webSnippet(src, pub),
    {
      id: 'generic',
      label: '通用',
      lang: 'text',
      code: [
        `地址（Streamable HTTP）：${t.url}`,
        ...(t.bearer
          ? [`请求头：Authorization: Bearer ${t.bearer}`]
          : [`或者用不带 token 的地址 ${t.baseUrl}，加请求头 Authorization: Bearer ${src.token}`]),
        `服务名：${SERVER_KEY}`
      ].join('\n'),
      notes: [
        src.stdioBridge
          ? '支持 Streamable HTTP 的客户端填地址就行；只支持 stdio（填命令）的客户端看「命令（本地）」那一页。'
          : '支持 Streamable HTTP 的客户端填地址就行；只支持 stdio 的客户端用 npx -y mcp-remote <地址> 桥接。',
        '链接和 token 等同密码，不要公开。'
      ]
    }
  ]
  return list
}

function webSnippet(src: ConnectSource, pub: ConnectTarget | undefined): ClientSnippet {
  const base = { id: 'web' as const, label: '网页 AI', lang: 'text' as const }
  if (!pub) {
    return { ...base, code: '', notes: ['Claude.ai、ChatGPT、Sesame 这类网页 AI 在云端，连不到你电脑的本机地址，要用公网地址。', '公网隧道还没开：去「设置 → 公网隧道」打开，地址出来后这里会自动显示。'] }
  }
  if (src.authMode === 'link') {
    return {
      ...base,
      code: pub.url,
      notes: [
        'Claude.ai：设置 → 连接器 → 添加自定义连接器，把这个完整链接填进地址。ChatGPT：在开发者模式里新建连接器，填同一个链接。Sesame 等直接填链接。',
        '链接里带 token，不需要登录；链接等同密码。具体入口以各家网页的说明为准。'
      ],
      unsure: true
    }
  }
  return {
    ...base,
    code: pub.baseUrl,
    notes: ['在网页 AI 的自定义连接器里填这个地址，认证选 OAuth。连接时电脑上会弹出确认框，核对配对码后点批准。', '具体入口以各家网页的说明为准。'],
    unsure: true
  }
}
