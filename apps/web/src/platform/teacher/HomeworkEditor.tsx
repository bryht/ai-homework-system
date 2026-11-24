import {
  DEFAULT_AI_CONFIG,
  TEACHING_TEMPLATES,
  type AiConfig,
  type ClassInfo,
  type Homework,
  type ModelOption,
  type TeachingMode,
} from '@hw/shared'
import { useEffect, useState } from 'react'
import { Button } from '../../components/base/Button.js'
import { Modal } from '../../components/base/Modal.js'
import { Select } from '../../components/base/Select.js'
import { api } from '../api.js'
import { usePt, type PlatformKey } from '../i18n.js'
import { navigate } from '../router.js'
import {
  Card,
  Checkbox,
  ErrorState,
  Field,
  Loading,
  TextArea,
  TextInput,
  TitleRow,
  ui,
} from '../ui/components.js'
import { fromLocalInput, toLocalInput } from '../ui/format.js'
import { useAsync } from '../ui/hooks.js'

type Form = {
  classId: string
  title: string
  description: string
  startAt: string
  dueAt: string
  published: boolean
  allowLateSubmission: boolean
  aiConfig: AiConfig
  tokenBudgetText: string
}

const MODES: { value: TeachingMode; label: PlatformKey }[] = [
  { value: 'socratic', label: 'modeSocratic' },
  { value: 'explain', label: 'modeExplain' },
  { value: 'open', label: 'modeOpen' },
  { value: 'custom', label: 'modeCustom' },
]

const newForm = (classes: ClassInfo[], models: ModelOption[]): Form => {
  const start = new Date()
  start.setMinutes(0, 0, 0)
  const due = new Date(start.getTime() + 14 * 86_400_000)
  due.setHours(23, 59, 0, 0)
  const model = models.some((m) => m.id === DEFAULT_AI_CONFIG.model)
    ? DEFAULT_AI_CONFIG.model
    : (models[0]?.id ?? '')
  return {
    classId: classes[0]?.id ?? '',
    title: '',
    description: '',
    startAt: toLocalInput(start.toISOString()),
    dueAt: toLocalInput(due.toISOString()),
    published: true,
    allowLateSubmission: false,
    aiConfig: { ...DEFAULT_AI_CONFIG, model },
    tokenBudgetText: String(DEFAULT_AI_CONFIG.tokenBudget ?? ''),
  }
}

const fromHomework = (hw: Homework): Form => ({
  classId: hw.classId,
  title: hw.title,
  description: hw.description,
  startAt: toLocalInput(hw.startAt),
  dueAt: toLocalInput(hw.dueAt),
  published: hw.status === 'published',
  allowLateSubmission: hw.allowLateSubmission,
  aiConfig: hw.aiConfig,
  tokenBudgetText: hw.aiConfig.tokenBudget === null ? '' : String(hw.aiConfig.tokenBudget),
})

