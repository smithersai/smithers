/** Standalone suites that EVAL_ONLY can select, and the files the eval runner collects. */
export const STANDALONE_EVALS = {
  timeline: "evals/timeline.eval.ts",
  "todo-steer": "evals/todo-steer.eval.ts",
  "todo-lint": "evals/todo-lint.eval.ts",
  "ui-judge": "evals/ui-judge.eval.ts",
  memory: "evals/memory.eval.ts",
} as const

/** The UI calibration also accompanies these case selections. */
const uiJudgeCases = new Set(["form-ask", "form-clone-no-url", "board", "flow-new", "own-alerts"])

/** Keep unselected standalone suites out of collection, including suites without their own skip. */
export const evalFiles = (only: string | undefined): ReadonlyArray<string> => {
  const selected = only?.split(",").map(name => name.trim()).filter(Boolean) ?? []
  return ["evals/agent.eval.ts", "evals/flows.eval.ts", ...Object.entries(STANDALONE_EVALS)
    .filter(([name]) => selected.length === 0 || selected.includes(name) || name === "ui-judge" && selected.some(value => uiJudgeCases.has(value))).map(([, file]) => file)]
}
