import { KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import type { ControlSchema } from "@smthrs/control"
import { Fuzz } from "@smthrs/fuzz"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import type * as Form from "@smthrs/ui/flow-form"
import { describe, expect, it } from "bun:test"
import { Arbitrary, Effect, Schema } from "effect"
import stringWidth from "string-width"
import * as Activity from "../src/activity.ts"
import * as AppView from "../src/app-view.tsx"
import * as Approvals from "../src/approvals.ts"
import * as Complete from "../src/complete.ts"
import * as Editor from "../src/editor.ts"
import * as Extension from "../src/extension.ts"
import * as Flows from "../src/flows.ts"
import * as Graph from "../src/graph.ts"
import type * as Inbox from "../src/inbox.ts"
import * as Dispatch from "../src/key-dispatch.ts"
import * as Keys from "../src/keys.ts"
import * as Palette from "../src/palette.ts"
import * as Panels from "../src/panels.ts"
import * as RunCard from "../src/run-card.ts"
import * as Search from "../src/search.ts"
import * as SubagentView from "../src/subagent-view.tsx"
import * as Subagents from "../src/subagents.ts"
import * as Surfaces from "../src/surfaces.ts"
import * as Toasts from "../src/toasts.ts"
import * as Transcript from "../src/transcript.ts"
import * as View from "../src/view.tsx"
import * as Wrapped from "../src/wrapped.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

/** A property fails by throwing: the message names the broken invariant beside the shrunk counterexample. */
const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const runFuzz = async <A>(arb: Arbitrary.Arbitrary<A>, prop: (value: A) => void, offset: number) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (value) =>
      Effect.sync(() => {
        prop(value)
        return true
      }), { seed: seed + offset, executions: pureExecutions })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const int = (minimum: number, maximum: number) => Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum, maximum })))
const list = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).pipe(Schema.check(Schema.isMaxLength(max)))

/** Text a terminal measures, clips or parses badly: wide, joined, zero-width, escape-laden, unbroken. */
const hostile = [
  "",
  " ",
  "界面测试界面测试界面测试",
  "ｆｕｌｌｗｉｄｔｈ",
  "👨‍👩‍👧‍👦👨‍👩‍👧‍👦",
  "🇺🇸🇯🇵🇺🇸",
  "é́́ä",
  "​​​zero",
  "\x1b[31mred\x1b[0m",
  "\x1b]8;;https://example.test\x07link\x1b]8;;\x07",
  "nul\x00byte\x00",
  "bell\x07\x08\x7f",
  "مرحبا بالعالم",
  "\t\ttabbed",
  "line one\nline two\r\nline three",
  "x".repeat(400),
  "界".repeat(160),
  "\ud83d",
  "!rm -rf /",
  "/model auto"
] as const
const Text = Schema.Union([Schema.String.pipe(Schema.check(Schema.isMaxLength(48))), Schema.Literals(hostile)])
const Mixed = Schema.Struct({ head: Text, tail: Text })
const mixed = (value: typeof Mixed.Type): string => `${value.head}${value.tail}`

/** Terminal sizes from 1x1 through 300x100, with the degenerate ones over-sampled. */
const Columns = Schema.Union([int(1, 300), Schema.Literals([1, 2, 3, 5, 20, 80, 300])])
const Lines = Schema.Union([int(1, 100), Schema.Literals([1, 2, 5, 24, 100])])

const keyNames = [
  "h",
  "j",
  "k",
  "l",
  "up",
  "down",
  "left",
  "right",
  "tab",
  "escape",
  "return",
  "kpenter",
  "space",
  "pageup",
  "pagedown",
  "home",
  "end",
  "backspace",
  "a",
  "d",
  "u",
  "i",
  "x",
  "y",
  "n",
  "g",
  "r",
  "c",
  "p",
  "v",
  "t",
  "1",
  "2",
  "9",
  "?",
  "[",
  "]",
  "界",
  "😀"
] as const
const KeySpec = Schema.Struct({ name: Schema.Literals(keyNames), mod: int(0, 11) })
type KeySpec = typeof KeySpec.Type

const sequences: Readonly<Record<string, string>> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
  escape: "\x1b",
  return: "\r",
  kpenter: "\r",
  space: " ",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  backspace: "\x7f"
}
const modifiers = (spec: KeySpec) => ({
  ctrl: spec.mod === 7 || spec.mod === 10,
  meta: spec.mod === 8 || spec.mod === 11,
  shift: spec.mod >= 9
})
/** A key as the terminal parser delivers it: its name, its modifiers, and the bytes it arrived as. */
const press = (spec: KeySpec): KeyEvent => {
  const { ctrl, meta, shift } = modifiers(spec)
  const base = sequences[spec.name] ?? spec.name
  const sequence = ctrl && base.length === 1
    ? String.fromCharCode(base.charCodeAt(0) & 0x1f)
    : meta
    ? `\x1b${base}`
    : shift && base.length === 1
    ? base.toUpperCase()
    : base
  return new KeyEvent({
    name: spec.name,
    ctrl,
    meta,
    shift,
    option: false,
    sequence,
    number: false,
    raw: sequence,
    eventType: "press",
    source: "raw"
  })
}
const plain = (name: KeySpec["name"]): KeyEvent => press({ name, mod: 0 })
/** The text a key types, by the terminal's rule: one unmodified printable code point. */
const typedBy = (spec: KeySpec): string | undefined => {
  const { ctrl, meta, shift } = modifiers(spec)
  if (ctrl || meta) return undefined
  if (spec.name === "space") return " "
  if (spec.name in sequences) return undefined
  return shift ? spec.name.toUpperCase() : spec.name
}
const inBounds = (index: number, size: number): boolean => Number.isInteger(index) && index >= 0 && index < size

