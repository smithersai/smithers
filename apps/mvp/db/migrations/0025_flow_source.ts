import { digestSync } from "@smthrs/crypto"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { renderSource, SOURCE_PATH } from "../../src/features/flows-ui/source.ts"

// One flow model (decision 0014 as Will ruled on 2026-10-20, docs/features/flows.md#your-own-flows): a person's flow is
// flow source, a `Flow.make` module, never a `SKILL.md`. This converts what 0015 stored as prompt flows:
//
// - `flows.placement`: where the latest revision runs, `client` (a drafted flow as drafted) or `sandbox` (any other
//   code). Every flow stored so far was drafted, so each is `client`.
// - `flow_revisions`: each `SKILL.md` becomes the module drafting writes today (`renderSource`) from its name,
//   description, calls and instructions, with that module's SHA-256 as its digest, so a run that pinned a revision
//   reads the same flow in its one form. Every stored revision was written by `renderSkill` and admitted after its
//   checks, so each reads; one that doesn't fails the migration, naming its flow and revision, never its text.
// - `flow_drafts.files`: each `SKILL.md` becomes `flow.ts` the same way. A draft whose file doesn't read keeps no file
//   and, unless it was saved, fails `migrated`, so drafting it again starts from what the person asked.

/** What a `SKILL.md` that `renderSkill` wrote declared. */
interface Skill {
  readonly name: string
  readonly description: string
  readonly flows: ReadonlyArray<string>
  readonly instructions: string
}

/** A YAML scalar as `renderSkill` wrote it: a JSON string, or a plain word; `undefined` when the string is broken. */
const scalar = (text: string): string | undefined => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("\"")) return trimmed
  try {
    // A JSON text that starts with a quote is a string, or not JSON at all.
    return JSON.parse(trimmed) as string
  } catch {
    return undefined
  }
}

/** A `SKILL.md` as `renderSkill` wrote it: its frontmatter's name, description and flows, and its instructions. */
const readSkill = (text: string): Skill | undefined => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  let name: string | undefined
  let description: string | undefined
  const flows: Array<string | undefined> = []
  for (const line of match[1]!.split("\n")) {
    if (line.startsWith("name: ")) name = scalar(line.slice("name: ".length))
    else if (line.startsWith("description: ")) description = scalar(line.slice("description: ".length))
    else if (line.startsWith("  - ")) flows.push(scalar(line.slice("  - ".length)))
  }
  if (name === undefined || name === "" || description === undefined) return undefined
  if (!flows.every((flow): flow is string => flow !== undefined)) return undefined
  return { name, description, flows, instructions: match[2]!.trim() }
}

/** A `SKILL.md`'s module: the source drafting writes for what it declared, or `undefined` when it doesn't read. */
const sourceOf = (text: string): string | undefined => {
  const skill = readSkill(text)
  return skill === undefined ? undefined : renderSource(skill)
}

/** One file of a draft. */
interface File {
  readonly path: string
  readonly text: string
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE flows ADD COLUMN placement text NOT NULL DEFAULT 'client' CHECK (placement IN ('client', 'sandbox'))`

  const revisions = yield* sql<{ readonly flowId: string; readonly revision: number; readonly source: string }>`
    SELECT flow_id AS "flowId", revision, source FROM flow_revisions WHERE source LIKE '---%' ORDER BY flow_id, revision`
  for (const row of revisions) {
    const source = sourceOf(row.source)
    if (source === undefined) {
      return yield* Effect.die(new Error(`0025_flow_source: flow ${row.flowId} revision ${row.revision} doesn't read`))
    }
    yield* sql`
      UPDATE flow_revisions SET source = ${source}, digest = ${digestSync(source)}
      WHERE flow_id = ${row.flowId} AND revision = ${row.revision}`
  }

  const drafts = yield* sql<{ readonly id: string; readonly status: string; readonly files: ReadonlyArray<File> }>`
    SELECT id, status, files FROM flow_drafts WHERE files @> '[{"path": "SKILL.md"}]'::jsonb ORDER BY id`
  for (const draft of drafts) {
    const files = draft.files.map((file) => {
      if (file.path !== "SKILL.md") return file
      const source = sourceOf(file.text)
      return source === undefined ? undefined : { path: SOURCE_PATH, text: source }
    })
    if (files.every((file): file is File => file !== undefined)) {
      yield* sql`UPDATE flow_drafts SET files = ${JSON.stringify(files)}::jsonb WHERE id = ${draft.id}`
    } else if (draft.status === "saved" || draft.status === "proposed") {
      yield* sql`UPDATE flow_drafts SET files = '[]'::jsonb WHERE id = ${draft.id}`
    } else {
      yield* sql`
        UPDATE flow_drafts SET files = '[]'::jsonb, checks = '[]'::jsonb, status = 'failed', failure = 'migrated'
        WHERE id = ${draft.id}`
    }
  }
})
