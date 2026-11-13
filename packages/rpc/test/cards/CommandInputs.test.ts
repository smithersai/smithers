/**
 * Fixture producer checks for TODO drafts, cancellation and model settings: bound actions produce their
 * declared command inputs.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import type { z } from "zod"
import {
  type Action,
  ConfirmCancelInputSchema,
  DraftDiscardInputSchema,
  SettingsModelSetInputSchema
} from "../../src/CardAction.ts"
import type { ConfirmCard } from "../../src/ConfirmCard.ts"
import { TodoNewInputSchema } from "../../src/TodoCommands.ts"
import { fixtures as agent } from "../fixtures/Agent.ts"
import { fixtures as confirm } from "../fixtures/Confirm.ts"
import { fixtures as draft } from "../fixtures/Draft.ts"

const actions = (stories: Readonly<Record<string, { readonly actions: ReadonlyArray<Action> }>>) =>
  Object.values(stories).flatMap((story) => story.actions)
// The input a View sends: the bound args plus each form field's prefill.
const produced = (action: Action): Record<string, string> => ({
  ...action.args,
  ...Object.fromEntries(
    (action.input ?? []).flatMap((field) => field.value === undefined ? [] : [[field.name, field.value]])
  )
})
const bound = (tag: Action["tag"], list: ReadonlyArray<Action>) => list.filter((action) => action.tag === tag)
const strict = (schema: z.ZodObject) => schema.strict()

describe("todo.new fixtures", () => {
  test("each Draft Commit names the Draft it commits and produces a declared input", () => {
    const commits = bound("todo.new", actions(draft))
    expect(commits.length).toBeGreaterThan(0)
    for (const fixture of Object.values(draft)) {
      for (const action of bound("todo.new", fixture.actions)) {
        const input = strict(TodoNewInputSchema).parse(produced(action))
        expect(input).toEqual({ cardId: fixture.gestures.set?.args?.entry })
        expect(input.cardId).toBe("entry-draft-1")
        expect(action.label).toBe("Commit")
      }
    }
  })
  test("Edit instructions opens a Draft with the agent's instructions path and no Commit id", () => {
    for (const fixture of Object.values(agent)) {
      const edits = bound("todo.new", fixture.actions)
      expect(edits).toHaveLength(1)
      const input = strict(TodoNewInputSchema).parse(produced(edits[0]!))
      expect(input.text).toContain(fixture.model.instructions_path)
      expect(input.cardId).toBeUndefined()
      expect(edits[0]!.label).toBe("Edit instructions")
    }
  })
})

describe("draft.discard", () => {
  const discards = bound("draft.discard", actions(draft))
  test("every uncommitted Draft offers Discard; a committed one does not", () => {
    for (const [key, story] of Object.entries(draft)) {
      const offered = story.actions.some((action) => action.tag === "draft.discard")
      expect(offered, key).toBe(story.model.committed === undefined)
    }
    expect(discards.length).toBeGreaterThan(0)
  })
  test("produces exactly { draft }", () => {
    for (const action of discards) expect(strict(DraftDiscardInputSchema).parse(produced(action))).toEqual(action.args)
    expect(DraftDiscardInputSchema.safeParse({ draft: "" }).success).toBe(false)
    expect(strict(DraftDiscardInputSchema).safeParse({ draft: "entry-draft-1", author: "ben" }).success).toBe(false)
  })
})

describe("confirm.cancel", () => {
  test("every pending confirmation with a revision offers Cancel bound to that revision; receipts do not", () => {
    for (const [key, story] of Object.entries(confirm)) {
      const cancel = bound("confirm.cancel", story.actions)
      const pending = (story.model as ConfirmCard).receipt === undefined &&
        (story.model as ConfirmCard).subject.revision !== undefined
      expect(cancel.length, key).toBe(pending ? 1 : 0)
      if (pending) expect(cancel[0]!.args?.revision).toBe((story.model as ConfirmCard).subject.revision)
    }
  })
  test("produces exactly { confirmation, revision }", () => {
    const cancels = bound("confirm.cancel", actions(confirm))
    expect(cancels.length).toBeGreaterThan(0)
    for (const action of cancels) {
      expect(strict(ConfirmCancelInputSchema).parse(produced(action))).toEqual(action.args)
    }
    for (const key of ["confirmation", "revision"] as const) {
      const { [key]: _removed, ...rest } = produced(cancels[0]!)
      expect(ConfirmCancelInputSchema.safeParse(rest).success, key).toBe(false)
    }
  })
})

describe("settings.model.set", () => {
  // Literal oracle: the role ids (mvp.md §6.5); `jev` shows as "Decisions".
  const ROLES = ["fast", "coding", "jev"] as const
  const sets = bound("settings.model.set", actions(agent))
  test("the Agent card offers Change model", () => {
    expect(bound("settings.model.set", agent.coding.actions)).toHaveLength(1)
  })
  test("produces exactly { role, model } with a catalog model id", () => {
    expect(sets.length).toBeGreaterThan(0)
    for (const action of sets) expect(strict(SettingsModelSetInputSchema).parse(produced(action))).toBeTruthy()
  })
  test.each(ROLES)("accepts role %s", (role) => {
    expect(SettingsModelSetInputSchema.safeParse({ role, model: "gpt-6.1-sol" }).success).toBe(true)
  })
  test.each(["decisions", "Decisions", "gateway", "app", ""])("rejects role %j", (role) => {
    expect(SettingsModelSetInputSchema.safeParse({ role, model: "gpt-6.1-sol" }).success).toBe(false)
  })
  test.each(["", "has space", "-flag", "x".repeat(82)])("rejects model id %j", (model) => {
    expect(SettingsModelSetInputSchema.safeParse({ role: "coding", model }).success).toBe(false)
  })
  test("the Agent card keeps internal role ids out of labels", () => {
    const labels = actions(agent).flatMap((action) => [
      action.label,
      ...(action.input ?? []).map((field) => field.label)
    ])
    expect(labels.filter((label) => /jev/i.test(label))).toEqual([])
    expect(labels).toContain("Change model")
  })
})
