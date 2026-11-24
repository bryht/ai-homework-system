import type { Homework, StudentHomework } from '@hw/shared'
import { useEffect, useState } from 'react'
import { App } from '../../app/App.js'
import { api } from '../api.js'
import { setHomeworkScope } from '../homeworkScope.js'
import { navigate } from '../router.js'
import { useSession } from '../session.js'
import { ErrorState, Loading } from '../ui/components.js'

/**
 * 作业聊天页：先取作业信息、设好作用域（请求头、IndexedDB 库名、功能开关），再挂载 chat-demo。
 * 每次页面加载只会进入一个作业，切换作业时整页刷新（见 router.ts）。
 */
export const ChatPage = ({ homeworkId, showReceipt }: { homeworkId: string; showReceipt?: boolean }) => {
  const user = useSession((s) => s.user)
  const [state, setState] = useState<'loading' | 'ready' | string>('loading')

  useEffect(() => {
    if (!user) {
      return
    }
    api<{ homework: StudentHomework | Homework }>(
      `/api/homeworks/${encodeURIComponent(homeworkId)}`
    )
      .then(({ homework }) => {
        if (user.role === 'student' && homework.phase === 'upcoming') {
          navigate({ name: 'home' })
          return
        }
        setHomeworkScope(user.id, homework)
        setState('ready')
      })
      .catch((error: unknown) => setState(error instanceof Error ? error.message : String(error)))
  }, [homeworkId, user])

  if (state === 'loading' || !user) {
    return <Loading />
  }
  if (state !== 'ready') {
    return <ErrorState message={state} onRetry={() => navigate({ name: 'home' })} />
  }
  return <App showReceipt={showReceipt} />
}
