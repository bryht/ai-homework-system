import clsx from 'clsx'
import type { HomeworkPhase } from '@hw/shared'
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { Button } from '../../components/base/Button.js'
import { usePt } from '../i18n.js'
import { routeHref, useRoute, type Route } from '../router.js'
import { logout, useSession } from '../session.js'
import styles from './ui.module.css'

export { styles as ui }

export const Link = ({
  to,
  className,
  children,
}: {
  to: Route
  className?: string
  children: ReactNode
}) => (
  <a href={routeHref(to)} className={className}>
    {children}
  </a>
)

/** 所有非聊天页的外框：顶部导航 + 居中内容 */
export const PageShell = ({ children }: { children: ReactNode }) => {
  const pt = usePt()
  const user = useSession((s) => s.user)
  const route = useRoute()
  const nav: { to: Route; label: string; active: boolean }[] =
    user?.role === 'teacher'
      ? [
          {
            to: { name: 'home' },
            label: pt('homeworks'),
            active: !['classes', 'class', 'account'].includes(route.name),
          },
          {
            to: { name: 'classes' },
            label: pt('classes'),
            active: route.name === 'classes' || route.name === 'class',
          },
        ]
      : [{ to: { name: 'home' }, label: pt('myHomework'), active: route.name === 'home' }]
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a href="#/" className={styles.brand}>
          <span className={styles.brandMark}>AI</span>
          <span className={styles.brandName}>{pt('brand')}</span>
        </a>
        <nav className={styles.nav}>
          {user
            ? nav.map((item) => (
                <Link
                  key={item.label}
                  to={item.to}
                  className={clsx(styles.navLink, item.active && styles.navLinkActive)}
                >
                  {item.label}
                </Link>
              ))
            : null}
        </nav>
        {user ? (
          <div className={styles.userMenu}>
            <Link
              to={{ name: 'account' }}
              className={clsx(
                styles.navLink,
                styles.userLink,
                route.name === 'account' && styles.navLinkActive
              )}
            >
              <span className={styles.avatar} aria-hidden>
                {Array.from(user.name.trim())[0]?.toUpperCase() ?? '?'}
              </span>
              <span className={styles.userName}>{user.name}</span>
              <span className={styles.brandName}> · </span>
              {pt('account')}
            </Link>
            <button type="button" className={styles.logout} onClick={() => void logout()}>
              {pt('logout')}
            </button>
          </div>
        ) : null}
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  )
}

export const TitleRow = ({
  title,
  actions,
  back,
}: {
  title: ReactNode
  actions?: ReactNode
  back?: Route
}) => {
  const pt = usePt()
  return (
    <>
      {back ? (
        <Link to={back} className={styles.back}>
          ← {pt('back')}
        </Link>
      ) : null}
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{title}</h1>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </>
  )
}

export type BadgeTone = 'neutral' | 'open' | 'upcoming' | 'warn' | 'danger'

export const Badge = ({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone
  children: ReactNode
}) => (
  <span className={clsx(styles.badge, tone !== 'neutral' && styles[`badge-${tone}`])}>
    {children}
  </span>
)

export const PhaseBadge = ({ phase, draft = false }: { phase: HomeworkPhase; draft?: boolean }) => {
  const pt = usePt()
  if (draft) {
    return <Badge tone="warn">{pt('draft')}</Badge>
  }
  return phase === 'open' ? (
    <Badge tone="open">{pt('phaseOpen')}</Badge>
  ) : phase === 'upcoming' ? (
    <Badge tone="upcoming">{pt('phaseUpcoming')}</Badge>
  ) : (
    <Badge>{pt('phaseClosed')}</Badge>
  )
}

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={clsx(styles.card, className)}>{children}</div>
)

export const Field = ({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}) => (
  // eslint-disable-next-line jsx-a11y/label-has-associated-control
  <label className={clsx(styles.field, className)}>
    <span className={styles.label}>{label}</span>
    {children}
    {hint ? <span className={styles.hint}>{hint}</span> : null}
  </label>
)

export const TextInput = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={clsx(styles.input, className)} {...props} />
)

export const TextArea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={clsx(styles.textarea, className)} {...props} />
)

export const Checkbox = ({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
}) => (
  <label className={styles.checkbox}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span>{label}</span>
  </label>
)

export const Loading = () => {
  const pt = usePt()
  return (
    <div className={styles.center} role="status">
      {pt('loading')}
    </div>
  )
}

export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => {
  const pt = usePt()
  return (
    <div className={styles.center} role="alert">
      <span>{pt('loadFailed', { message })}</span>
      {onRetry ? (
        <Button variant="outlined" size="m" onClick={onRetry}>
          {pt('retry')}
        </Button>
      ) : null}
    </div>
  )
}

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className={clsx(styles.center, styles.empty)}>{children}</div>
)

export const Tabs = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
}) => (
  <div className={styles.tabs} role="tablist">
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="tab"
        aria-selected={value === option.value}
        className={clsx(styles.tab, value === option.value && styles.tabActive)}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
)

/** `progress` (0–1) adds a meter under the value, e.g. for "submitted / total" */
export const Stat = ({
  value,
  label,
  progress,
}: {
  value: ReactNode
  label: ReactNode
  progress?: number
}) => (
  <div className={styles.stat}>
    <div className={styles.statLabel}>{label}</div>
    <div className={styles.statValue}>{value}</div>
    {progress === undefined ? null : (
      <div className={styles.statMeter}>
        <div
          className={styles.statMeterFill}
          style={{ width: `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%` }}
        />
      </div>
    )}
  </div>
)
