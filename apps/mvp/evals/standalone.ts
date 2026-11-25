/** Standalone suites that EVAL_ONLY can select, and the files the eval runner collects. */
export const STANDALONE_EVALS = {
  timeline: "evals/timeline.eval.ts",
  "todo-steer": "evals/todo-steer.eval.ts",
  "todo-lint": "evals/todo-lint.eval.ts",
  "ui-judge": "evals/ui-judge.eval.ts",
} as const

/** Keep selections precise so a typo never collects an empty eval run. */
export const evalFiles = (only: string | undefined): ReadonlyArray<string> => {
  const selected = (only ?? "").split(",").map((name) => name.trim()).filter(Boolean)
  if (selected.length === 0) return Object.values(STANDALONE_EVALS)
  return [...new Set(selected)].map((name) => {
    if (!Object.hasOwn(STANDALONE_EVALS, name)) throw new Error(`no eval is named ${name}`)
    return STANDALONE_EVALS[name as keyof typeof STANDALONE_EVALS]
  })
}
