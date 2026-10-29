import { useState } from 'react'
import { copyText } from '../lib/share'
import { vibrate } from '../lib/util'

export function ShareButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const onClick = async () => {
    vibrate(12)
    const ok = await copyText(text)
    setState(ok ? 'copied' : 'failed')
    setTimeout(() => setState('idle'), 2000)
  }
  return (
    <div className="share">
      <div className="share-preview">{text}</div>
      <button className="cta share-btn" onClick={onClick}>
        {state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Copy failed – select the text' : 'Share result'}
      </button>
    </div>
  )
}
