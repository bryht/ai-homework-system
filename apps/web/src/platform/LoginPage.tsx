import { useState } from 'react'
import { Button } from '../components/base/Button.js'
import { setLocale, useSettings } from '../services/settings.js'
import { usePt } from './i18n.js'
import { login } from './session.js'
import { Field, TextInput, ui } from './ui/components.js'
import styles from './LoginPage.module.css'

export const LoginPage = () => {
  const pt = usePt()
  const locale = useSettings((s) => s.locale)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!username.trim() || !password || pending) {
      return
    }
    setPending(true)
    setError(null)
    try {
      await login(username.trim(), password)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={styles.page}>
      <form
        className={styles.card}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className={styles.brand}>
          <span className={ui.brandMark}>AI</span>
          {pt('brand')}
        </div>
        <h1 className={styles.title}>{pt('loginTitle')}</h1>
        <p className={styles.subtitle}>{pt('loginSubtitle')}</p>
        <Field label={pt('username')}>
          <TextInput
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label={pt('password')}>
          <TextInput
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error ? (
          <div className={ui.error} role="alert">
            {error}
          </div>
        ) : null}
        <Button type="submit" block disabled={pending || !username.trim() || !password}>
          {pending ? pt('signingIn') : pt('signIn')}
        </Button>
        <button
          type="button"
          className={styles.locale}
          onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
        >
          {locale === 'zh-CN' ? 'English' : '中文'}
        </button>
      </form>
    </div>
  )
}
