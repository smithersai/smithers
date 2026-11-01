// How evals/timeline.eval.ts grades one conversation: what each phase is judged against, and the absolute bars every
// fixture must clear (Astra finding 12, 2026-10-31). A bar is a product promise, not a baseline: a summary that names
// the wrong release fails at any baseline.

/**
 * The least each fixture must score. Judge scores are the Jev judge's mean probability of yes; `boundaryF1` is
 * against a person's own division; `summariesMade` is the share of messages that got a usable summary.
 */
export const GATES = {
  summariesMade: 0.95,
  entryAccurate: 0.85,
  entrySpecific: 0.75,
  boundaryF1: 0.6,
  boundaries: 0.6,
  titles: 0.8,
  faithful: 0.8,
} as const

export interface JudgedPhase { readonly from: number; readonly title: string; readonly summary: string }

/** Each phase with the exchanges it spans: from its start to the next phase's, the last to the conversation's end. */
export const phaseExchanges = <P extends JudgedPhase>(phases: ReadonlyArray<P>, exchanges: ReadonlyArray<readonly [string, string]>) =>
  phases.map((phase, index) => ({
    ...phase,
    exchanges: exchanges.slice(phase.from, phases[index + 1]?.from ?? exchanges.length)
      .map(([question, answer], offset) => ({ n: phase.from + offset, question, answer })),
  }))

/** Every gate `scores` is under, as `<fixture>: <score> <value> < <gate>`. */
export const gateFailures = (fixture: string, scores: Partial<Readonly<Record<keyof typeof GATES, number>>>): ReadonlyArray<string> =>
  Object.entries(GATES).flatMap(([name, gate]) => {
    const score = scores[name as keyof typeof GATES] ?? 0
    return score < gate ? [`${fixture}: ${name} ${score.toFixed(3)} < ${gate}`] : []
  })