describe("apps/tui navigation and keymap state machines", () => {
  it("dialog selection follows the reference model across typing, paging, stale selections and resized row lists", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      kind: Schema.Literals(["model", "flows", "palette", "stop", "undo"]),
      rows: int(0, 40),
      ops: list(Schema.Struct({ op: int(0, 9), key: KeySpec, size: int(0, 40), stale: int(0, 60) }), 40)
    }))
    await runFuzz(arb, ({ kind, rows: initialRows, ops }) => {
      let rows = initialRows
      let open: { kind: string; selected: number; query: string } | undefined = { kind, selected: 0, query: "" }
      let composerFocused = true
      for (const { op, key: spec, size, stale } of ops) {
        if (op === 7) {
          // A resize or a narrower filter changes the row count under a selection that stays put.
          rows = size
          continue
        }
        if (op === 8) {
          composerFocused = !composerFocused
          continue
        }
        if (op === 9) {
          open = { kind, selected: stale, query: "" }
          continue
        }
        if (open === undefined) continue
        const before = open
        const calls: Array<string> = []
        const key = press(spec)
        Dispatch.dialogKey(key, before, { rows, composerFocused }, {
          close: () => {
            calls.push("close")
            open = undefined
          },
          select: (update) => {
            calls.push("select")
            open = { ...before, selected: update(before.selected) }
          },
          type: (text) => {
            calls.push(`type:${text}`)
            open = { ...before, query: before.query + text }
          },
          pick: (index) => calls.push(`pick:${index}`)
        })
        const after = open as { kind: string; selected: number; query: string } | undefined
        const typed = typedBy(spec)
        const { ctrl } = modifiers(spec)
        const move = spec.name === "up" || (ctrl && spec.name === "p")
          ? "up"
          : spec.name === "down" || (ctrl && spec.name === "n")
          ? "down"
          : spec.name === "pageup" || spec.name === "pagedown"
          ? spec.name
          : undefined
        if (spec.name === "escape") {
          check(calls.join() === "close" && after === undefined, `escape must only close the dialog: ${calls.join()}`)
          continue
        }
        check(after !== undefined, `${spec.name} closed the dialog`)
        if (after === undefined) continue
        if (composerFocused && before.kind !== "stop" && typed !== undefined) {
          check(calls.join() === `type:${typed}`, `typing ${typed} before the input mounts: ${calls.join()}`)
          check(key.defaultPrevented, "a typed-ahead key must not also reach the composer")
          check(after.selected === before.selected, "typing moved the selection")
          continue
        }
        if (move !== undefined) {
          check(key.defaultPrevented, `${move} reached the dialog's input`)
          if (rows === 0) {
            check(calls.length === 0 && after.selected === before.selected, "an empty list moved its selection")
            continue
          }
          check(calls.join() === "select", `${move} must select once: ${calls.join()}`)
          check(inBounds(after.selected, rows), `${move} left selection ${after.selected} outside ${rows} rows`)
          if (inBounds(before.selected, rows)) {
            const expected = move === "up"
              ? (before.selected + rows - 1) % rows
              : move === "down"
              ? (before.selected + 1) % rows
              : move === "pageup"
              ? Math.max(0, before.selected - 10)
              : Math.min(rows - 1, before.selected + 10)
            check(after.selected === expected, `${move} from ${before.selected}/${rows}: ${after.selected}`)
          }
          continue
        }
        if (spec.name === "return" || spec.name === "kpenter") {
          check(calls.join() === `pick:${before.selected}`, `enter must pick the selected row: ${calls.join()}`)
          check(key.defaultPrevented, "enter also reached the dialog's input")
          continue
        }
        check(calls.length === 0, `${spec.name} acted on the dialog: ${calls.join()}`)
      }
    }, 0)
  })

  it("Escape unwinds every overlay one layer at a time, top first, and settles on the composer without quitting", async () => {
    const overlays = [
      "checklist",
      "picker",
      "review",
      "selection",
      "form",
      "overview",
      "panel",
      "completion",
      "card"
    ] as const
    type Overlay = (typeof overlays)[number] | "whichKey"
    const fields: ReadonlyArray<Form.FormField> = [
      { name: "title", label: "Title", kind: "text", required: true },
      { name: "draft", label: "Draft", kind: "boolean", required: false },
      {
        name: "level",
        label: "Level",
        kind: "select",
        required: true,
        options: [
          { value: "low", label: "Low" },
          { value: "off", label: "Off", disabled: true },
          { value: "high", label: "High" }
        ]
      }
    ]
    const panel: Panels.Panel = {
      id: "p",
      title: "Panel",
      summary: "A panel.",
      rows: [{ id: "a", label: "A", details: [] }, { id: "b", label: "B", details: [] }]
    }
    const completion: Complete.Completion = {
      kind: "command",
      query: "",
      start: 0,
      end: 0,
      items: [{ label: "/model", insert: "/model ", submit: false }, { label: "/exit", insert: "/exit", submit: true }]
    }
    const pending = [{ requestId: "request-1", always: true } as Approvals.Pending]
    const activity = Activity.finish(Activity.empty, "completed", 1, "")
    const arb = Arbitrary.schema(Schema.Struct({
      ask: Schema.Boolean,
      ops: list(
        Schema.Struct({
          op: int(0, 11),
          key: KeySpec,
          layer: Schema.Literals([...overlays, "whichKey"]),
          rows: int(0, 12),
          text: Schema.Literals(["", "", "!ls", "hello", "?", "!"])
        }),
        36
      )
    }))
    await runFuzz(arb, ({ ask, ops }) => {
      const open = new Set<Overlay>()
      const app = {
        approvals: false,
        text: "",
        steering: false,
        turn: false,
        shell: false,
        rows: 3,
        selected: 0,
        menu: 0,
        pane: "tree" as "tree" | "cards",
        navigation: Panels.initial(),
        form: {
          id: "run-1",
          flow: "deploy",
          fields,
          draft: { title: "", draft: false, level: "low" },
          focus: 0,
          ...(ask ? { ask: { question: "Which?", options: ["one", "two"], choice: 0, armedAt: 0 } } : {})
        } as Dispatch.FlowForm
      }
      let log: Array<string> = []
      const closes = (layer: Overlay) => () => {
        open.delete(layer)
        log.push(`${layer}.close`)
      }
      const note = (label: string) => () => void log.push(label)
      /** The documented order `handleKey` tries its layers in, written out independently of `Dispatch.context`. */
      const expectedContext = (approvals: boolean): Keys.KeyContext => {
        for (const layer of ["checklist", "picker", "review", "selection", "form"] as const) {
          if (open.has(layer)) return layer
        }
        if (approvals && app.text === "") return "approval"
        for (const layer of ["overview", "panel", "completion", "card"] as const) if (open.has(layer)) return layer
        if (app.shell || app.text.startsWith("!")) return "shell"
        return app.turn ? "working" : "composer"
      }
      const contextOf = (approvals: boolean): Keys.KeyContext => {
        const context = Dispatch.context({
          checklist: open.has("checklist"),
          picker: open.has("picker"),
          review: open.has("review"),
          inspecting: open.has("selection"),
          form: open.has("form"),
          approvals,
          empty: app.text === "",
          panel: open.has("panel"),
          overview: open.has("overview"),
          completion: open.has("completion"),
          card: open.has("card"),
          shell: app.shell || app.text.startsWith("!"),
          turn: app.turn
        })
        check(context === expectedContext(approvals), `context ${context}, expected ${expectedContext(approvals)}`)
        return context
      }
      const dispatch = (key: KeyEvent, approvals = app.approvals): void => {
        const context = contextOf(approvals)
        if (open.has("whichKey")) {
          const consumed = Dispatch.whichKeyKey(key, Keys.bindingFor(key, context), {
            close: closes("whichKey"),
            type: (text) => {
              app.text += text
              log.push("whichKey.type")
            },
            scroll: note("whichKey.scroll")
          })
          if (consumed) return
        }
        switch (context) {
          case "checklist":
            return Dispatch.checklistKey(key, { rows: app.rows }, {
              close: closes("checklist"),
              select: (update) => {
                app.selected = update(app.selected)
                log.push("select")
              },
              toggle: note("toggle"),
              undo: note("undo")
            })
          case "picker":
            return void Dispatch.dialogKey(key, { kind: "model", selected: app.selected }, {
              rows: app.rows,
              composerFocused: false
            }, {
              close: closes("picker"),
              select: (update) => {
                app.selected = update(app.selected)
                log.push("select")
              },
              type: note("type"),
              pick: note("pick")
            })
          case "review":
            return Dispatch.reviewKey(key, { undo: note("undo"), close: closes("review"), scroll: note("scroll") })
          case "selection":
            return void Dispatch.scrubberKey(key, activity, 1, {
              follow: closes("selection"),
              inspect: note("inspect")
            })
          case "form":
            return Dispatch.formKey(key, app.form, {
              change: (next) => {
                if (next === undefined) return closes("form")()
                app.form = next
                log.push("form.change")
              },
              schema: () => undefined,
              input: () => undefined,
              fill: note("fill"),
              chat: note("chat")
            })
          case "approval": {
            const { ctrl, meta, shift } = key
            const choice = Approvals.key(key.name, { draft: app.text, shift, ctrl, meta, armed: true, pending })
            if (choice === undefined) return dispatch(key, false)
            app.approvals = false
            log.push(`approval.${choice}`)
            return
          }
          case "overview":
            return Dispatch.overviewKey(key, { pane: app.pane, worker: undefined }, {
              close: closes("overview"),
              stopMonitor: note("stopMonitor"),
              release: note("release"),
              pane: () => {
                app.pane = "cards"
                log.push("pane")
              },
              tree: note("tree"),
              peek: note("peek"),
              answer: note("answer"),
              graph: note("graph"),
              card: note("card"),
              open: note("open"),
              scroll: note("scroll"),
              workerAction: note("workerAction")
            })
          case "panel":
            return void Dispatch.panelKey(key, panel, {
              surface: "ui:p",
              navigation: app.navigation,
              worker: undefined,
              flow: { retry: false, continue: false, stop: false }
            }, {
              close: closes("panel"),
              release: () => {
                open.delete("panel")
                log.push("panel.release")
              },
              retryRun: note("retryRun"),
              continueRun: note("continueRun"),
              cancelRun: note("cancelRun"),
              fillRun: note("fillRun"),
              undo: note("undo"),
              scroll: note("scroll"),
              navigate: (update) => {
                app.navigation = update(app.navigation)
                log.push("navigate")
              },
              send: note("send"),
              perform: note("perform")
            })
          case "completion":
            return void Dispatch.menuKey(key, completion, {
              select: (update) => {
                app.menu = update(app.menu)
                log.push("menu.select")
              },
              dismiss: closes("completion"),
              accept: () => {
                open.delete("completion")
                log.push("accept")
              }
            })
          case "card":
            return void Dispatch.cardKey(key, {
              move: note("card.move"),
              leave: closes("card"),
              open: note("open"),
              worker: undefined,
              workerAction: note("workerAction")
            })
          default:
            return void Dispatch.composerKey(key, {
              text: app.text,
              steering: app.steering,
              turn: app.turn
                ? {
                  stop: () => {
                    app.turn = false
                    log.push("turn.stop")
                  }
                }
                : undefined,
              shell: app.shell
                ? {
                  cancel: () => {
                    app.shell = false
                    log.push("shell.cancel")
                  }
                }
                : undefined,
              history: new Editor.History([]),
              scroll: null
            }, {
              stopSteering: () => {
                app.steering = false
                log.push("steer.stop")
              },
              setText: (text) => {
                app.text = text
                log.push("setText")
              },
              quit: note("quit"),
              submit: note("submit"),
              restoreQueued: note("restoreQueued"),
              pickModel: note("pickModel"),
              cycleModel: note("cycleModel"),
              toggleExpanded: note("toggleExpanded"),
              externalEditor: note("externalEditor")
            })
        }
      }
      /** What one unmodified Escape must do, and nothing else. */
      const expectedEscape = (): string | undefined => {
        if (open.has("whichKey")) return "whichKey.close"
        const context = expectedContext(false)
        const top = overlays.find((layer) => layer === context)
        if (top !== undefined) return `${top}.close`
        if (app.steering) return "steer.stop"
        if (app.turn) return "turn.stop"
        if (app.shell) return "shell.cancel"
        return app.text.startsWith("!") ? "setText" : undefined
      }
      const escape = (): boolean => {
        const expected = expectedEscape()
        const layers = open.size
        log = []
        dispatch(plain("escape"))
        check(
          log.join() === (expected ?? ""),
          `escape did ${log.join() || "nothing"}, expected ${expected ?? "nothing"}`
        )
        if (expected?.endsWith(".close") === true) check(open.size === layers - 1, "escape closed more than one layer")
        if (expected === "setText") check(app.text === "", "escape kept the shell draft")
        return expected !== undefined
      }
      for (const { op, key: spec, layer, rows, text } of ops) {
        if (op === 0) open.add(layer)
        else if (op === 1) app.rows = rows
        else if (op === 2) app.text = text
        else if (op === 3) app.approvals = !app.approvals
        else if (op === 4) app.turn = !app.turn
        else if (op === 5) app.shell = !app.shell
        else if (op === 6) app.steering = !app.steering
        else if (spec.name === "escape" && spec.mod < 7) escape()
        else {
          log = []
          // The `?` popup closes on a listed key and lets it act, so Ctrl+D still reaches an empty composer.
          const base = ["composer", "working", "shell"].includes(expectedContext(false))
          dispatch(press(spec))
          const { ctrl } = modifiers(spec)
          check(
            !log.includes("quit") || (ctrl && spec.name === "d" && base && app.text === ""),
            `${spec.name} quit the app`
          )
          if (log.includes("select") && app.rows > 0) {
            check(inBounds(app.selected, app.rows), `selection ${app.selected} outside ${app.rows} rows`)
          }
          check(inBounds(app.menu, completion.items.length), `menu index ${app.menu} out of bounds`)
          check(inBounds(app.form.focus, fields.length), `form focus ${app.form.focus} out of bounds`)
          check(
            ["low", "high"].includes(String(app.form.draft["level"])) && typeof app.form.draft["draft"] === "boolean",
            `form draft left its domain: ${JSON.stringify(app.form.draft)}`
          )
          const navigation = app.navigation
          check(Number.isInteger(navigation.selected) && navigation.selected >= 0, "panel selection left its domain")
        }
        // Whatever the screen shows, its footer hints name keys of that context and fit any width whole.
        const context = contextOf(app.approvals)
        const hints = Keys.hintsFor(context)
        check(
          hints.every((hint) => hint.context === context || hint.context === "global"),
          `foreign hint in ${context}`
        )
      }
      const owed = open.size + Number(app.steering) + Number(app.turn) + Number(app.shell) +
        Number(app.text.startsWith("!"))
      let unwound = 0
      while (escape()) {
        unwound++
        check(unwound <= owed, `escape still acting after ${unwound} presses, ${owed} owed`)
      }
      check(unwound === owed, `escape unwound ${unwound} of ${owed}`)
      check(open.size === 0 && !app.turn && !app.shell && !app.steering, "escape left something open")
      const rest = contextOf(app.approvals)
      check(rest === "composer" || rest === "approval", `escape settled on ${rest}`)
    }, 1)
  })

  it("an ask's answer form keeps its cursor in bounds and never answers from typed-ahead keys", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      options: list(Schema.Literals(["yes", "no", "retry", "skip it", "界面", "9"]), 6),
      armed: Schema.Boolean,
      lead: Schema.Boolean,
      keys: list(KeySpec, 30)
    }))
    await runFuzz(arb, ({ options, armed, lead, keys }) => {
      const far = Number.MAX_SAFE_INTEGER
      let form: Dispatch.FlowForm | undefined = {
        id: "ask-1",
        flow: "ask",
        fields: [],
        draft: {},
        focus: 0,
        ask: { question: "Proceed?", options, choice: 0, armedAt: armed ? 0 : far, ...(lead ? { lead: "a" } : {}) }
      }
      for (const spec of keys) {
        if (form === undefined) break
        const before: Dispatch.FlowForm = form
        const ask = before.ask!
        const lines = Dispatch.choices(ask).length
        const fills: Array<Record<string, unknown>> = []
        const chats: Array<string> = []
        let closed = false
        Dispatch.formKey(press(spec), before, {
          change: (next) => {
            form = next
            if (next === undefined) closed = true
          },
          schema: () => undefined,
          input: () => undefined,
          fill: (id, payload) => {
            check(id === before.id, "answered another form")
            fills.push(payload)
          },
          chat: (text) => chats.push(text)
        })
        const mayAnswer = ask.moved === true || ask.armedAt === 0
        check(fills.length + chats.length <= 1, "one key answered twice")
        check(fills.length + chats.length === 0 || closed, "an answer left the form open")
        if (spec.name === "escape") check(closed && fills.length + chats.length === 0, "escape answered the ask")
        for (const payload of fills) {
          const answer = payload["answer"]
          check(mayAnswer, `a key typed ahead answered the ask: ${String(answer)}`)
          check(
            typeof answer === "string" && answer !== "" &&
              (ask.options.includes(answer) || answer === String(before.draft["answer"] ?? "").trim()),
            `answer ${String(answer)} is neither an option nor the typed text`
          )
        }
        for (const text of chats) {
          check(ask.lead !== undefined && ask.moved !== true, "a selected answer went back to the chat")
          check(text.startsWith(ask.lead ?? ""), `the chat lost its lead key: ${text}`)
        }
        const after = form as Dispatch.FlowForm | undefined
        if (after === undefined) continue
        const next = after.ask
        check(next !== undefined && next.options === ask.options && after.id === before.id, "the ask changed identity")
        if (next === undefined) continue
        check(
          lines === 0 ? next.choice === 0 : inBounds(next.choice, lines),
          `choice ${next.choice} outside ${lines} lines`
        )
        if (next.choice !== ask.choice && typedBy(spec) === undefined) {
          check(next.moved === true, "moving the cursor did not arm the form")
        }
        const typed = String(after.draft["answer"] ?? "")
        check(typed.startsWith(String(before.draft["answer"] ?? "")), "typing rewrote the answer")
        check(Dispatch.typed(next) === (next.choice >= next.options.length), "typed() disagrees with the cursor")
      }
    }, 2)
  })

  it("panel navigation matches the reference model as rows shrink and grow, and card and tab cycling stays inside its ring", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      rows: list(Schema.Struct({ label: Mixed, action: int(0, 3) }), 8),
      ops: list(Schema.Struct({ op: int(0, 5), key: KeySpec, size: int(0, 8) }), 40),
      ring: int(1, 8),
      focus: int(0, 9),
      steps: list(Schema.Literals(["up", "down", "left", "right", "next", "previous"]), 12)
    }))
    await runFuzz(arb, ({ rows: specs, ops, ring, focus, steps }) => {
      const master: ReadonlyArray<Panels.Row> = specs.map((spec, index) => ({
        id: `row-${index}`,
        label: mixed(spec.label).replace(/^$/, "row"),
        details: [],
        ...(spec.action === 1
          ? { action: { label: "Send", prompt: "   " } }
          : spec.action === 2
          ? { action: { label: "Send", prompt: `  ${mixed(spec.label)} !ls /model  ` } }
          : spec.action === 3
          ? { action: { label: "Open", action: { kind: "open" as const, surface: "chat" } } }
          : {})
      }))
      let shown = master
      let navigation = Panels.initial()
      let model = { selected: 0, expanded: new Set<string>(), diff: false, split: false }
      for (const { op, key: spec, size } of ops) {
        if (op === 0) {
          shown = master.slice(0, size)
          continue
        }
        const panel: Panels.Panel = { id: "p", title: "Panel", summary: "A panel.", rows: shown }
        const calls: Array<string> = []
        Dispatch.panelKey(press(spec), panel, {
          surface: "ui:p",
          navigation,
          worker: undefined,
          flow: { retry: true, continue: true, stop: true }
        }, {
          close: () => calls.push("close"),
          release: () => calls.push("release"),
          retryRun: () => calls.push("retryRun"),
          continueRun: () => calls.push("continueRun"),
          cancelRun: () => calls.push("cancelRun"),
          fillRun: () => calls.push("fillRun"),
          undo: () => calls.push("undo"),
          scroll: (direction) => calls.push(`scroll:${direction}`),
          navigate: (update) => {
            calls.push("navigate")
            navigation = update(navigation)
          },
          send: (prompt) => calls.push(`send:${prompt}`),
          perform: (action) => calls.push(`perform:${action.kind}`)
        })
        const count = shown.length
        const at = Math.max(0, Math.min(model.selected, count - 1))
        const row = shown[at]
        const name = spec.name
        let expected: string
        if (name === "escape") expected = "close"
        else if (name === "i") expected = "release"
        else if (name === "pageup" || name === "pagedown") expected = `scroll:${name === "pageup" ? -1 : 1}`
        else if (name === "a") {
          const action = row?.action
          expected = action === undefined
            ? ""
            : "prompt" in action
            ? action.prompt.trim() === "" ? "" : `release,send:${action.prompt.trim()}`
            : `perform:${action.action.kind}`
        } else {
          expected = "navigate"
          if (name === "j" || name === "down") model = { ...model, selected: Math.max(0, Math.min(count - 1, at + 1)) }
          else if (name === "k" || name === "up") model = { ...model, selected: Math.max(0, at - 1) }
          else if (name === "d") model = { ...model, diff: !model.diff }
          else if (name === "v") model = { ...model, split: !model.split }
          else if (row === undefined) model = { ...model, selected: 0 }
          else {
            const expanded = new Set(model.expanded)
            if (name === "h" || name === "left") expanded.delete(row.id)
            else if (name === "l" || name === "right") expanded.add(row.id)
            else if (name === "return" || name === "kpenter" || name === "space") {
              if (!expanded.delete(row.id)) expanded.add(row.id)
            }
            model = { ...model, selected: at, expanded }
          }
        }
        check(
          calls.join() === expected,
          `${name} on ${count} rows did ${calls.join() || "nothing"}, expected ${expected}`
        )
        check(
          navigation.selected === model.selected && navigation.diff === model.diff && navigation.split === model.split,
          `${name}: selected ${navigation.selected}, model ${model.selected}`
        )
        check(
          navigation.expanded.size === model.expanded.size &&
            [...model.expanded].every((id) => navigation.expanded.has(id)),
          `${name}: expanded rows diverged from the model`
        )
        check(Number.isInteger(navigation.selected) && navigation.selected >= 0, "selection left its domain")
        check(count === 0 || inBounds(Math.min(navigation.selected, count - 1), count), "no row under the cursor")
        check(
          [...navigation.expanded].every((id) => master.some((each) => each.id === id)),
          "expanded a row never shown"
        )
      }

      const order = Array.from({ length: ring }, (_, index) => `card-${index}`)
      const strip = order.map((id) => ({ id, label: id }))
      let card = order[focus] ?? "card-gone"
      let tab = card
      for (const step of steps) {
        const from = card
        card = Subagents.move(order, from, step)
        check(order.includes(card), `card focus left the ring: ${card}`)
        const back = step === "up" || step === "left" || step === "previous"
        if (order.includes(from)) {
          const expected = order[(order.indexOf(from) + (back ? ring - 1 : 1)) % ring]
          check(card === expected, `${step} from ${from}: ${card}`)
          check(
            Subagents.move(order, card, back ? "next" : "previous") === from,
            `${step} is not undone by its opposite`
          )
        }
        tab = Surfaces.step(strip, tab, back)
        check(order.includes(tab), `tab stepping left the strip: ${tab}`)
      }
      let lap = order[0]!
      const seen = new Set<string>()
      for (let turn = 0; turn < ring; turn++) {
        seen.add(lap)
        lap = Surfaces.step(strip, lap, false)
      }
      check(seen.size === ring && lap === order[0], "ctrl+] does not visit every tab once per lap")
    }, 3)
  })

  it("scroll keys only ever ask for one line or half a viewport, so the offset stays clamped through resizes down to 1x1", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      content: int(0, 5000),
      ops: list(
        Schema.Struct({ op: int(0, 5), key: KeySpec, columns: Columns, lines: Lines, content: int(0, 5000) }),
        40
      ),
      history: list(Text, 4)
    }))
    await runFuzz(arb, ({ content: initial, ops, history: entries }) => {
      const box = { top: 0, content: initial, viewport: 24 }
      const furthest = () => Math.max(0, box.content - box.viewport)
      const clamp = () => {
        box.top = Math.max(0, Math.min(furthest(), box.top))
      }
      const asked: Array<{ readonly delta: number; readonly unit: string | undefined }> = []
      const scroll = {
        scrollBy: (delta: number, unit?: string) => {
          asked.push({ delta, unit })
          box.top += unit === "viewport" ? delta * box.viewport : delta
          clamp()
        }
      } as unknown as ScrollBoxRenderable
      const history = new Editor.History(entries.filter((entry) => entry.trim() !== ""))
      let text = ""
      for (const { op, key: spec, lines, content } of ops) {
        if (op === 0) {
          box.viewport = lines
          box.content = content
          clamp()
        } else {
          asked.length = 0
          const key = press(spec)
          const { meta, shift } = modifiers(spec)
          const browsing = history.browsing
          Dispatch.composerKey(key, { text, steering: false, turn: undefined, shell: undefined, history, scroll }, {
            stopSteering: () => {},
            setText: (next) => {
              text = next
            },
            quit: () => {},
            submit: () => {},
            restoreQueued: () => {},
            pickModel: () => {},
            cycleModel: () => {},
            toggleExpanded: () => {},
            externalEditor: () => {}
          })
          // Alt+Up restores the queue before any scroll key is read.
          const line = shift && (spec.name === "down" || (spec.name === "up" && !meta))
          const page = spec.name === "pageup" || spec.name === "pagedown"
          const expected = line
            ? [{ delta: spec.name === "up" ? -1 : 1, unit: undefined }]
            : page
            ? [{ delta: spec.name === "pageup" ? -0.5 : 0.5, unit: "viewport" }]
            : []
          check(
            JSON.stringify(asked) === JSON.stringify(expected),
            `${spec.name} mod ${spec.mod} scrolled ${JSON.stringify(asked)}`
          )
          if (line) check(key.defaultPrevented, "a line scroll also moved the caret")
          if (asked.length > 0) check(history.browsing === browsing, "a scroll key browsed history")

          // The same keys in a full-height diff and in the `?` popup ask for a direction, never a position.
          const review: Array<string> = []
          Dispatch.reviewKey(press(spec), {
            undo: undefined,
            close: () => review.push("close"),
            scroll: (by, paged) => review.push(`${by}:${paged}`)
          })
          const reviewed = spec.name === "escape"
            ? "close"
            : spec.name === "up" || spec.name === "k"
            ? "-1:false"
            : spec.name === "down" || spec.name === "j"
            ? "1:false"
            : spec.name === "pageup"
            ? "-1:true"
            : spec.name === "pagedown"
            ? "1:true"
            : ""
          check(review.join() === reviewed, `review ${spec.name}: ${review.join()}`)
          const popup: Array<string> = []
          const consumed = Dispatch.whichKeyKey(press(spec), undefined, {
            close: () => popup.push("close"),
            type: (typed) => popup.push(`type:${typed}`),
            scroll: (direction) => popup.push(`scroll:${direction}`)
          })
          if ((spec.name === "pageup" || spec.name === "pagedown") && spec.mod < 7) {
            check(consumed && popup.join() === `scroll:${spec.name === "pageup" ? -1 : 1}`, "the popup did not page")
          } else {
            check(popup[0] === "close", `${spec.name} left the popup open`)
            const typed = typedBy(spec)
            if (typed !== undefined && spec.name !== "escape") {
              check(consumed && popup[1] === `type:?${typed}`, `the popup lost ?${typed}`)
            }
          }
        }
        check(Number.isFinite(box.top) && box.top >= 0 && box.top <= furthest(), `offset ${box.top} of ${furthest()}`)
      }
    }, 4)
  })
})

