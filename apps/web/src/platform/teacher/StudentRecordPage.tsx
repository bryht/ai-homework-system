import type { Grade, HomeworkOverview, StudentRecord } from '@hw/shared'
import { useEffect, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { showToast } from '../../components/base/toastState.js'
import { Markdown } from '../../components/markdown/Markdown.js'
import { api } from '../api.js'
import { usePt } from '../i18n.js'
import { navigate } from '../router.js'
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  Tabs,
  TextArea,
  TextInput,
  TitleRow,
  ui,
} from '../ui/components.js'
import { formatDateTime } from '../ui/format.js'
import { useAsync } from '../ui/hooks.js'
import { ConversationView, FileChip } from './Transcript.js'
import styles from './transcript.module.css'

export const StudentRecordPage = ({
  homeworkId,
  studentId,
}: {
  homeworkId: string
  studentId: string
}) => {
  const pt = usePt()
  const { data, error, reload } = useAsync(
    () => api<StudentRecord>(`/api/homeworks/${homeworkId}/students/${studentId}`),
    [homeworkId, studentId]
  )
  const [selectedTab, setTab] = useState<'conversations' | 'submission' | null>(null)

  if (error) {
    return <ErrorState message={error} onRetry={reload} />
  }
  if (!data) {
    return <Loading />
  }
  const { student, homework, conversations, submission } = data
  const tab = selectedTab ?? (submission ? 'submission' : 'conversations')
  const turnCount = conversations.reduce((n, c) => n + c.turns.length, 0)
  return (
    <>
      <TitleRow
        title={`${student.name} · ${homework.title}`}
        back={{ name: 'homework', homeworkId }}
      />
      <div className={styles.layout}>
        <div>
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'conversations', label: `${pt('tabConversations')} (${turnCount})` },
              { value: 'submission', label: pt('tabSubmission') },
            ]}
          />
          {tab === 'conversations' ? (
            conversations.length === 0 ? (
              <Empty>{pt('noConversations')}</Empty>
            ) : (
              <div className={ui.stack}>
                {conversations.map((conversation) => (
                  <ConversationView key={conversation.id} conversation={conversation} />
                ))}
              </div>
            )
          ) : !submission ? (
            <Empty>{pt('noSubmission')}</Empty>
          ) : (
            <Card>
              <div className={ui.stack}>
                <div className={ui.row}>
                  <span className={ui.muted}>
                    {pt('lastSubmitted', { time: formatDateTime(submission.updatedAt) })}
                  </span>
                  {submission.isLate ? <Badge tone="warn">{pt('lateTag')}</Badge> : null}
                </div>
                <div className={styles.submission}>
                  <Markdown
                    content={submission.content || '—'}
                    loading={false}
                    cacheKey={`sub-${submission.id}-${submission.updatedAt}`}
                    disableLink={false}
                    className="ds-assistant-message-main-content"
                  />
                </div>
                {submission.files.length ? (
                  <div className={ui.row}>
                    {submission.files.map((file) => (
                      <FileChip key={file.id} file={file} />
                    ))}
                  </div>
                ) : null}
              </div>
            </Card>
          )}
        </div>
        <div className={styles.side}>
          <GradeCard
            homeworkId={homeworkId}
            studentId={studentId}
            grade={data.grade}
            hasSubmission={Boolean(submission)}
          />
        </div>
      </div>
    </>
  )
}

const GradeCard = ({
  homeworkId,
  studentId,
  grade,
  hasSubmission,
}: {
  homeworkId: string
  studentId: string
  grade: Grade | null
  hasSubmission: boolean
}) => {
  const pt = usePt()
  const [score, setScore] = useState(
    grade?.score === null || grade?.score === undefined ? '' : String(grade.score)
  )
  const [comment, setComment] = useState(grade?.comment ?? '')
  const [savedAt, setSavedAt] = useState(grade?.gradedAt ?? null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setScore(grade?.score === null || grade?.score === undefined ? '' : String(grade.score))
    setComment(grade?.comment ?? '')
    setSavedAt(grade?.gradedAt ?? null)
  }, [grade])

  const scoreValue = score.trim() === '' ? null : Number(score)
  const scoreValid =
    scoreValue === null || (Number.isFinite(scoreValue) && scoreValue >= 0 && scoreValue <= 1000)

  const save = async (nextStudent = false) => {
    if (pending || !scoreValid) {
      return
    }
    setPending(true)
    try {
      const result = await api<{ grade: Grade }>(
        `/api/homeworks/${homeworkId}/students/${studentId}/grade`,
        {
          method: 'PUT',
          json: { score: scoreValue, comment },
        }
      )
      setSavedAt(result.grade.gradedAt)
      showToast(pt('saved'))
      if (nextStudent) {
        const { students } = await api<HomeworkOverview>(`/api/homeworks/${homeworkId}/overview`)
        const current = students.findIndex((row) => row.student.id === studentId)
        const remaining = [...students.slice(current + 1), ...students.slice(0, current)]
        const next = remaining.find((row) => row.submission && !row.grade)
        if (next) {
          navigate({ name: 'student', homeworkId, studentId: next.student.id })
        } else {
          showToast(pt('noMoreToGrade'))
          navigate({ name: 'homework', homeworkId })
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <form
        className={ui.stack}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2 className={ui.sectionTitle} style={{ margin: 0 }}>
          {pt('grade')}
        </h2>
        <Field label={pt('score')}>
          <TextInput
            inputMode="decimal"
            value={score}
            disabled={pending}
            onChange={(e) => setScore(e.target.value)}
          />
        </Field>
        <Field label={pt('comment')}>
          <TextArea
            rows={6}
            value={comment}
            disabled={pending}
            onChange={(e) => setComment(e.target.value)}
          />
        </Field>
        {savedAt ? (
          <div className={`${ui.muted} ${ui.small}`}>
            {pt('gradedAt', { time: formatDateTime(savedAt) })}
          </div>
        ) : null}
        <div className={ui.row}>
          <Button
            type="submit"
            size="m"
            variant={hasSubmission ? 'outlined' : 'primary'}
            disabled={pending || !scoreValid}
          >
            {pt('saveGrade')}
          </Button>
          {hasSubmission ? (
            <Button size="m" onClick={() => void save(true)} disabled={pending || !scoreValid}>
              {pt('saveAndNext')}
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  )
}
