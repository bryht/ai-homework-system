import type { User } from '@hw/shared'
import { create } from 'zustand'
import { api, setUnauthorizedHandler } from './api.js'
import { navigate } from './router.js'
import { setToken } from './token.js'

type SessionState = {
  status: 'loading' | 'ready'
  user: User | null
}

export const useSession = create<SessionState>(() => ({ status: 'loading', user: null }))

export const loadSession = async () => {
  try {
    const { user } = await api<{ user: User | null }>('/api/auth/me')
    useSession.setState({ status: 'ready', user })
  } catch {
    useSession.setState({ status: 'ready', user: null })
  }
}

export const login = async (username: string, password: string) => {
  const { user, token } = await api<{ user: User; token: string }>('/api/auth/login', {
    method: 'POST',
    json: { username, password },
  })
  setToken(token)
  useSession.setState({ user })
  navigate({ name: 'home' })
}

export const logout = async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
  setToken(null)
  useSession.setState({ user: null })
  navigate({ name: 'login' })
}

/** 登录过期：清掉用户，回到登录页 */
export const goToLogin = () => {
  setToken(null)
  useSession.setState({ user: null })
  navigate({ name: 'login' })
}

setUnauthorizedHandler(goToLogin)
