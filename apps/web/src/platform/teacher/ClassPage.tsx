import type { ClassInfo, ClassStudent, CreatedCredential } from '@hw/shared'
import { useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { Modal } from '../../components/base/Modal.js'
import { showToast } from '../../components/base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { api } from '../api.js'
import { usePt } from '../i18n.js'
import {
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  TextArea,
  TitleRow,
  ui,
} from '../ui/components.js'
import { downloadText } from '../ui/format.js'
import { useAsync } from '../ui/hooks.js'

/** 「姓名」或「姓名, 用户名」，逗号可以是中文逗号或制表符 */
const parseRoster = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', username] = line.split(/\s*[,，\t]\s*/)
      return username ? { name, username } : { name }
    })

const credentialsCsv = (list: CreatedCredential[]) =>
  '﻿name,username,password\r\n' +
  list
    .map((c) =>
      [c.name, c.username, c.password ?? ''].map((v) => `"${v.replaceAll('"', '""')}"`).join(',')
    )
    .join('\r\n')

export const ClassPage = ({ classId }: { classId: string }) => {
  const pt = usePt()
  const { data, error, reload } = useAsync(async () => {
    const [{ classes }, { students }] = await Promise.all([
      api<{ classes: ClassInfo[] }>('/api/classes'),
      api<{ students: ClassStudent[] }>(`/api/classes/${classId}/students`),
    ])
    return { klass: classes.find((c) => c.id === classId), students }
  }, [classId])
  const [roster, setRoster] = useState('')
  const [pending, setPending] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<CreatedCredential[] | null>(null)
  const [removing, setRemoving] = useState<ClassStudent | null>(null)

  const add = async () => {
    setPending(true)
    setAddError(null)
    try {
      const result = await api<{ credentials: CreatedCredential[] }>(
        `/api/classes/${classId}/students`,
        {
          method: 'POST',
          json: { students: parseRoster(roster) },
        }
      )
      setRoster('')
      setCredentials(result.credentials)
      reload()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const resetPassword = async (student: ClassStudent) => {
    try {
      const { credential } = await api<{ credential: CreatedCredential }>(
        `/api/classes/${classId}/students/${student.id}/reset-password`,
        { method: 'POST' }
      )
      setCredentials([credential])
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (student: ClassStudent) => {
    try {
      await api(`/api/classes/${classId}/students/${student.id}`, { method: 'DELETE' })
      setRemoving(null)
      reload()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  if (error) {
    return <ErrorState message={error} onRetry={reload} />
  }
  if (!data) {
    return <Loading />
  }
  return (
    <>
      <TitleRow title={data.klass?.name ?? ''} back={{ name: 'classes' }} />
      <div className={ui.stack}>
        <Card>
          <form
            className={ui.stack}
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <Field label={pt('addStudents')} hint={pt('addStudentsHint')}>
              <TextArea
                rows={5}
                className={ui.mono}
                placeholder={'Emma Chen\nLiam Patel, liam\nSofia Garcia'}
                value={roster}
                onChange={(e) => setRoster(e.target.value)}
              />
            </Field>
            {addError ? <div className={ui.error}>{addError}</div> : null}
            <div>
              <Button type="submit" size="m" disabled={pending || parseRoster(roster).length === 0}>
                {pt('addStudents')}
              </Button>
            </div>
          </form>
        </Card>
        <h2 className={ui.sectionTitle}>
          {pt('students')} · {data.students.length}
        </h2>
        {data.students.length === 0 ? (
          <Empty>—</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>{pt('name')}</th>
                  <th>{pt('username')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.students.map((student) => (
                  <tr key={student.id}>
                    <td>{student.name}</td>
                    <td className={ui.mono}>{student.username}</td>
                    <td>
                      <div
                        className={ui.row}
                        style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}
                      >
                        <Button
                          size="s"
                          variant="outlined"
                          onClick={() => void resetPassword(student)}
                        >
                          {pt('resetPassword')}
                        </Button>
                        <Button
                          size="s"
                          variant="dangerOutlined"
                          onClick={() => setRemoving(student)}
                        >
                          {pt('removeFromClass')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {credentials ? (
        <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
      ) : null}
      {removing ? (
        <Modal
          title={pt('removeFromClass')}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setRemoving(null)}>
                {pt('cancel')}
              </Button>
              <Button variant="danger" onClick={() => void remove(removing)}>
                {pt('removeFromClass')}
              </Button>
            </>
          }
        >
          {pt('confirmRemove', { name: removing.name })}
        </Modal>
      ) : null}
    </>
  )
}

const CredentialsDialog = ({
  credentials,
  onClose,
}: {
  credentials: CreatedCredential[]
  onClose: () => void
}) => {
  const pt = usePt()
  const text = credentials
    .map((c) => `${c.name}\t${c.username}\t${c.password ?? pt('existingAccount')}`)
    .join('\n')
  return (
    <Modal
      title={pt('credentialsTitle')}
      closable
      onClose={onClose}
      footer={
        <>
          <Button
            variant="outlined"
            onClick={() => downloadText('accounts.csv', credentialsCsv(credentials))}
          >
            {pt('downloadCsv')}
          </Button>
          <Button onClick={() => void copyText(text).then((ok) => ok && showToast(pt('copied')))}>
            {pt('copy')}
          </Button>
        </>
      }
    >
      <div className={ui.stack}>
        <div className={ui.notice}>{pt('credentialsHint')}</div>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>{pt('name')}</th>
                <th>{pt('username')}</th>
                <th>{pt('password')}</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className={ui.mono}>{c.username}</td>
                  <td className={c.password ? ui.mono : ui.muted}>
                    {c.password ?? pt('existingAccount')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}
