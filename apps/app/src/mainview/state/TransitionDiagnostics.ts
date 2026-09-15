/** Only the derived diagnostic copy is bounded; accepted event inputs stay whole. */
export const MAX_TRANSITION_PAYLOAD_BYTES = 2 * 1024

const utf8 = new TextEncoder()
const bytes = (value: string): number => utf8.encode(value).byteLength

export const journalPayload = (payload: string): string => {
  const size = bytes(payload)
  if (size <= MAX_TRANSITION_PAYLOAD_BYTES) return payload
  const omitted = JSON.stringify({ elided: size })
  try {
    const bounded = JSON.stringify(JSON.parse(payload), (_key, value: unknown) => {
      if (typeof value === "string" && bytes(value) > 256) return { elidedBytes: bytes(value) }
      if (Array.isArray(value) && value.length > 2) return { elidedItems: value.length }
      return value
    })
    return bytes(bounded) <= MAX_TRANSITION_PAYLOAD_BYTES ? bounded : omitted
  } catch {
    return omitted
  }
}
