import { regionCodes, regionNameOverrides } from './locationData.js'

export { regionCodes } from './locationData.js'

/** The user's country or region, told to the model so answers can fit local context. */
export type UserLocation = {
  region: string
}

const regions = new Set(regionCodes)
const regionNames = new Intl.DisplayNames(['en-US'], { type: 'region' })

export const getRegionName = (code: string): string =>
  regions.has(code) ? (regionNameOverrides[code] ?? regionNames.of(code) ?? code) : ''

/** A stored location, or null when it is not a known region. Older saved values may also carry
 * a province and city; only the region is kept. */
export const normalizeLocation = (value: unknown): UserLocation | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const { region } = value as Record<string, unknown>
  return typeof region === 'string' && regions.has(region) ? { region } : null
}
