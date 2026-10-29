import { useState } from 'react'
import { copyText } from '../lib/share'
import { vibrate } from '../lib/util'

/** Copies the share text. `compact` = just the button (no preview of the text). */
export function ShareButton({ text, compact = false }: { text: string; compact?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const onClick = async () => {
    vibrate(12)
    const ok = await copyText(text)
    setState(ok ? 'copied' : 'failed')
    setTimeout(() => setState('idle'), 2000)
  }
  return (
    <div className={`share ${compact ? 'compact' : ''}`}>
      {(!compact || state === 'failed') && <div className="share-preview">{text}</div>}
      <button className={`cta share-btn ${compact ? 'ghost' : ''}`} onClick={onClick} title={compact ? text : undefined}>
        {state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Copy failed – select the text' : compact ? 'Share' : 'Share result'}
      </button>
    </div>
  )
}
