import { useCallback, useEffect, useRef, useState } from 'react'

/** 加载数据：返回 data / error / reload。依赖变化时重新加载，过期的结果会被丢弃 */
export const useAsync = <T>(load: () => Promise<T>, deps: unknown[]) => {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  })
  const seq = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const reload = useCallback(() => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null }))
    loadRef
      .current()
      .then((data) => id === seq.current && setState({ data, error: null, loading: false }))
      .catch(
        (error: unknown) =>
          id === seq.current &&
          setState((s) => ({
            ...s,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          }))
      )
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps)
  return { ...state, reload, setData: (data: T) => setState((s) => ({ ...s, data })) }
}
