// 设置页：备份与恢复（导出 / 导入预览 / 应用）、诊断报告
import { Archive, FileText, Stethoscope, TriangleAlert, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ImportPreview, ImportResult } from '../../../shared/api'
import { errText } from '../lib/format'
import { Badge, Button, Card, CopyButton, cx, Switch } from './ui'

type Pending = ImportPreview & { importId: string; file: string }

const ACTION = { add: '新增', update: '覆盖', same: '不变' } as const

export function BackupCard() {
  const [withTokens, setWithTokens] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setError('')
    setNote('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  const doExport = () =>
    run('export', async () => {
      const r = await window.bridge.exportBackup({ includeTokens: withTokens })
      if (r.saved) setNote(`已导出到 ${r.path}${withTokens ? '。文件里有 token，请像密码一样保管' : ''}`)
    })
  const pick = () =>
    run('pick', async () => {
      setResult(null)
      const p = await window.bridge.pickImportBackup()
      if (p) setPending(p)
    })
  const apply = () =>
    run('apply', async () => {
      if (!pending) return
      const r = await window.bridge.applyImportBackup(pending.importId)
      setPending(null)
      setResult(r)
    })

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2 text-[13px] font-medium">
        <Archive size={15} className="text-accent" /> 备份与恢复
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        把工作区、AI 身份、职位、隧道设置、停用的工具、内置 AI 的模型提供方和用户级技能清单导出成一个 JSON 文件，换电脑或重装后导入。
        API Key 不会导出（它是用这台电脑的系统加密存的），导入后要重新填。技能文件本身不在备份里，只记清单。
      </p>
      <label className="mb-2 flex cursor-pointer items-start gap-3 text-xs text-fg">
        <span className="min-w-0 flex-1">
          包含 AI 的 token
          <span className="block text-muted">
            {withTokens
              ? '导入后各个 AI 不用重新配置。拿到这个文件就能以这些 AI 的身份访问你的电脑，请像密码一样保管。'
              : 'token 换成占位符，导入时这些 AI 会重新生成 token，要把新地址重新填到各个 AI 客户端。'}
          </span>
        </span>
        <Switch aria-label="包含 AI 的 token" checked={withTokens} onChange={setWithTokens} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!!busy} onClick={() => void doExport()}>
          <FileText size={12} />
          {busy === 'export' ? '导出中…' : '导出备份…'}
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => void pick()}>
          <Upload size={12} />
          {busy === 'pick' ? '读取中…' : '导入备份…'}
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-bad">{error}</div>}
      {note && <div className="mt-2 text-xs text-ok">{note}</div>}
      {result && (
        <div className="mt-3 space-y-1 rounded-md border border-warn/40 bg-warn/10 p-3 text-xs leading-relaxed text-fg">
          <div className="flex items-center gap-1.5 font-medium text-warn">
            <TriangleAlert size={13} /> 已导入，MCP 服务已重启，所有 AI 需要重新连接
          </div>
          {result.backupFile && <div className="text-muted">导入前的配置已备份到 {result.backupFile}</div>}
          {result.regenerated.length > 0 && (
            <div>这些 AI 重新生成了 token，要到团队页复制新的连接地址填回客户端：{result.regenerated.map((r) => r.name).join('、')}</div>
          )}
          {result.llm && result.llm.needKey.length > 0 && <div>这些模型提供方要重新填 API Key：{result.llm.needKey.join('、')}</div>}
        </div>
      )}
      {pending && <ImportDialog p={pending} busy={busy === 'apply'} onCancel={() => setPending(null)} onApply={() => void apply()} />}
    </Card>
  )
}

