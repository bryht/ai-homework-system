/**
 * Session token for Bearer auth. The web app may be hosted on another origin (GitHub Pages),
 * where browsers block cross-site cookies, so the token is kept in localStorage and sent in
 * the Authorization header. Same-origin deployments work the same way.
 */
const KEY = 'hw:session-token'

let memory: string | null = null

export const getToken = (): string | null => {
  try {
    return localStorage.getItem(KEY) ?? memory
  } catch {
    return memory
  }
}

export const setToken = (token: string | null) => {
  memory = token
  try {
    if (token) {
      localStorage.setItem(KEY, token)
    } else {
      localStorage.removeItem(KEY)
    }
  } catch {
    // storage unavailable (private mode): keep it in memory for this page
  }
}

export const authHeaders = (): Record<string, string> => {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
