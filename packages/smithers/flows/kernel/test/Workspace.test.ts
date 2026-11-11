import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { sep } from "node:path"
import * as Workspace from "../src/Workspace.vibe"

describe("Workspace", () => {
  it.each(
    [
      ["an empty root", ""],
      ["a relative root", "work/tree"],
      ["a trailing platform separator", `work${sep}`]
    ] as const
  )("preserves %s as policy configuration", (_name, root) => {
    expect(Workspace.make(root).root).toBe(root)
  })

  it.effect("provides the exact configured root through its layer", () =>
    Effect.gen(function*() {
      const root = `relative${sep}`
      const configured = yield* (
        Effect.gen(function*() {
          const workspace = yield* Workspace.Workspace
          return workspace.root
        }).pipe(Effect.provide(Workspace.layer(root)))
      )

      expect(configured).toBe(root)
      expect(Workspace.makeNoop.root).toBe(".")
    }))
})