describe("apps/tui viewport clipping and layout", () => {
  it("clipped names, project leads and summaries never exceed their cells, keep whole graphemes, and keep the end that matters", async () => {
    const arb = Arbitrary.schema(Schema.Struct({ text: Mixed, other: Text, columns: Columns, small: int(-2, 12) }))
    await runFuzz(arb, ({ text: parts, other, columns, small }) => {
      const text = mixed(parts)
      const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
      for (const width of [columns, small]) {
        const clipped = SubagentCard.clip(text, width)
        check(stringWidth(clipped) <= Math.max(0, width), `clip(${width}) drew ${stringWidth(clipped)} cells`)
        if (width <= 0) check(clipped === "", "clip drew into no room")
        else if (stringWidth(text) <= width) check(clipped === text, "clip changed text that fits")
        else {
          check(clipped.endsWith("…") && text.startsWith(clipped.slice(0, -1)), "clip is not a prefix and an ellipsis")
          const kept = clipped.slice(0, -1)
          const whole = [...graphemes.segment(text)].some((each) => each.index === kept.length) ||
            kept.length === text.length
          check(whole, "clip cut a grapheme in half")
        }

        const project = AppView.clipProject(text, width)
        check(stringWidth(project) <= Math.max(0, width), `clipProject(${width}) drew ${stringWidth(project)} cells`)
        if (width > 0 && stringWidth(text) <= width) check(project === text, "clipProject changed a lead that fits")
        if (width > 0 && stringWidth(text) > width) {
          check(project.startsWith("…") && text.endsWith(project.slice(1)), "clipProject lost the end of the lead")
        }

        const summary = RunCard.summary(`${text}\n\`\`\`ts\n${other}\n\`\`\`\n${other} ${text}`, width)
        check(summary.length <= 2, "a summary took more than two lines")
        for (const line of summary) {
          check(stringWidth(line) <= Math.max(1, width), `summary line drew ${stringWidth(line)} cells in ${width}`)
          check(!/[\n\r]/.test(line), "a summary line holds a line break")
        }
        const box = AppView.boxWidth(text, 4, Math.max(1, width))
        check(Number.isInteger(box) && box >= 1 && box <= Math.max(1, width), `boxWidth ${box} outside 1..${width}`)
      }
    }, 5)
  })

  it("an overview tree row fits its pane with the name, model and whole clock at any width, indent and script", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      name: Mixed,
      seat: Schema.Union([Text, Schema.Literals(["", "sol", "opus", "GPT-6.1 Sol", "模型模型模型", "ééé"])]),
      clock: Schema.Literals(["", "4s", "5.1s", "12m 04s", "resets 21:43", "waiting 3m 12s", "1h 02m"]),
      columns: Columns,
      level: int(0, 12)
    }))
    await runFuzz(arb, ({ name, seat, clock, columns, level }) => {
      const row: Inbox.Row = { key: "w1", group: "working", level, status: "running", name: mixed(name), seat, clock }
      const widths = SubagentView.overviewWidths(columns)
      check(
        [widths.tree, widths.cards, widths.grid].every(Number.isInteger) && widths.tree >= 30 && widths.tree <= 72 &&
          widths.cards >= 10 && widths.grid === widths.cards - 2,
        `overview widths ${JSON.stringify(widths)}`
      )
      if (columns >= 40) check(widths.tree + widths.cards === columns, "the overview panes do not fill the terminal")
      check(SubagentView.laneWidth(columns) >= 10 && Number.isInteger(SubagentView.laneWidth(columns)), "lane width")
      const lead = 2 + level * 2
      // The last pane is the tightest one that still shows this clock.
      for (const inner of [widths.tree - 2, columns, 30, lead + 3 + stringWidth(clock)]) {
        const seatWidth = SubagentView.seatColumn([row], inner)
        check(Number.isInteger(seatWidth) && seatWidth >= 9, `seat column ${seatWidth}`)
        const drawn = SubagentView.treeRow(row, lead, inner, seatWidth)
        const cells = lead + stringWidth(drawn.title) + drawn.gap + stringWidth(drawn.aside)
        check(Number.isInteger(drawn.gap) && drawn.gap >= 1, `gap ${drawn.gap}`)
        const room = inner - 3 - lead
        if (room >= 1) {
          check(cells <= inner - 1, `row drew ${cells} cells in a pane of ${inner} (lead ${lead})`)
          // A clock reads whole or not at all.
          if (stringWidth(clock) <= room) check(drawn.aside.includes(clock), `clock ${clock} was cut: ${drawn.aside}`)
          else check(drawn.aside.trim() === "" || !/\d/.test(clock) || seat !== "", "part of a clock was drawn")
        }
      }
    }, 6)
  })

  it("footer hints, toast stacks and the run graph hold their bounds at every terminal size and keep `?` reachable", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      context: Schema.Literals(["global", "composer", "working", "shell", "panel", "card", "overview", "picker"]),
      contributed: list(Schema.Struct({ label: Text, key: Schema.Literals(["alt+z", "ctrl+shift+e", "alt+界"]) }), 4),
      columns: Columns,
      lines: Lines,
      compact: Schema.Boolean,
      toasts: list(Schema.Struct({ text: Mixed, settle: Schema.Boolean }), 8),
      nodes: list(Schema.Struct({ name: Mixed, sub: Text, parent: int(0, 5) }), 5),
      selected: int(0, 5)
    }))
    await runFuzz(arb, ({ context, contributed, columns, lines, compact, toasts, nodes, selected }) => {
      const keys = contributed.map((each, index) => ({
        owner: `repo:plugin-${index}`,
        key: {
          id: `contributed-${index}`,
          key: each.key,
          label: each.label.replace(/[\r\n]/g, " ").slice(0, 24) || "Act",
          action: { kind: "open" as const, surface: "chat" }
        }
      }))
      const hints = Keys.hintsFor(context, Keys.bindings(keys))
      for (const width of [columns, 0, 1, 12]) {
        const fitted = Keys.fit(hints, width, stringWidth)
        const cost = fitted.reduce(
          (total, hint, index) => total + (index === 0 ? 0 : 2) + Keys.hintWidth(hint, stringWidth),
          0
        )
        check(fitted.length === 0 || cost <= width, `hints drew ${cost} cells in ${width}`)
        let from = 0
        for (const hint of fitted) {
          const at = hints.indexOf(hint, from)
          check(at >= 0 || hint.id === "keys", `hint ${hint.id} is not one of the offered hints, in order`)
          if (at >= 0) from = at + 1
        }
        const popup = hints.find((hint) => hint.id === "keys")
        if (popup !== undefined && fitted.length < hints.length && Keys.hintWidth(popup, stringWidth) <= width) {
          check(fitted.at(-1) === popup, `hints were dropped at ${width} cells without keeping ?`)
        }
      }

      const rows: ReadonlyArray<Toasts.Row> = toasts.map((toast, index) => ({
        id: `toast-${index}`,
        text: mixed(toast.text),
        tone: "info",
        ...(toast.settle ? { surface: `tab:${index}` } : {})
      }))
      const visible = Toasts.visibleRows(rows, lines, compact)
      const slots = Math.max(1, Math.floor(lines / (compact || lines < 2 ? 1 : 2)))
      check(visible.length === Math.min(rows.length, slots), `${visible.length} toasts in ${lines} lines`)
      check(
        visible.every((row, index) => row === rows[rows.length - visible.length + index]),
        "toasts lost their order"
      )
      const stack = View.toastStackRows(rows, columns, compact)
      check(Number.isInteger(stack) && stack >= rows.length * (compact ? 1 : 2), `toast stack of ${stack} rows`)

      const built: Array<Graph.Node & { children: Array<Graph.Node> }> = []
      const tone = "#7fbfb3"
      const root = {
        key: "node-root",
        glyph: "●",
        tone,
        name: "root",
        sub: "fast · 1s",
        children: [] as Array<Graph.Node>
      }
      built.push(root)
      nodes.forEach((node, index) => {
        const made = { key: `node-${index}`, glyph: "✓", tone, name: mixed(node.name), sub: node.sub, children: [] }
        built[Math.min(node.parent, built.length - 1)]!.children.push(made)
        built.push(made)
      })
      const drawn = Graph.draw(root, built[Math.min(selected, built.length - 1)]!.key, {
        line: "#969083",
        accent: "#45c4b2",
        text: "#ece7db",
        faint: "#a8a193"
      })
      check(drawn.boxes.size === built.length, "a node has no box")
      for (const { x, y } of drawn.boxes.values()) {
        check(
          x % (Graph.size.width + Graph.size.gap) === 0 && y % (Graph.size.height + 1) === 0,
          "a box is off the grid"
        )
      }
      // Where every grapheme has a width, every drawn row is as wide as the canvas.
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
      const measurable = (text: string) =>
        !/[\n\r]/.test(text) && [...segmenter.segment(text)].every(({ segment }) => stringWidth(segment) >= 1) &&
        [...segmenter.segment(text)].reduce((total, { segment }) => total + stringWidth(segment), 0) ===
          stringWidth(text)
      const rowText = (spans: ReadonlyArray<Graph.Span>) => spans.map((span) => span.text).join("")
      if (built.every((node) => measurable(node.name) && measurable(node.sub))) {
        const drawnLines = drawn.rows.map(rowText)
        // Box drawing and the arrow take one cell each, as the terminal draws them.
        const cellsOf = (line: string) => stringWidth(line.replace(/[\u2500-\u25ff]/g, "-"))
        const full = cellsOf(drawnLines[0]!)
        drawnLines.forEach((line, index) => {
          check(cellsOf(line) === full, `graph row ${index} is ${cellsOf(line)} cells wide, the first is ${full}`)
        })
      }
      // A lone box closes on its right border whatever its name holds: nothing spills into the gap beside it.
      for (const node of built.slice(1)) {
        const alone = Graph.draw({ ...node, children: [] }, "", {
          line: "#969083",
          accent: "#45c4b2",
          text: "#ece7db",
          faint: "#a8a193"
        }).rows.map(rowText)
        const closed = `│${" ".repeat(Graph.size.gap)}`
        check(alone.length === Graph.size.height, "a lone box is not four rows")
        check(
          /[\n\r]/.test(`${node.name}${node.sub}`) || (alone[1]!.endsWith(closed) && alone[2]!.endsWith(closed)),
          `box text spilled past its border: ${JSON.stringify(alone[1])} ${JSON.stringify(alone[2])}`
        )
      }
    }, 7)
  })
})

