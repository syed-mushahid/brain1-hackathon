import { useEffect, useState } from 'react'

/** Live result of a CSS media query, e.g. useMedia('(min-width: 1024px)'). */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const onChange = () => setOn(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return on
}
