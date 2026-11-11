import { Effect } from "effect"
import { expect, it } from "vitest"
import { Process } from "../src/internal/Process.vibe"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.vibe"

it("host ports default to native-adapter selection when no service was supplied", () => {
  Effect.runSync(Effect.gen(function*() {
    expect(yield* Process).toBeUndefined()
    expect(yield* PublicationFileSystem).toBeUndefined()
  }))
})
