import { Effect, Exit, Metric, Scope } from "effect"
import { describe, expect, test } from "vitest"
import { buttonFor, buttonShortcuts, shortcutPresses } from "./keys.vibe"

// One-key shortcuts over the browser's own event model (Node's `EventTarget`): the page as a target that holds its
// buttons, each as the attributes and state the listener reads. The real page, keys and buttons are end-to-end tested
// (e2e/todos.spec.ts, Make TODO's `t`).

/** A button as the listener reads it: what it declares, whether it is disabled, shown, and how often it was clicked. */
const button = (
  keys: string,
  options: { readonly disabled?: boolean; readonly hidden?: boolean; readonly tagName?: string } = {},
) => {
  const state = { clicks: 0, focuses: 0 }
  return {
    state,
    element: {
      tagName: options.tagName ?? "BUTTON",
      focus: () => void (state.focuses += 1),
      getAttribute: (name: string) => (name === "aria-keyshortcuts" ? keys : null),
      matches: () => options.disabled === true,
      getClientRects: () => (options.hidden === true ? [] : [{}]),
      click: () => void (state.clicks += 1),
    } as unknown as HTMLElement,
  }
}

/** A page holding `buttons`; `owned` says focus is in a field, a dialog or a menu. */
const page = (buttons: ReadonlyArray<ReturnType<typeof button>>, owned = false) => {
  const root = { querySelectorAll: () => buttons.map(({ element }) => element) }
  return Object.assign(new EventTarget(), { closest: () => (owned ? {} : null), ownerDocument: root })
}

const keydown = (init: { key?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) =>
  Object.assign(new Event("keydown", { cancelable: true }), { metaKey: false, ctrlKey: false, altKey: false, ...init })

/** Binds the shortcuts on `target` and presses each key; answers whether each kept its default, and the count of `t`. */
const press = (target: EventTarget, events: ReadonlyArray<Event>, handled = false) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* buttonShortcuts(target).pipe(Scope.provide(scope))
      const kept = events.map((event) => {
        if (handled) event.preventDefault()
        target.dispatchEvent(event)
        return !event.defaultPrevented
      })
      yield* Scope.close(scope, Exit.void)
      // Once the scope closed, a key does nothing.
      const after = keydown({ key: "t" })
      target.dispatchEvent(after)
      const count = (yield* Metric.value(Metric.withAttributes(shortcutPresses, { key: "t" }))).count
      return { kept, after: !after.defaultPrevented, count }
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  )

describe("buttonFor", () => {
  test("the first shown, enabled element that declares the key among its shortcuts", () => {
    const hidden = button("t", { hidden: true })
    const disabled = button("t", { disabled: true })
    const shown = button("x t")
    const root = { querySelectorAll: () => [hidden.element, disabled.element, shown.element] } as unknown as ParentNode
    expect(buttonFor(root, "t")).toBe(shown.element)
    expect(buttonFor(root, "x")).toBe(shown.element)
    expect(buttonFor(root, "T")).toBeUndefined()
    expect(buttonFor(root, "q")).toBeUndefined()
  })
})

describe("buttonShortcuts", () => {
  test("a key presses the button that declares it, stops the browser's default, and counts", async () => {
    const make = button("t")
    const result = await press(page([make]), [keydown({ key: "t" })])
    expect(result).toEqual({ kept: [false], after: true, count: 1 })
    expect(make.state.clicks).toBe(1)
  })

  test("a key focuses the field that declares it, as the strip's note on i, instead of clicking it", async () => {
    for (const tagName of ["TEXTAREA", "INPUT", "SELECT"]) {
      const note = button("t", { tagName })
      expect(await press(page([note]), [keydown({ key: "t" })])).toMatchObject({ kept: [false] })
      expect(note.state, tagName).toEqual({ clicks: 0, focuses: 1 })
    }
  })

  test("with ⌘, Ctrl or Alt held, a key that isn't one character, or none, nothing is pressed", async () => {
    const make = button("t")
    const result = await press(page([make]), [
      keydown({ key: "t", metaKey: true }),
      keydown({ key: "t", ctrlKey: true }),
      keydown({ key: "t", altKey: true }),
      keydown({ key: "Enter" }),
      keydown({}),
    ])
    expect(result.kept).toEqual([true, true, true, true, true])
    expect([make.state.clicks, result.count]).toEqual([0, 0])
  })

  test("typing in a field, or working in a dialog or a menu, keeps the key", async () => {
    const make = button("t")
    const result = await press(page([make], true), [keydown({ key: "t" })])
    expect([result.kept, make.state.clicks]).toEqual([[true], 0])
  })

  test("a key an element already handled, or one no button declares, is left alone", async () => {
    const make = button("t")
    expect((await press(page([make]), [keydown({ key: "t" })], true)).count).toBe(0)
    expect((await press(page([make]), [keydown({ key: "q" })])).kept).toEqual([true])
    expect(make.state.clicks).toBe(0)
  })

  test("a target that isn't on a page presses nothing", async () => {
    const result = await press(new EventTarget(), [keydown({ key: "t" })])
    expect(result.kept).toEqual([true])
  })
})
