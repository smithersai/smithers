/** Issue lifecycle policy shared by flows and plugin UI (decision 0018). */
export const NEEDS_REPRO_LABEL = "smithers:needs-repro"
export const NEEDS_REPRO_COMMENT = "Please add a minimal reproduction: a short repository snippet or a failing test."
export const REPRO_COMMENT_NAMESPACE = "830b60db-6016-453a-8b4b-e40dcf152aac"

/** Labels are authoritative; explicit bug titles also cover repositories without a bug label. */
export const isBug = (title: string, labels: ReadonlyArray<string>): boolean =>
  labels.some((label) => /^(?:type[:/]\s*)?bug$/i.test(label)) || /^\s*(?:\[bug\]|bug\s*:)/i.test(title)

/** A candidate snippet is not a verified reproduction; verification requires sandbox execution on main. */
export const hasReproCandidate = (texts: ReadonlyArray<string>): boolean =>
  texts.some((text) => {
    let fence: string | undefined
    let content = false
    for (const line of text.split(/\r?\n/)) {
      if (fence === undefined) {
        const opening = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
        if (opening === null || (opening[1]![0] === "`" && opening[2]!.includes("`"))) continue
        fence = opening[1]!
      } else {
        const closing = /^[ \t]*(`+|~+)[ \t]*$/.exec(line)
        if (closing !== null && closing[1]![0] === fence[0] && closing[1]!.length >= fence.length) {
          if (content) return true
          fence = undefined
          content = false
        } else if (/\S/.test(line)) content = true
      }
    }
    return false
  })

export const COMMITMENTS = ["now", "next", "later", "none"] as const
export type Commitment = (typeof COMMITMENTS)[number]
export const COMMITMENT_COPY: Readonly<Record<Commitment, string>> = {
  now: "Now", next: "Next", later: "Later", none: "Unscheduled",
}
export const commitmentLabel = (commitment: Commitment): string => `smithers:commit-${commitment}`
export const commitmentOf = (labels: ReadonlyArray<string>): Commitment | "conflict" | null => {
  const names = new Set(labels.map((name) => name.toLowerCase()))
  const found = COMMITMENTS.filter((commitment) => names.has(commitmentLabel(commitment)))
  return found.length > 1 ? "conflict" : found[0] ?? null
}

/** Commitment filters are URL state, so a reload or shared link retains them. */
export const commitmentSearch = (search: Record<string, unknown>): { readonly commitment?: Commitment } =>
  typeof search.commitment === "string" && (COMMITMENTS as ReadonlyArray<string>).includes(search.commitment)
    ? { commitment: search.commitment as Commitment } : {}
export const filterCommitment = <A extends { readonly commitment?: string | null }>(rows: ReadonlyArray<A>, commitment?: Commitment): ReadonlyArray<A> =>
  commitment === undefined ? rows : rows.filter((row) => (row.commitment || "none") === commitment)
