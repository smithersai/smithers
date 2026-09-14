import { useSyncExternalStore } from 'react'

const query = '(pointer: coarse)'
const snapshot = () => globalThis.matchMedia?.(query).matches === true
const subscribe = (changed: () => void) => {
  const media = globalThis.matchMedia?.(query)
  media?.addEventListener('change', changed)
  return () => media?.removeEventListener('change', changed)
}
/** Hardware capability, not viewport width; updated when the primary pointer changes. */
export const useCoarsePointer = () => useSyncExternalStore(subscribe, snapshot, () => false)
