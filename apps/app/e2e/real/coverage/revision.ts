/** A caller label cannot replace the independently detected checkout identity. */
export const admitSourceRevision = (detected: string | undefined, requested: string | undefined): string => {
  if (!detected || !/^[0-9a-f]{40,64}$/.test(detected)) throw new Error("Cannot identify the exact tested checkout revision.")
  if (requested !== undefined && requested !== detected) {
    throw new Error("SMITHERS_REAL_E2E_REVISION does not match the actual checkout revision; refusing to launch the suite.")
  }
  return detected
}
