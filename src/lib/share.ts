import { square } from '../game/scoring'
import { shortDate } from './util'

/** "Scan & Play – 28 Oct 🟩🟩🟨🟩🟥 Brain Score 81" */
export function shareText(brains: number[], score: number, training = false): string {
  return `Scan & Play${training ? ' training' : ''} – ${shortDate()} ${brains.map(square).join('')} Brain Score ${score}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fallback for insecure contexts / older browsers
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
