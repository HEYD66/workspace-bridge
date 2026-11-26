// 诊断报告：一份 markdown，给用户复制或保存，发给别人帮忙排查。
// 不含 token 和 API Key：只收必要的字段，最后再按已知的 token 全文替换一遍，防止从错误信息、参数里漏出去
import { redactText, redactValue } from './redact'

export interface DiagnosticsInput {
  generatedAt: number
  appVersion: string
  serverVersion: string
  electronVersion?: string
  nodeVersion: string
  platform: string
  arch: string
  osRelease: string
  dataDir: string
  port: number
  host: string
  running: boolean
  startError?: string
  lanEnabled: boolean
  authMode: string
  tunnel: { status: string; mode: string; url?: string; error?: string; kept?: boolean; hostname?: string; autoStart: boolean }
  tools: { rg: string | null; cloudflared: string | null; gitBash: string | null; pwsh: string | null }
  workspaces: { name: string; id: string; root: string; exists: boolean; machine?: boolean; active?: boolean }[]
  agents: { name: string; online: boolean; sessions: number; machineAccess: boolean; workspaces: number; role?: string; currentTool?: string }[]
  calls24h: { calls: number; errors: number }
  recentErrors: { ts: number; agentName: string; tool: string; error: string; args: Record<string, unknown> }[]
  auditError?: { at: number; message: string }
  /** 不能出现在报告里的值（AI token、隧道 token、API Key 明文） */
  secrets: string[]
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
const iso = (ts: number): string => new Date(ts).toISOString()

/** 错误码：错误信息开头的 XXX_YYY: 前缀，没有就是空 */
export function errorCode(error: string): string {
  return /^([A-Z][A-Z0-9_]{2,}):/.exec(error)?.[1] ?? ''
}

export function buildDiagnostics(d: DiagnosticsInput): string {
  const secrets = d.secrets.filter((s) => typeof s === 'string' && s.length >= 8)
  const t = d.tunnel
  const rate = d.calls24h.calls ? ((d.calls24h.errors / d.calls24h.calls) * 100).toFixed(1) : '0.0'
  const lines: string[] = [
    '# Workspace Bridge 诊断报告',
    '',
    `生成时间：${iso(d.generatedAt)}`,
    '',
    '> 报告里没有 AI 的 token、隧道 token 和 API Key；文件路径和工作区名字还在，发给别人前自己看一眼。',
    '',
    '## 版本和环境',
    '',
    `- 应用版本：${d.appVersion}（MCP 服务 ${d.serverVersion}）`,
    `- Electron：${d.electronVersion ?? '（不是在 Electron 里运行）'}`,
    `- Node：${d.nodeVersion}`,
    `- 平台：${d.platform} ${d.arch}（${d.osRelease}）`,
    `- 数据目录：${d.dataDir}`,
    '',
    '## MCP 服务',
    '',
    `- 状态：${d.running ? '运行中' : '没有运行'}${d.startError ? `（${d.startError}）` : ''}`,
    `- 监听：${d.host}:${d.port}`,
    `- 局域网：${d.lanEnabled ? '开' : '关'}`,
    `- 网页 AI 认证方式：${d.authMode}`,
    `- 隧道：${t.status}，模式 ${t.mode}${t.hostname ? `，域名 ${t.hostname}` : ''}${t.url ? `，地址 ${t.url}` : ''}${t.kept ? '（上次退出时保留）' : ''}${t.autoStart ? '，启动时自动开' : ''}`,
    ...(t.error ? [`- 隧道错误：${t.error}`] : []),
    '',
    '## 外部程序',
    '',
    `- ripgrep（rg）：${d.tools.rg ?? '没找到（搜索用内置引擎）'}`,
    `- cloudflared：${d.tools.cloudflared ?? '没找到'}`,
    `- Git Bash：${d.tools.gitBash ?? '没找到'}`,
    `- PowerShell：${d.tools.pwsh ?? '没找到'}`,
    '',
    `## 工作区（${d.workspaces.length}）`,
    '',
    '| 名字 | id | 路径 | 目录 |',
    '|---|---|---|---|',
    ...d.workspaces.map(
      (w) => `| ${cell(w.name)}${w.active ? '（当前）' : ''}${w.machine ? '（整台电脑）' : ''} | ${w.id} | ${cell(w.root)} | ${w.exists ? '存在' : '**不存在**'} |`
    ),
    '',
    `## AI（${d.agents.length}）`,
    '',
    '所有 AI 都是完全权限（全部工具、读写文件、执行命令），能用全部目录工作区；「整台电脑」按 AI 单独开关。',
    '',
    '| 名字 | 职位 | 在线 | 整台电脑 | 能用的工作区数 | 正在用的工具 |',
    '|---|---|---|---|---|---|',
    ...d.agents.map(
      (a) =>
        `| ${cell(a.name)} | ${cell(a.role ?? '无')} | ${a.online ? `是（${a.sessions} 个连接）` : '否'} | ${a.machineAccess ? '开' : '关'} | ${a.workspaces} | ${a.currentTool ?? ''} |`
    ),
    '',
    '## 最近 24 小时',
    '',
    `- 调用：${d.calls24h.calls} 次，出错 ${d.calls24h.errors} 次（${rate}%）`,
    `- 审计日志写入失败：${d.auditError ? `${iso(d.auditError.at)} ${d.auditError.message}` : '没有'}`,
    '',
    `## 最近的错误（${d.recentErrors.length}）`,
    '',
    ...(d.recentErrors.length
      ? [
          '| 时间 | AI | 工具 | 错误码 | 说明 | 参数 |',
          '|---|---|---|---|---|---|',
          ...d.recentErrors.map((e) => {
            const args = JSON.stringify(redactValue(e.args, secrets))
            const msg = e.error.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, '')
            return `| ${iso(e.ts)} | ${cell(e.agentName)} | ${e.tool} | ${errorCode(e.error) || '-'} | ${cell(msg.slice(0, 200))} | ${cell(args.length > 200 ? args.slice(0, 200) + '…' : args)} |`
          })
        ]
      : ['没有。']),
    ''
  ]
  // 最后整篇再按已知 token 和 token 写法替换一遍
  return redactText(lines.join('\n'), secrets)
}
