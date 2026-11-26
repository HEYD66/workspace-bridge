// 接入向导：选地址 → 选客户端 → 复制配置片段；「测试连接」用这个 AI 的 token 真连一次
import { CircleCheck, CircleX, FileDown, Loader2, PlugZap, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ConnectionInfo, ConnectTestResult, ConnectWhich } from '../../../shared/api'
import { clientSnippets, connectTargets, type ClientId } from '../../../shared/connectGuide'
import { errText } from '../lib/format'
import { navigate } from '../lib/nav'
import { Button, CopyButton, cx, Segmented } from './ui'

/** 上次选的客户端，切换 AI 后还在 */
let lastClient: ClientId = 'claude-code'

function maskToken(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join(token.slice(0, 6) + '•'.repeat(14) + token.slice(-4))
}

/** info：connectionInfo 的结果（父组件已经在地址变化时重新取）；reveal：是否显示 token 原文（和上面的地址行同一个开关） */
export function ConnectGuide({ agentId, info, reveal }: { agentId: string; info: ConnectionInfo; reveal: boolean }) {
  const targets = useMemo(() => connectTargets(info), [info])
  const [which, setWhich] = useState<ConnectWhich>('local')
  const target = targets.find((t) => t.which === which) ?? targets[0]
  const snippets = useMemo(() => clientSnippets(info, target), [info, target])
  const [client, setClient] = useState<ClientId>(lastClient)
  const snip = snippets.find((s) => s.id === client) ?? snippets[0]

  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ConnectTestResult>()
  // 「保存为配置文件」：存好的路径或出错原因
  const [exported, setExported] = useState<{ path?: string; error?: string }>()
  const [exporting, setExporting] = useState(false)
  // 换地址、换 AI、token 变了：上次的测试结果作废
  useEffect(() => setResult(undefined), [agentId, which, info.token])
  // 换 AI、token 变了：存过的文件里是旧 token，要重新存
  useEffect(() => setExported(undefined), [agentId, info.token])
  // 选的地址没了（局域网关了、隧道停了）：回到本机
  useEffect(() => {
    if (!targets.some((t) => t.which === which)) setWhich('local')
  }, [targets, which])

  const test = async () => {
    setTesting(true)
    setResult(undefined)
    try {
      setResult(await window.bridge.testConnection(agentId, target.which))
    } catch (e) {
      setResult({ ok: false, ms: 0, url: '', error: errText(e) })
    } finally {
      setTesting(false)
    }
  }

  const exportConfig = async () => {
    setExporting(true)
    setExported(undefined)
    try {
      setExported({ path: (await window.bridge.exportClientConfig(agentId)).path })
    } catch (e) {
      setExported({ error: errText(e) })
    } finally {
      setExporting(false)
    }
  }
  const show = (text: string) => (reveal ? text : maskToken(text, info.token))

  return (
    <div className="space-y-3 rounded-lg border border-line-soft bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">地址</span>
        <Segmented
          value={target.which}
          onChange={setWhich}
          options={targets.map((t) => ({ value: t.which, label: t.label, title: t.baseUrl }))}
        />
        {targets.length < 3 && (
          <span className="text-[11px] text-faint">
            {!targets.some((t) => t.which === 'lan') && '局域网没开'}
            {!targets.some((t) => t.which === 'lan') && !targets.some((t) => t.which === 'public') && ' · '}
            {!targets.some((t) => t.which === 'public') && '公网隧道没在运行'}
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" onClick={() => void test()} disabled={testing} title="用这个 AI 的 token 对选中的地址发一次 initialize，测完马上关掉会话">
          {testing ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />} 测试连接
        </Button>
      </div>
      {result && <TestResult r={result} />}

      <div className="flex flex-wrap gap-1" role="tablist">
        {snippets.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === snip.id}
            onClick={() => {
              lastClient = s.id
              setClient(s.id)
            }}
            className={cx(
              'h-6 cursor-pointer rounded-full border px-2.5 text-xs transition-colors',
              s.id === snip.id ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line-soft text-muted hover:border-line hover:text-fg'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {snip.fields && (
          <div className="space-y-1.5" data-connect-fields>
            {snip.fields.map((f) => (
              <div key={f.label} className="flex items-center gap-2">
                <span className="w-9 shrink-0 text-xs text-muted">{f.label}</span>
                <code className="selectable min-w-0 flex-1 truncate rounded-md border border-line-soft bg-canvas px-2 py-1 font-mono text-[12px] text-[#c9d1d9]" title={reveal ? f.value : undefined}>
                  {show(f.value)}
                </code>
                <CopyButton text={f.value} />
              </div>
            ))}
          </div>
        )}
        {snip.code && snip.codeTitle && <div className="pt-1 text-[11px] text-muted">{snip.codeTitle}</div>}
        {snip.code ? (
          <div className="relative">
            <pre className="selectable max-h-64 overflow-auto rounded-md border border-line-soft bg-canvas p-3 pr-20 font-mono text-[12px] leading-normal whitespace-pre-wrap break-all text-[#c9d1d9]">
              {show(snip.code)}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton text={snip.code} />
            </div>
          </div>
        ) : null}
        {snip.exportConfig && (
          <div className="space-y-1.5" data-connect-export>
            <Button size="sm" onClick={() => void exportConfig()} disabled={exporting} title="写成 mcpServers 格式的 JSON 文件（本机地址），放在工作台数据目录里">
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />} 保存为配置文件
            </Button>
            {exported?.path && (
              <div className="flex items-center gap-2">
                <span className="w-9 shrink-0 text-xs text-muted">路径</span>
                <code className="selectable min-w-0 flex-1 truncate rounded-md border border-ok/40 bg-ok/10 px-2 py-1 font-mono text-[12px] text-fg" title={exported.path}>
                  {exported.path}
                </code>
                <CopyButton text={exported.path} />
              </div>
            )}
            {exported?.error && <div className="text-xs text-bad">保存失败：{exported.error}</div>}
          </div>
        )}
        <ul className="space-y-1 text-xs leading-relaxed text-muted">
          {snip.notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
        {snip.id === 'web' && !info.publicUrl && (
          <Button size="sm" onClick={() => navigate({ section: 'settings' })}>
            去设置开公网隧道
          </Button>
        )}
        {snip.unsure && (
          <div className="flex items-center gap-1.5 text-[11px] text-warn">
            <TriangleAlert size={11} /> 这个客户端的写法各版本不一样，以客户端文档为准。
          </div>
        )}
      </div>
    </div>
  )
}

function TestResult({ r }: { r: ConnectTestResult }) {
  return (
    <div
      className={cx(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
        r.ok ? 'border-ok/40 bg-ok/10 text-ok' : 'border-bad/40 bg-bad/10 text-bad'
      )}
    >
      {r.ok ? <CircleCheck size={14} className="mt-px shrink-0" /> : <CircleX size={14} className="mt-px shrink-0" />}
      <div className="min-w-0 flex-1">
        {r.ok ? (
          <span>
            连接成功 · {r.ms} ms · 服务 {r.serverName ?? '未知'}
            {r.serverVersion ? ` ${r.serverVersion}` : ''}
          </span>
        ) : (
          <span className="break-words">连接失败：{r.error}</span>
        )}
        {r.url && <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{r.url}</div>}
      </div>
    </div>
  )
}
