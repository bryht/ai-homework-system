import { useEffect, useState } from 'react'

/**
 * 极简 hash 路由。进入或离开聊天页时整页刷新：
 * chat-demo 的会话存储（IndexedDB）和状态是模块级单例，按作业隔离最简单可靠的方式就是重新加载。
 */
export type Route =
  | { name: 'login' }
  | { name: 'home' }
  | { name: 'account' }
  | { name: 'chat'; homeworkId: string }
  | { name: 'classes' }
  | { name: 'class'; classId: string }
  | { name: 'homeworkNew' }
  | { name: 'homeworkEdit'; homeworkId: string }
  | { name: 'homework'; homeworkId: string }
  | { name: 'student'; homeworkId: string; studentId: string }

export const parseRoute = (hash: string): Route => {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [a, b, c, d, e] = parts
  if (a === 'login') {
    return { name: 'login' }
  }
  if (a === 'account') {
    return { name: 'account' }
  }
  if (a === 'hw' && b) {
    return { name: 'chat', homeworkId: b }
  }
  if (a === 'teacher') {
    if (b === 'classes' && c) {
      return { name: 'class', classId: c }
    }
    if (b === 'classes') {
      return { name: 'classes' }
    }
    if (b === 'hw' && c === 'new') {
      return { name: 'homeworkNew' }
    }
    if (b === 'hw' && c && d === 'edit') {
      return { name: 'homeworkEdit', homeworkId: c }
    }
    if (b === 'hw' && c && d === 'students' && e) {
      return { name: 'student', homeworkId: c, studentId: e }
    }
    if (b === 'hw' && c) {
      return { name: 'homework', homeworkId: c }
    }
  }
  return { name: 'home' }
}

export const routeHref = (route: Route): string => {
  switch (route.name) {
    case 'login':
      return '#/login'
    case 'home':
      return '#/'
    case 'account':
      return '#/account'
    case 'chat':
      return `#/hw/${route.homeworkId}`
    case 'classes':
      return '#/teacher/classes'
    case 'class':
      return `#/teacher/classes/${route.classId}`
    case 'homeworkNew':
      return '#/teacher/hw/new'
    case 'homeworkEdit':
      return `#/teacher/hw/${route.homeworkId}/edit`
    case 'homework':
      return `#/teacher/hw/${route.homeworkId}`
    case 'student':
      return `#/teacher/hw/${route.homeworkId}/students/${route.studentId}`
  }
}

const initialRoute = parseRoute(window.location.hash)

/** 只改 hash；进出聊天页需要的整页刷新由 useRoute 的 hashchange 处理 */
export const navigate = (route: Route) => {
  window.location.hash = routeHref(route)
}

export const useRoute = (): Route => {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => {
      const next = parseRoute(window.location.hash)
      // 地址栏手动切换进出聊天页时同样需要刷新
      const chatChanged =
        (next.name === 'chat') !== (initialRoute.name === 'chat') ||
        (next.name === 'chat' &&
          initialRoute.name === 'chat' &&
          next.homeworkId !== initialRoute.homeworkId)
      if (chatChanged) {
        window.location.reload()
        return
      }
      setRoute(next)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
