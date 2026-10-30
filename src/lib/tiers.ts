// Player card tiers, by the overall rating (OVR, 0-100).
export interface Tier {
  id: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'elite'
  name: string
  min: number
  max: number
}

export const TIERS: Tier[] = [
  { id: 'bronze', name: 'Bronze', min: 0, max: 20 },
  { id: 'silver', name: 'Silver', min: 21, max: 35 },
  { id: 'gold', name: 'Gold', min: 36, max: 50 },
  { id: 'platinum', name: 'Platinum', min: 51, max: 70 },
  { id: 'diamond', name: 'Diamond', min: 71, max: 90 },
  { id: 'elite', name: 'Elite', min: 91, max: 100 },
]

export const tierOf = (ovr: number): Tier => TIERS.find((t) => Math.round(ovr) <= t.max) ?? TIERS[TIERS.length - 1]