describe("apps/tui frame, envelope and command parsing", () => {
  /** JSON a vendor or gateway could send in place of the field the reader expects. */
  const junk = [
    "null",
    "0",
    "-1.5",
    "true",
    "\"\"",
    "\"text\"",
    "\"\\u001b[31mred\\u0000\"",
    "[]",
    "[null]",
    "[1,\"a\",null,{}]",
    "{}",
    "{\"text\":5}",
    "{\"type\":\"text\"}",
    "{\"type\":\"text\",\"text\":null}",
    "{\"type\":\"tool_use\",\"name\":7,\"input\":\"ls\"}",
    "{\"type\":\"tool_result\",\"content\":[null,{\"text\":3},{\"text\":\"a\\nb\"}]}",
    "{\"path\":null}",
    "{\"message\":{\"content\":3}}"
  ] as const
  const Junk = Schema.Literals(junk)
  const parsed = (value: string): unknown => JSON.parse(value)

  it("a wrapped vendor's stream line always folds to drawable rows: malformed, truncated, mistyped or escape-laden", async () => {
    const Part = Schema.Struct({
      junk: Schema.Boolean,
      value: Junk,
      type: Schema.Literals(["text", "tool_use", "tool_result", "bogus"]),
      text: Schema.Union([Mixed, Schema.Struct({ junk: Junk })]),
      input: Junk
    })
    const arb = Arbitrary.schema(Schema.Struct({
      vendor: Schema.Literals(Wrapped.vendors),
      shape: int(0, 9),
      type: Schema.Literals([
        "system",
        "assistant",
        "user",
        "result",
        "thread.started",
        "turn.completed",
        "turn.failed",
        "error",
        "item.completed",
        "bogus"
      ]),
      item: Schema.Literals(["agent_message", "command_execution", "file_change", "bogus"]),
      parts: list(Part, 5),
      text: Mixed,
      a: Junk,
      b: Junk,
      c: Junk,
      cut: int(0, 400)
    }))
    await runFuzz(arb, ({ vendor, shape, type, item, parts, text: raw, a, b, c, cut }) => {
      const text = mixed(raw)
      const content = parts.map((part) =>
        part.junk ? parsed(part.value) : {
          type: part.type,
          text: "junk" in part.text ? parsed(part.text.junk) : mixed(part.text),
          name: shape % 2 === 0 ? "Read" : parsed(part.input),
          input: shape % 3 === 0 ? { file_path: text } : parsed(part.input),
          content: shape % 2 === 0 ? text : parsed(part.input)
        }
      )
      const event = {
        type,
        subtype: shape % 2 === 0 ? "init" : "success",
        session_id: shape % 4 === 0 ? "session-1" : parsed(a),
        thread_id: shape % 4 === 0 ? "thread-1" : parsed(a),
        is_error: parsed(b),
        result: shape % 3 === 0 ? text : parsed(c),
        error: shape % 3 === 0 ? { message: text } : parsed(b),
        usage: shape % 2 === 0 ? { input_tokens: 3, output_tokens: 4 } : parsed(c),
        message: shape === 9 ? parsed(a) : {
          id: shape % 2 === 0 ? "message-1" : parsed(b),
          model: shape % 2 === 0 ? "claude-opus-5-5" : parsed(c),
          usage: shape % 3 === 1 ? parsed(a) : { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          content: shape === 8 ? parsed(b) : content
        },
        item: shape === 9 ? parsed(b) : {
          type: item,
          text: shape % 2 === 0 ? text : parsed(a),
          command: shape % 2 === 0 ? text : parsed(b),
          aggregated_output: shape % 3 === 0 ? text : parsed(c),
          exit_code: parsed(a),
          changes: shape % 2 === 0 ? [{ path: "src/a.ts" }, { path: text }] : parsed(c)
        }
      }
      const whole = JSON.stringify(event)
      const line = shape === 7 ? whole.slice(0, Math.min(cut, whole.length - 1)) : shape === 6 ? text : whole
      const folded = Wrapped.fold(vendor, line)
      check(Array.isArray(folded.rows), "rows is not a list")
      for (const row of folded.rows) {
        check(
          typeof row.glyph === "string" && typeof row.text === "string",
          `a row is not text: ${JSON.stringify(row)}`
        )
        if (!row.text.startsWith("Edited ")) {
          check(!row.text.includes("\n"), "a stream row spans lines")
          check(row.text.length <= 240, `a stream row holds ${row.text.length} characters`)
        }
      }
      check(folded.answer === undefined || typeof folded.answer === "string", "the answer is not text")
      check(folded.error === undefined || typeof folded.error === "string", "the error is not text")
      check(folded.announce === undefined || typeof folded.announce === "string", "the session id is not text")
      let json = true
      try {
        JSON.parse(line)
      } catch {
        json = false
      }
      if (!json) check(JSON.stringify(folded) === "{\"rows\":[]}", "a line that is not JSON drew something")
    }, 8)
  })

  it("published panels and contributions round-trip exactly or are refused whole: no partial panel, no oversized or multi-line field", async () => {
    const Block = Schema.Struct({ kind: int(0, 3), text: Mixed })
    const arb = Arbitrary.schema(Schema.Struct({
      title: Mixed,
      placement: Schema.Literals(["none", "tab", "card"]),
      rows: list(
        Schema.Struct({
          label: Mixed,
          status: Schema.Literals([
            "",
            "running",
            "waiting",
            "queued",
            "parked",
            "done",
            "failed",
            "requested",
            "cancelled"
          ]),
          details: list(Block, 3),
          action: int(0, 4)
        }),
        6
      ),
      duplicate: Schema.Boolean,
      mutation: int(0, 14),
      key: Schema.Union([
        Schema.Literals(["alt+z", "ctrl+shift+e", "z", "ctrl+", "bad+a", "alt+a\nb", "shift+a", "", "ctrl+k"]),
        Schema.String.pipe(Schema.check(Schema.isMaxLength(44)))
      ]),
      context: Schema.Literals(["", "global", "panel"]),
      label: Text
    }))
    await runFuzz(arb, ({ title, placement, rows, duplicate, mutation, key, context, label }) => {
      // Schema strings are code points a JSON wire can carry; a field holds 1..240 of them.
      const short = (value: typeof Mixed.Type): string => (mixed(value).toWellFormed() || "x").slice(0, 120)
      const panel = {
        id: "panel-1",
        title: short(title),
        summary: short(title).replace(/[\r\n]/g, " "),
        rows: rows.map((row, index) => ({
          id: duplicate && index === rows.length - 1 && rows.length > 1 ? "row-0" : `row-${index}`,
          label: short(row.label),
          ...(row.status === "" ? {} : { status: row.status }),
          details: row.details.map((block) => {
            const body = mixed(block.text).toWellFormed()
            return block.kind === 0
              ? { kind: "text" as const, text: body }
              : block.kind === 1
              ? { kind: "code" as const, code: body, language: "ts" }
              : block.kind === 2
              ? { kind: "diff" as const, patch: body, path: "src/a.ts" }
              : { kind: "table" as const, columns: ["a", "b"], rows: [[body, ""], []] }
          }),
          ...(row.action === 1
            ? { action: { label: "Send", prompt: short(row.label) } }
            : row.action === 2
            ? {
              action: {
                label: "Run",
                action: { kind: "flow" as const, flow: "deploy", input: { dry: true, n: [1, null] } }
              }
            }
            : row.action === 3
            ? { action: { label: "Ask", action: { kind: "agent" as const, agent: "reviewer", prompt: "" } } }
            : row.action === 4
            ? { action: { label: "Open", action: { kind: "open" as const, surface: "tab:w1" } } }
            : {})
        }))
      }
      const wire = (): any => JSON.parse(JSON.stringify(panel))
      const outcome = <A>(decode: () => A): { readonly value: A } | { readonly error: unknown } => {
        try {
          return { value: decode() }
        } catch (error) {
          return { error }
        }
      }
      const refused = (result: { readonly value: unknown } | { readonly error: unknown }, why: string) => {
        check("error" in result, `${why} was accepted`)
        if ("error" in result) check(result.error instanceof Error, `${why} threw a non-error`)
      }
      const unique = new Set(panel.rows.map((row) => row.id)).size === panel.rows.length
      const decoded = outcome(() => Panels.decode(wire()))
      const published = outcome(() =>
        Extension.decode(placement === "none" ? wire() : { kind: "panel", placement, panel: wire() })
      )
      const bare = outcome(() => Extension.decode({ kind: "panel", panel: wire() }))
      if (!unique) {
        refused(decoded, "a panel with two rows of one id")
        refused(published, "a published panel with two rows of one id")
      } else {
        check("value" in decoded && Bun.deepEquals(decoded.value, panel, true), "a panel did not round-trip")
        check(
          "value" in published && published.value.kind === "panel" &&
            published.value.placement === (placement === "card" ? "card" : "tab") &&
            Bun.deepEquals(published.value.panel, panel, true),
          "a published panel did not round-trip"
        )
        check("value" in bare && bare.value.kind === "panel" && bare.value.placement === "tab", "placement default")
      }

      const broken = wire()
      const first = broken.rows[0]
      const long = "x".repeat(241)
      const applied = mutation === 0
        ? delete broken.title
        : mutation === 1
        ? (broken.title = long)
        : mutation === 2
        ? (broken.id = "")
        : mutation === 3
        ? (broken.summary = "two\nlines")
        : mutation === 4
        ? (broken.rows = "rows")
        : mutation === 5
        ? (broken.rows = Array.from({ length: 501 }, (_, index) => ({ id: `r${index}`, label: "row", details: [] })))
        : mutation === 6
        ? (broken.placement = "card")
        : mutation === 7
        ? (broken.summary = null)
        : mutation === 8
        ? (broken.bind = { tree: 7 })
        : first === undefined
        ? undefined
        : mutation === 9
        ? (first.status = "exploded")
        : mutation === 10
        ? (first.details = Array.from({ length: 41 }, () => ({ kind: "text", text: "" })))
        : mutation === 11
        ? (first.action = { label: "Shell", action: { kind: "shell", command: "rm -rf /" } })
        : mutation === 12
        ? (first.details = [{ kind: "table", columns: Array.from({ length: 13 }, () => "c"), rows: [] }])
        : mutation === 13
        ? (first.label = long)
        : (first.details = [{ kind: "html", html: "<b>" }])
      if (applied !== undefined) {
        refused(outcome(() => Panels.decode(broken)), `a panel broken by mutation ${mutation}`)
        refused(outcome(() => Extension.decode(broken)), `a published panel broken by mutation ${mutation}`)
      }

      const contributed = outcome(() =>
        Extension.decode({
          kind: "key",
          key: {
            id: "key-1",
            key,
            label,
            action: { kind: "prompt", prompt: "go" },
            ...(context === "" ? {} : { context })
          }
        })
      )
      const scope = context === "panel" ? "panel" : "global"
      const lineOf = (value: string, max: number) => value.length >= 1 && value.length <= max && !/[\r\n]/.test(value)
      const valid = lineOf(key, 40) && lineOf(label, 24) && Extension.keyProblem(key, scope) === undefined
      check(
        valid === ("value" in contributed),
        `key ${JSON.stringify(key)} in ${scope}: accepted ${"value" in contributed}`
      )
      if ("error" in contributed) check(contributed.error instanceof Error, "a refused key threw a non-error")
      if ("value" in contributed && scope === "global") {
        check(/(^|\+)(ctrl|alt)\+/.test(key), `global key ${key} has no modifier`)
      }
      const status = outcome(() => Extension.decode({ kind: "status", status: { id: "status-1", text: label } }))
      check(lineOf(label, 24) === ("value" in status), `status text ${JSON.stringify(label)}`)
    }, 9)
  })

  it("engine envelopes, rg frames, slash commands and streamed fences parse without throwing and keep their fields exact", async () => {
    const Envelope = Schema.Struct({
      engine: Schema.Boolean,
      shape: int(0, 5),
      eventType: Schema.Literals([
        "flows.engine.node-scheduled",
        "flows.engine.node-settled",
        "flows.engine.attempt-started",
        "flows.engine.attempt-finished",
        "flows.engine.bogus"
      ]),
      node: Schema.Literals(["n1", "n2", "n3", ""]),
      action: Schema.Literals(["deploy/build", "deploy/test", "other", "deploy", "registry/entry/x", ""]),
      kind: Schema.Literals(["ActionCall", "FlowCall", "AndThen"]),
      outcome: Schema.Literals(["ok", "failed", "skipped", "deferred"]),
      digest: Schema.Literals(["d1", "d2"]),
      junk: Junk
    })
    const arb = Arbitrary.schema(Schema.Struct({
      envelopes: list(Envelope, 14),
      settled: Schema.Boolean,
      path: Mixed,
      text: Mixed,
      bytes: Schema.Boolean,
      lineNumber: Schema.Union([int(0, 100_000), Schema.Literals([1.5, -1])]),
      raw: Mixed,
      cursor: int(0, 120),
      insert: Text,
      prose: list(Text, 3),
      code: list(Text, 3),
      cut: int(0, 400)
    }))
    await runFuzz(
      arb,
      (
        {
          envelopes,
          settled,
          path: rawPath,
          text: rawText,
          bytes,
          lineNumber,
          raw: rawInput,
          cursor,
          insert,
          prose,
          code,
          cut
        }
      ) => {
        // Gateway engine envelopes: `{ eventType, payload }` inside a control event, any field of any type.
        const scheduled = new Map<string, string | undefined>()
        const events = envelopes.map((each, sequence) => {
          // Junk in a field's place is sometimes a string, which a node id or an action may be.
          const nodeId = each.shape === 2 ? parsed(each.junk) : each.node
          const action = each.shape === 3 ? parsed(each.junk) : each.action
          const payload = each.shape === 1 ? parsed(each.junk) : {
            nodeId,
            action,
            kind: each.kind,
            outcome: each.outcome,
            stepKeyDigest: each.shape === 4 ? parsed(each.junk) : each.digest,
            result: each.shape === 5 ? parsed(each.junk) : { preview: `${each.node} ok` }
          }
          if (each.engine && each.shape > 1 && typeof nodeId === "string") {
            if (each.eventType === "flows.engine.node-scheduled" && typeof action === "string") {
              const step = each.kind === "ActionCall" ||
                (each.kind === "FlowCall" && action !== "deploy" && !action.startsWith("registry/entry/"))
              // A retry schedules the node again: it keeps its place and loses its outcome.
              if (step) scheduled.set(nodeId, undefined)
            }
            if (each.eventType === "flows.engine.node-settled" && scheduled.has(nodeId)) {
              scheduled.set(nodeId, each.outcome)
            }
          }
          return {
            kind: each.engine ? "control.engine.event" : "control.run.started",
            sequence,
            payload: each.shape === 0 ? parsed(each.junk) : { eventType: each.eventType, payload }
          }
        }) as unknown as ReadonlyArray<ControlSchema.ControlEvent>
        const steps = Flows.steps(events, "deploy", settled)
        check(steps.map((step) => step.id).join() === [...scheduled.keys()].join(), "steps are not the scheduled nodes")
        let waiting = false
        for (const step of steps) {
          const outcome = scheduled.get(step.id)
          const expected = outcome === undefined
            ? undefined
            : outcome === "failed"
            ? "failed"
            : outcome === "skipped" || outcome === "deferred"
            ? "cancelled"
            : "done"
          if (expected !== undefined) check(step.status === expected, `step ${step.id} is ${step.status}`)
          else {
            check(step.status === "running" || step.status === "requested", `open step ${step.id} is ${step.status}`)
            check(!(settled && step.status === "running"), "a settled run shows a running step")
            check(!(waiting && step.status === "running"), "a later step runs before an earlier one")
            waiting = step.status === "requested"
          }
          check(typeof step.label === "string" && !step.label.startsWith("deploy/"), `step label ${step.label}`)
          check(step.preview === undefined || typeof step.preview === "string", "a preview is not text")
        }

        // rg `--json` frames: an exact path, an integer line, a bounded single-line text.
        const path = mixed(rawPath).toWellFormed()
        const text = mixed(rawText).toWellFormed()
        const data = (value: string) =>
          bytes ? { bytes: Buffer.from(value, "utf8").toString("base64") } : { text: value }
        const match = { type: "match", data: { path: data(path), line_number: lineNumber, lines: data(`${text}\n`) } }
        const frame = JSON.stringify(match)
        const hit = Search.parse(frame)
        if (Number.isInteger(lineNumber)) {
          check(hit !== undefined, "a well-formed match frame was dropped")
          if (hit !== undefined) {
            check(hit.path === path.replace(/^\.\//, "") && hit.line === lineNumber, `hit path ${hit.path}`)
            check(hit.text === text.slice(0, 200), "hit text is not the matched line, bounded")
          }
        } else check(hit === undefined, "a fractional line number became a hit")
        check(Search.parse(frame.slice(0, Math.min(cut, frame.length - 1))) === undefined, "a truncated frame parsed")
        const binary = {
          ...match,
          data: { ...match.data, path: { bytes: Buffer.from([0xff, 0xfe, 0x2f]).toString("base64") } }
        }
        check(Search.parse(JSON.stringify(binary)) === undefined, "a path that is not UTF-8 was named")
        check(Search.parse(JSON.stringify({ ...match, type: "begin" })) === undefined, "a begin frame became a hit")
        check(Search.parse(JSON.stringify({ ...match, data: null })) === undefined, "a frame without data became a hit")

        // Palette prefixes: the parse of a query's normal form is that query.
        const input = mixed(rawInput)
        const palette = Palette.parse(input)
        const normal = Palette.parse(`${palette.prefix}${palette.query}`)
        check(Bun.deepEquals(normal, palette, true), `palette parse is not stable: ${JSON.stringify(palette)}`)
        check(palette.query === palette.query.trim(), "a palette query kept its padding")
        check(
          palette.regex === undefined || (palette.mode === "text" && palette.query === `/${palette.regex}/`),
          "regex"
        )
        const at = Math.min(cursor, input.length)
        const inserted = Palette.insertAt(input, at, insert)
        check(
          inserted.text.startsWith(input.slice(0, at)) && inserted.text.endsWith(input.slice(at)) &&
            inserted.cursor >= at && inserted.cursor <= inserted.text.length,
          "insertAt moved text it did not insert"
        )

        // The composer's completion span stays inside the text, wherever the cursor sits.
        const files = [path, "src/index.ts", "a b/c d.ts", text].filter((file) => file !== "")
        const completion = Complete.complete(input, at, {
          models: [{ seat: "openai:gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai" }],
          files: () => files
        })
        if (completion !== undefined) {
          check(
            completion.start >= 0 && completion.start <= at && completion.end >= at && completion.end <= input.length,
            `completion span ${completion.start}..${completion.end} around ${at} of ${input.length}`
          )
          if (completion.kind === "file") {
            check(input[completion.start] === "@", "a file completion does not start at @")
          }
          check(completion.items.length <= Math.max(Complete.fileLimit, Editor.commands.length + 1), "too many items")
          for (const item of completion.items) {
            const applied = Complete.apply(input, completion, item)
            check(
              applied.text.startsWith(input.slice(0, completion.start)) &&
                applied.text.endsWith(input.slice(completion.end)) &&
                applied.cursor >= completion.start && applied.cursor <= applied.text.length,
              "applying a completion moved text outside its span"
            )
            if (completion.kind === "file") check(!/[\n\r\x00\x1b]/.test(item.insert), "a mention holds a control byte")
          }
        }

        // Streamed replies: fences split into prose and program at any cut, and whole replies split exactly.
        const clean = (value: string) => value.replaceAll("`", "'")
        const reply = prose.map((part, index) => `${clean(part)}\n\`\`\`ts\n${clean(code[index] ?? "")}\n\`\`\`\n`)
          .join("")
        const split = Transcript.split(reply)
        const expectedProse = prose.map((part) => clean(part).trim()).filter((part) => part !== "").join("\n")
        check(split.prose === expectedProse, `prose ${JSON.stringify(split.prose)}`)
        check(split.code === prose.map((_, index) => clean(code[index] ?? "")).join("\n"), "program text changed")
        const partial = Transcript.split(reply.slice(0, Math.min(cut, reply.length)))
        check(typeof partial.prose === "string" && typeof partial.code === "string", "a cut reply did not split")
        check(!partial.prose.includes("```ts\n"), "an open fence leaked into the prose")
        const unfenced = Transcript.split(clean(input))
        check(unfenced.code === "" && unfenced.prose === clean(input).trim(), "prose without a fence changed")
      },
      10
    )
  })
})

describe("apps/tui regressions the fuzz properties found", () => {
  const row = (name: string, seat: string, clock: string): Inbox.Row => ({
    key: "w1",
    group: "working",
    level: 0,
    status: "running",
    name,
    seat,
    clock
  })

  it("pads a wide model name by cells, so a tree row stays inside its pane", () => {
    const drawn = SubagentView.treeRow(row("مرحبا بالعالم", "ｆｕｌｌｗｉｄｔｈ", "1h 02m"), 2, 28, 9)
    expect(2 + stringWidth(drawn.title) + drawn.gap + stringWidth(drawn.aside)).toBeLessThanOrEqual(27)
  })

  it("draws a clock whole in the tightest pane that fits it", () => {
    expect(SubagentView.treeRow(row("worker", "", "resets 21:43"), 2, 17, 9).aside).toBe("resets 21:43")
  })

  it("keeps a graph box closed when its name holds terminal escapes", () => {
    const colors = { line: "#969083", accent: "#45c4b2", text: "#ece7db", faint: "#a8a193" }
    const name = "\x1b]8;;https://example.test\x07link\x1b]8;;\x07"
    const drawn = Graph.draw({ key: "n", glyph: "✓", tone: "#7fbfb3", name, sub: "", children: [] }, "", colors)
    const line = drawn.rows[1]!.map((span) => span.text).join("")
    expect(line.endsWith(`│${" ".repeat(Graph.size.gap)}`)).toBe(true)
    expect(line.split("│")).toHaveLength(3)
  })

  it("folds a vendor line whose content, usage or session is null or mistyped", () => {
    const assistant = { type: "assistant", message: { usage: null, content: [null, { type: "text", text: 5 }, 7] } }
    expect(Wrapped.fold("claude", JSON.stringify(assistant))).toEqual({ settled: true, rows: [] })
    expect(Wrapped.fold("claude", JSON.stringify({ type: "system", subtype: "init", session_id: 5 }))).toEqual({
      rows: []
    })
    const edited = { type: "item.completed", item: { type: "file_change", changes: [null, { path: "a.ts" }] } }
    expect(Wrapped.fold("codex", JSON.stringify(edited)).rows).toEqual([{ glyph: "•", text: "Edited a.ts" }])
    expect(Wrapped.fold("codex", JSON.stringify({ type: "turn.completed", usage: null })).usage).toEqual({
      input: 0,
      output: 0,
      cached: 0
    })
  })
})
