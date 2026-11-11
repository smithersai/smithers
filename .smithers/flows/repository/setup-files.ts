/**
 * The files a reviewed candidate writes into the repository: plain TypeScript
 * that refuses an unsafe step id by throwing `CodingError`, so `writeCandidate`
 * runs it through `Effect.try` and the held-out tests read it directly.
 */
import { Option, Schema } from "effect"
import { setupConfiguration } from "../../../packages/rpc/src/RepositorySetup.ts"
import { CodingError } from "../coding/schema.ts"
import { CaseInput } from "./evaluation.vibe"
import type { EvalCase, SetupInput } from "./schema.vibe"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
/** The repository keeps the executable test definition; the expected answer and the
 * deterministic assertions that decide it stay with the setup authority. An input the
 * case contract cannot read carries no assertions and is kept as the maintainer wrote it. */
export const publicCase = (test: typeof EvalCase.Type) => ({
  id: test.id,
  name: test.name,
  input: Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(CaseInput))(test.input), {
    onNone: () => test.input,
    onSome: ({ event, sourceRevision }) => JSON.stringify({ event, sourceRevision })
  }),
  required: test.required
})
export const candidateFiles = (input: SetupInput): Record<string, string> => {
  const cases = input.draft.cases.map(publicCase)
  // The retained candidate is the configuration this digest names. The trial's
  // own test request belongs to one trial press, so refilling it cannot edit it.
  const draft = { ...setupConfiguration(input.draft), cases }
  const files: Record<string, string> = {
    "candidate.json": JSON.stringify(
      { repo: input.repo, job: input.job, revision: input.revision, digest: input.digest, draft },
      null,
      2
    ) + "\n",
    "evals.json": JSON.stringify(cases, null, 2) + "\n"
  }
  for (const step of input.draft.steps) {
    if (!/^[A-Za-z0-9_-]+$/.test(step.id)) throw invalid("Step IDs must be safe repository filenames")
    files[`prompt-${step.id}.md`] = step.prompt + "\n"
  }
  return files
}
