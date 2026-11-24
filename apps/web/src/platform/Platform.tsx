import { useEffect } from 'react'
import { Toast } from '../components/base/Toast.js'
import { AccountPage } from './AccountPage.js'
import { LoginPage } from './LoginPage.js'
import { navigate, useRoute } from './router.js'
import { loadSession, useSession } from './session.js'
import { ChatPage } from './student/ChatPage.js'
import { StudentHome } from './student/StudentHome.js'
import { ClassPage } from './teacher/ClassPage.js'
import { ClassesPage } from './teacher/ClassesPage.js'
import { HomeworkEditor } from './teacher/HomeworkEditor.js'
import { HomeworkOverviewPage } from './teacher/HomeworkOverviewPage.js'
import { StudentRecordPage } from './teacher/StudentRecordPage.js'
import { TeacherHome } from './teacher/TeacherHome.js'
import { Loading, PageShell } from './ui/components.js'

/** 应用入口：登录状态 + 路由。聊天页直接渲染 chat-demo，其他页面用平台外框 */
export const Platform = () => {
  const { status, user } = useSession()
  const route = useRoute()

  useEffect(() => {
    void loadSession()
  }, [])

  useEffect(() => {
    if (status === 'ready' && !user && route.name !== 'login') {
      navigate({ name: 'login' })
    }
    if (status === 'ready' && user && route.name === 'login') {
      navigate({ name: 'home' })
    }
  }, [status, user, route.name])

  if (status === 'loading' || (!user && route.name !== 'login')) {
    return <Loading />
  }
  if (!user) {
    return <LoginPage />
  }
  if (route.name === 'chat') {
    return <ChatPage homeworkId={route.homeworkId} />
  }

  const teacher = user.role === 'teacher'
  let page
  switch (route.name) {
    case 'account':
      page = <AccountPage />
      break
    case 'classes':
      page = teacher ? <ClassesPage /> : null
      break
    case 'class':
      page = teacher ? <ClassPage classId={route.classId} /> : null
      break
    case 'homeworkNew':
      page = teacher ? <HomeworkEditor /> : null
      break
    case 'homeworkEdit':
      page = teacher ? <HomeworkEditor homeworkId={route.homeworkId} /> : null
      break
    case 'homework':
      page = teacher ? (
        <HomeworkOverviewPage key={route.homeworkId} homeworkId={route.homeworkId} />
      ) : null
      break
    case 'student':
      page = teacher ? (
        <StudentRecordPage
          key={`${route.homeworkId}:${route.studentId}`}
          homeworkId={route.homeworkId}
          studentId={route.studentId}
        />
      ) : null
      break
    default:
      page = null
  }
  return (
    <>
      <PageShell>{page ?? (teacher ? <TeacherHome /> : <StudentHome />)}</PageShell>
      <Toast />
    </>
  )
}