function ImportDialog({ p, busy, onCancel, onApply }: { p: Pending; busy: boolean; onCancel: () => void; onApply: () => void }) {
  const nothing = !p.workspaces.length && !p.agents.length && !p.roles.length && !p.tunnel && !p.llm?.providers.length
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onCancel}>
      <div className="flex max-h-[85vh] w-[600px] flex-col rounded-lg border border-line bg-panel shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-4 py-3">
          <div className="text-[14px] font-medium text-fg">导入设置备份</div>
          <div className="truncate text-[11px] text-faint" title={p.file}>
            {p.file} · 导出于 {p.exportedAt ? new Date(p.exportedAt).toLocaleString('zh-CN', { hour12: false }) : '未知'}
            {p.appVersion && ` · 版本 ${p.appVersion}`} · {p.includesTokens ? '含 token' : '不含 token'}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3 text-[13px]">
          <div className="text-xs text-muted">按工作区路径、AI 和职位的 id 合并：备份里有的新增或覆盖，本机有、备份里没有的保留不动。导入前会自动备份当前配置。</div>
          <Section title={`工作区（${p.workspaces.length}）`}>
            {p.workspaces.map((w) => (
              <Line key={w.root} action={w.action}>
                {w.name} <span className="font-mono text-[11px] text-faint">{w.root}</span>
                {!w.exists && <Badge color="#d29922" className="ml-1">目录不存在</Badge>}
              </Line>
            ))}
          </Section>
          <Section title={`AI（${p.agents.length}）`}>
            {p.agents.map((a) => (
              <Line key={a.id} action={a.action}>
                {a.name}
                {a.machineAccess && <Badge color="#d29922" className="ml-1">能用整台电脑</Badge>}
                {a.tokenRegenerated && <Badge color="#d29922" className="ml-1">重新生成 token</Badge>}
              </Line>
            ))}
          </Section>
          <Section title={`职位（${p.roles.length}）`}>
            {p.roles.map((r) => (
              <Line key={r.id} action={r.action}>
                {r.name}
              </Line>
            ))}
          </Section>
          <Section title="其他">
            <div className="text-xs text-muted">
              {p.tunnel ? '覆盖隧道设置' : '不改隧道设置'}
              {p.llm && `；模型提供方 ${p.llm.providers.length} 个、模型绑定 ${p.llm.bindings} 个`}
            </div>
            {p.llm?.providers.map((x) => (
              <Line key={x.name} action={x.action}>
                {x.name}
              </Line>
            ))}
            {p.missingSkills.length > 0 && (
              <div className="mt-1 text-xs text-warn">这台电脑上没有这些用户级技能，要自己把技能文件夹拷过来：{p.missingSkills.join('、')}</div>
            )}
          </Section>
          {p.warnings.length > 0 && (
            <Section title="注意">
              <ul className="space-y-0.5 text-xs text-warn">
                {p.warnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </Section>
          )}
          {p.dropped.length > 0 && (
            <Section title={`丢掉的条目（${p.dropped.length}）`}>
              <ul className="space-y-0.5 text-xs text-bad">
                {p.dropped.map((d, i) => (
                  <li key={i}>· {d}</li>
                ))}
              </ul>
            </Section>
          )}
          <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">确认后会重启 MCP 服务，所有 AI 都要重新连接。</div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={onCancel}>取消</Button>
          <Button variant="primary" disabled={busy || nothing} onClick={onApply}>
            {busy ? '导入中…' : '确认导入'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-fg">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Line({ action, children }: { action: 'add' | 'update' | 'same'; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px]">
      <span className={cx('w-8 shrink-0 text-[11px]', action === 'add' ? 'text-ok' : action === 'update' ? 'text-warn' : 'text-faint')}>{ACTION[action]}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

export function DiagnosticsCard() {
  const [report, setReport] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const gen = async () => {
    setBusy('gen')
    setError('')
    setSaved('')
    try {
      setReport(await window.bridge.diagnosticsReport())
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }
  const save = async () => {
    setBusy('save')
    setError('')
    try {
      const r = await window.bridge.saveDiagnostics()
      if (r.saved) setSaved(`已保存到 ${r.path}`)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2 text-[13px] font-medium">
        <Stethoscope size={15} className="text-accent" /> 诊断报告
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        汇总版本、服务和隧道状态、外部程序、工作区、AI、最近 24 小时的调用和错误，方便发给别人帮忙排查。不含 token 和 API Key；文件路径和名字还在，发出去前自己看一眼。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!!busy} onClick={() => void gen()}>
          {busy === 'gen' ? '生成中…' : report ? '重新生成' : '生成诊断报告'}
        </Button>
        {report && <CopyButton text={report} label="复制" />}
        {report && (
          <Button size="sm" disabled={!!busy} onClick={() => void save()}>
            {busy === 'save' ? '保存中…' : '保存为文件…'}
          </Button>
        )}
      </div>
      {error && <div className="mt-2 text-xs text-bad">{error}</div>}
      {saved && <div className="mt-2 text-xs text-ok">{saved}</div>}
      {report && <pre className="selectable mt-3 max-h-96 overflow-auto rounded-md border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">{report}</pre>}
    </Card>
  )
}