export const HomeworkEditor = ({ homeworkId }: { homeworkId?: string }) => {
  const pt = usePt()
  const { data, error, reload } = useAsync(async () => {
    const [{ classes }, { models }, existing] = await Promise.all([
      api<{ classes: ClassInfo[] }>('/api/classes'),
      api<{ models: ModelOption[] }>('/api/models'),
      homeworkId
        ? api<{ homework: Homework }>(`/api/homeworks/${homeworkId}`)
        : Promise.resolve(null),
    ])
    return { classes, models, homework: existing?.homework ?? null }
  }, [homeworkId])
  const [form, setForm] = useState<Form | null>(null)
  const [pending, setPending] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    if (data && !form) {
      setForm(data.homework ? fromHomework(data.homework) : newForm(data.classes, data.models))
    }
  }, [data, form])

  if (error) {
    return <ErrorState message={error} onRetry={reload} />
  }
  if (!data || !form) {
    return <Loading />
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value })
  const setAi = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) =>
    setForm({ ...form, aiConfig: { ...form.aiConfig, [key]: value } })

  const model = data.models.find((m) => m.id === form.aiConfig.model)
  const webSearchUnavailable = model?.supportsWebSearch === false
  const allowWebSearch = form.aiConfig.allowWebSearch && !webSearchUnavailable
  const budget = form.tokenBudgetText.trim() === '' ? null : Number(form.tokenBudgetText)
  const budgetValid = budget === null || (Number.isInteger(budget) && budget > 0)
  const valid =
    form.classId &&
    form.title.trim() &&
    form.startAt &&
    form.dueAt &&
    form.aiConfig.model &&
    budgetValid

  const save = async () => {
    setPending(true)
    setSaveError(null)
    const payload = {
      title: form.title.trim(),
      description: form.description,
      startAt: fromLocalInput(form.startAt),
      dueAt: fromLocalInput(form.dueAt),
      status: form.published ? 'published' : 'draft',
      allowLateSubmission: form.allowLateSubmission,
      aiConfig: { ...form.aiConfig, allowWebSearch, tokenBudget: budget },
    }
    try {
      const { homework } = homeworkId
        ? await api<{ homework: Homework }>(`/api/homeworks/${homeworkId}`, {
            method: 'PATCH',
            json: payload,
          })
        : await api<{ homework: Homework }>('/api/homeworks', {
            method: 'POST',
            json: { ...payload, classId: form.classId },
          })
      navigate({ name: 'homework', homeworkId: homework.id })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const remove = async () => {
    if (!homeworkId || pending) {
      return
    }
    setPending(true)
    setSaveError(null)
    try {
      await api(`/api/homeworks/${homeworkId}`, { method: 'DELETE' })
      navigate({ name: 'home' })
    } catch (e) {
      setDeleteOpen(false)
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <TitleRow
        title={homeworkId ? form.title || pt('edit') : pt('newHomework')}
        back={homeworkId ? { name: 'homework', homeworkId } : { name: 'home' }}
      />
      <form
        className={ui.stack}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Card>
          <div className={ui.formGrid}>
            <Field label={pt('title')} className={ui.span2}>
              <TextInput
                value={form.title}
                maxLength={200}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <Field label={pt('klass')}>
              <Select
                value={form.classId}
                disabled={Boolean(homeworkId)}
                options={data.classes.map((c) => ({ value: c.id, label: c.name }))}
                onChange={(value) => set('classId', value)}
              />
            </Field>
            <div />
            <Field label={pt('startAt')}>
              <TextInput
                type="datetime-local"
                value={form.startAt}
                onChange={(e) => set('startAt', e.target.value)}
              />
            </Field>
            <Field label={pt('dueAt2')}>
              <TextInput
                type="datetime-local"
                value={form.dueAt}
                onChange={(e) => set('dueAt', e.target.value)}
              />
            </Field>
            <Field label={pt('description')} className={ui.span2}>
              <TextArea
                rows={8}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>
            <div className={ui.span2}>
              <div className={ui.stack} style={{ gap: 8 }}>
                <Checkbox
                  checked={form.published}
                  onChange={(v) => set('published', v)}
                  label={pt('publishNow')}
                />
                <Checkbox
                  checked={form.allowLateSubmission}
                  onChange={(v) => set('allowLateSubmission', v)}
                  label={pt('allowLate')}
                />
              </div>
            </div>
          </div>
        </Card>
        <Card>
          <div className={ui.formGrid}>
            <h2 className={`${ui.sectionTitle} ${ui.span2}`} style={{ margin: 0 }}>
              {pt('aiSettings')}
            </h2>
            <Field
              label={pt('model')}
              hint={model?.provider === 'mock' ? pt('mockModelHint') : undefined}
            >
              <Select
                value={form.aiConfig.model}
                options={data.models.map((m) => ({ value: m.id, label: m.label }))}
                onChange={(value) => setAi('model', value)}
              />
            </Field>
            <Field label={pt('teachingMode')}>
              <Select
                value={form.aiConfig.teachingMode}
                options={MODES.map((m) => ({ value: m.value, label: pt(m.label) }))}
                onChange={(mode) =>
                  setForm({
                    ...form,
                    aiConfig: {
                      ...form.aiConfig,
                      teachingMode: mode,
                      systemPrompt:
                        mode === 'custom' ? form.aiConfig.systemPrompt : TEACHING_TEMPLATES[mode],
                    },
                  })
                }
              />
            </Field>
            <Field label={pt('systemPrompt')} hint={pt('systemPromptHint')} className={ui.span2}>
              <TextArea
                rows={8}
                value={form.aiConfig.systemPrompt}
                onChange={(e) => {
                  const text = e.target.value
                  const mode = form.aiConfig.teachingMode
                  setForm({
                    ...form,
                    aiConfig: {
                      ...form.aiConfig,
                      systemPrompt: text,
                      // 改过模板就算自定义
                      teachingMode:
                        mode !== 'custom' && text !== TEACHING_TEMPLATES[mode] ? 'custom' : mode,
                    },
                  })
                }}
              />
            </Field>
            <div className={ui.span2}>
              <div className={ui.stack} style={{ gap: 8 }}>
                <Checkbox
                  checked={form.aiConfig.allowFileUpload}
                  onChange={(v) => setAi('allowFileUpload', v)}
                  label={pt('allowFileUpload')}
                  disabled={model ? !model.supportsFiles : false}
                />
                <Checkbox
                  checked={form.aiConfig.allowThinking}
                  onChange={(v) => setAi('allowThinking', v)}
                  label={pt('allowThinking')}
                  disabled={model ? !model.supportsThinking : false}
                />
                <div>
                  <Checkbox
                    checked={allowWebSearch}
                    onChange={(v) => setAi('allowWebSearch', v)}
                    label={pt('allowWebSearch')}
                    disabled={webSearchUnavailable}
                  />
                  {webSearchUnavailable ? (
                    <div className={ui.hint}>{pt('webSearchUnavailable')}</div>
                  ) : null}
                </div>
              </div>
            </div>
            <Field label={pt('tokenBudget')} hint={pt('tokenBudgetHint')}>
              <TextInput
                inputMode="numeric"
                value={form.tokenBudgetText}
                onChange={(e) => set('tokenBudgetText', e.target.value.replace(/[^\d]/g, ''))}
              />
            </Field>
          </div>
        </Card>
        {saveError ? <div className={ui.error}>{saveError}</div> : null}
        <div className={ui.row}>
          <Button type="submit" disabled={pending || !valid}>
            {pt('save')}
          </Button>
          <Button variant="outlined" onClick={() => window.history.back()}>
            {pt('cancel')}
          </Button>
          {homeworkId ? (
            <Button variant="dangerOutlined" disabled={pending} onClick={() => setDeleteOpen(true)}>
              {pt('deleteHomework')}
            </Button>
          ) : null}
        </div>
      </form>
      {deleteOpen ? (
        <Modal
          title={pt('deleteHomework')}
          onClose={() => !pending && setDeleteOpen(false)}
          footer={
            <>
              <Button variant="outlined" disabled={pending} onClick={() => setDeleteOpen(false)}>
                {pt('cancel')}
              </Button>
              <Button variant="danger" disabled={pending} onClick={() => void remove()}>
                {pt('deleteHomework')}
              </Button>
            </>
          }
        >
          {pt('confirmDeleteHomework', { title: data.homework?.title ?? form.title })}
        </Modal>
      ) : null}
    </>
  )
}
