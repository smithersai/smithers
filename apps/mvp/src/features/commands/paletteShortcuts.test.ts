import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Layer, Option, Ref, Scope } from "effect"
import { describe, expect, test } from "vitest"
import { paletteShortcuts } from "./paletteShortcuts"
import { PALETTE, Palette } from "./schema"
import { CommandsStore, PALETTE_CLOSED } from "./store.vibe"

const keydown = (init: { key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }) =>
  Object.assign(new Event("keydown", { cancelable: true }), { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init })

describe("paletteShortcuts", () => {
  test("⌘P and Ctrl+P toggle the palette and prevent browser print; other keys are ignored", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const palette = yield* Collection.local<Palette, string>({
          id: "test-commands-palette",
          schema: Palette,
          getKey: (row) => row.id,
          initialData: [PALETTE_CLOSED],
        }).pipe(Scope.provide(scope))
        const store = Layer.succeed(CommandsStore, {
          menu: undefined as never,
          menuState: undefined as never,
          palette,
          paletteState: undefined as never,
          revision: yield* Ref.make(0),
          requestNamespace: "test",
          scope,
        })
        const target = new EventTarget()
        yield* paletteShortcuts(target).pipe(Effect.provide(store), Scope.provide(scope))

        const ignored = keydown({ key: "p" })
        target.dispatchEvent(ignored)
        const openAfterPlain = Option.getOrThrow(yield* palette.get(PALETTE)).open

        const altP = keydown({ key: "p", metaKey: true, altKey: true })
        target.dispatchEvent(altP)

        const cmdP = keydown({ key: "p", metaKey: true })
        target.dispatchEvent(cmdP)
        const openAfterCmdP = Option.getOrThrow(yield* palette.get(PALETTE)).open

        const ctrlShiftP = keydown({ key: "P", ctrlKey: true, shiftKey: true })
        target.dispatchEvent(ctrlShiftP)
        const openAfterCtrlP = Option.getOrThrow(yield* palette.get(PALETTE)).open

        yield* Scope.close(scope, Exit.void)
        const afterClose = keydown({ key: "p", metaKey: true })
        target.dispatchEvent(afterClose)
        return {
          ignoredDefault: !ignored.defaultPrevented,
          altDefault: !altP.defaultPrevented,
          cmdDefault: !cmdP.defaultPrevented,
          ctrlDefault: !ctrlShiftP.defaultPrevented,
          afterCloseDefault: !afterClose.defaultPrevented,
          openAfterPlain,
          openAfterCmdP,
          openAfterCtrlP,
        }
      }),
    )
    expect(result).toEqual({
      ignoredDefault: true,
      altDefault: true,
      cmdDefault: false,
      ctrlDefault: false,
      afterCloseDefault: true,
      openAfterPlain: false,
      openAfterCmdP: true,
      openAfterCtrlP: false,
    })
  })
})
