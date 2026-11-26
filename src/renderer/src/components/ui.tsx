import { Check, Copy } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { initials } from '../lib/format'

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'default' | 'ghost' | 'danger'

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-[#238636] hover:bg-[#2ea043] text-white border border-[#2ea043]/60',
    default: 'bg-raised hover:bg-hover text-fg border border-line',
    ghost: 'text-muted hover:text-fg hover:bg-hover',
    danger: 'text-bad border border-line hover:bg-bad/15 hover:border-bad/50'
  }
  return (
    <button
      className={cx(
        'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-[13px]',
        styles[variant],
        className
      )}
      {...props}
    />
  )
}

export function IconButton({ title, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      title={title}
      aria-label={title}
      className={cx('inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg', className)}
      {...props}
    />
  )
}

export function Avatar({ name, color, size = 20, active }: { name: string; color: string; size?: number; active?: boolean }) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-[#0d1117]"
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.45) }}
      title={name}
    >
      {initials(name)}
      {active && <span className="pulse-dot absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-canvas bg-ok" />}
    </span>
  )
}

/**
 * 胶囊开关：role=switch，开 = 绿色、圆点在右。放在 <label> 里时点文字也能切换。
 * disabled = 现在不能改（变淡）；locked = 这一项必须保持现状（点不动，但颜色不变，免得「开着」看起来像半开）。
 */
export function Switch({
  checked,
  onChange,
  className,
  disabled,
  locked,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'type'> & { checked: boolean; onChange: (next: boolean) => void; locked?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || locked}
      data-locked={locked ? '' : undefined}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed',
        disabled && 'opacity-50',
        checked ? 'border-[#2ea043]/60 bg-[#238636]' : 'border-line bg-hover',
        className
      )}
      {...props}
    >
      <span className={cx('pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all', checked ? 'left-[18px] bg-white' : 'left-0.5 bg-muted')} />
    </button>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-line bg-panel', className)}>{children}</div>
}

export function Badge({ children, color, className }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] font-medium', !color && 'bg-hover text-muted', className)}
      style={color ? { background: color + '26', color } : undefined}
    >
      {children}
    </span>
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-8 w-full rounded-md border border-line bg-canvas px-2.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent',
        className
      )}
      {...props}
    />
  )
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        'w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent',
        className
      )}
      {...props}
    />
  )
}

/** 分段选择器 */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-canvas p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx('h-6 cursor-pointer rounded px-2.5 text-xs transition-colors', value === o.value ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function CopyButton({ text, label = '复制', size = 'sm' }: { text: string | (() => Promise<string>); label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size={size}
      onClick={async () => {
        await window.bridge.copy(typeof text === 'string' ? text : await text())
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
      {label && (done ? '已复制' : label)}
    </Button>
  )
}

/** 危险操作：第一次点击变成"确认？"，3 秒内再点才执行 */
export function ConfirmButton({ children, confirmText, onConfirm, size = 'sm' }: { children: ReactNode; confirmText: string; onConfirm: () => void; size?: 'sm' | 'md' }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <Button size={size} variant="danger" className={cx(armed && 'bg-bad/20 border-bad/60')} onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}>
      {armed ? confirmText : children}
    </Button>
  )
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-14 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-[13px] text-fg">{title}</div>
      {hint && <div className="max-w-sm text-xs leading-relaxed text-muted">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

/** 侧栏标题：大写小字 + 右侧操作按钮 */
export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between px-3 text-[11px] font-semibold tracking-wider text-muted uppercase">
      <span>{title}</span>
      <div className="flex items-center gap-0.5 normal-case">{children}</div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // 不用 <label>：它会把点击转给里面第一个按钮，点标题文字就会误触
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted">{label}</div>
      {children}
      {hint && <div className="text-[11px] leading-relaxed text-faint">{hint}</div>}
    </div>
  )
}
