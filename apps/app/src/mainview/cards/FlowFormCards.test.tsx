import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { FlowFormCardBody } from "./FlowFormCards"
import { payloadFor } from "../flows/SlashPayload"

/*
 * THE FORM LAW (flow-forms.md): the generic form card. One control per
 * field kind, an unpickable option disabled with its reason, every field
 * commit through form.set with the card id, Submit as form.submit (disabled
 * until the required fields are filled), Cancel as card.dismiss, and a
 * submitted card that keeps its record and offers nothing further.
 */

GlobalRegistrator.register()
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type FlowFormCard = Extract<Card, { kind: "flow-form" }>

const base = { title: "/tab.harness", status: "active" as const, createdAt: 0, ordinal: 0 }

const formCard = (payload: Partial<FlowFormCard["payload"]> = {}, status: Card["status"] = "active"): FlowFormCard => ({
  ...base,
  id: "form-tab.harness",
  kind: "flow-form",
  status,
  payload: {
    flow: "tab.harness",
    via: "agent",
    fields: [
      { name: "id", label: "Id", kind: "text", required: true },
      {
        name: "harness",
        label: "Harness",
        kind: "select",
        required: true,
        optionsFrom: "harnesses",
        options: [
          { value: "claude", label: "Claude Code · will@example.com" },
          { value: "codex", label: "Codex · OPENAI_API_KEY" },
          { value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" },
          { value: "pi", label: "Pi", disabled: true, reason: "not installed" }
        ]
      },
      {
        name: "bookmark",
        label: "Bookmark",
        kind: "text",
        required: true,
        optionsFrom: "bookmarks",
        options: [{ value: "main", label: "main" }, { value: "work", label: "work" }]
      },
      { name: "seq", label: "Seq", kind: "number", required: false },
      { name: "follow", label: "Follow", kind: "boolean", required: false },
      { name: "purpose", label: "Purpose", kind: "text", required: false, placeholder: "Reviews diffs" }
    ],
    draft: {},
    given: {},
    ...payload
  }
})

const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  flushSync(() => {
    root.render(node)
  })
  return host
}

const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}

const input = (host: HTMLElement, testId: string, value: string): void => {
  const input = host.querySelector<HTMLInputElement>(`[data-testid=${testId}]`)
  if (input === null) throw new Error(`no field ${testId}`)
  input.value = value
  flushSync(() => input.dispatchEvent(new InputEvent("input", { bubbles: true })))
}

describe("the flow form card", () => {
  test("a multiline handoff is editable through form.set and uses the clipboard submit label", () => {
    const recorder = { calls: [] as Array<[string, string | undefined]> }
    const host = mount(<FlowFormCardBody card={formCard({
      fields: [{ name: "text", label: "Handoff brief", kind: "textarea", required: true }],
      draft: { text: "Goal\nEvidence" }, submitLabel: "Copy brief"
    })} onRunCommand={(name, args) => recorder.calls.push([name, args])} />)
    expect(host.querySelector("textarea")?.value).toBe("Goal\nEvidence")
    input(host, "flow-form-text", "Goal\nEvidence\nNext step")
    expect(recorder.calls[0]).toEqual(["form.set", "form-tab.harness text Goal\nEvidence\nNext step"])
    const copy = [...host.querySelectorAll("button")].find(button => button.textContent === "Copy brief")
    copy?.click()
    expect(recorder.calls[1]).toEqual(["form.submit", "form-tab.harness"])
  })
  test("renders one control per field kind: text, select, text with a datalist, number, checkbox", () => {
    const host = mount(<FlowFormCardBody card={formCard()} onRunCommand={() => {}} />)
    expect(host.querySelector("[data-testid=flow-form-id]")?.getAttribute("type")).toBe("text")
    expect(host.querySelector("[data-testid=flow-form-harness]")?.tagName).toBe("SELECT")
    const bookmark = host.querySelector<HTMLInputElement>("[data-testid=flow-form-bookmark]")
    expect(bookmark?.getAttribute("type")).toBe("text")
    expect(bookmark?.getAttribute("list")).toBe("flow-form-options-form-tab.harness-bookmark")
    expect([...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"))).toEqual(["main", "work"])
    expect(host.querySelector("[data-testid=flow-form-seq]")?.getAttribute("type")).toBe("number")
    expect(host.querySelector("[data-testid=flow-form-follow]")?.getAttribute("type")).toBe("checkbox")
    expect(host.querySelector<HTMLInputElement>("[data-testid=flow-form-purpose]")?.placeholder).toBe("Reviews diffs")
    // The rows say which fields are required; nothing else is added.
    expect([...host.querySelectorAll("[data-field]")].map((row) => [row.getAttribute("data-field"), row.getAttribute("data-required")])).toEqual([
      ["id", "true"],
      ["harness", "true"],
      ["bookmark", "true"],
      ["seq", "false"],
      ["follow", "false"],
      ["purpose", "false"]
    ])
  })

  test("an option the human cannot pick is disabled and carries its reason; an unpicked select offers the empty choice", () => {
    const host = mount(<FlowFormCardBody card={formCard()} onRunCommand={() => {}} />)
    const options = [...host.querySelectorAll<HTMLOptionElement>("[data-testid=flow-form-harness] option")]
    expect(options.map((option) => [option.value, option.disabled, option.textContent])).toEqual([
      ["", false, ""],
      ["claude", false, "Claude Code · will@example.com"],
      ["codex", false, "Codex · OPENAI_API_KEY"],
      ["opencode", true, "OpenCode · no credential"],
      ["pi", true, "Pi · not installed"]
    ])
    expect(options[3]?.getAttribute("title")).toBe("no credential")
    // Once picked, the empty choice is gone.
    const picked = mount(<FlowFormCardBody card={formCard({ draft: { harness: "codex" } })} onRunCommand={() => {}} />)
    expect([...picked.querySelectorAll<HTMLOptionElement>("[data-testid=flow-form-harness] option")].map((option) => option.value)).toEqual(["claude", "codex", "opencode", "pi"])
    expect(picked.querySelector<HTMLSelectElement>("[data-testid=flow-form-harness]")?.value).toBe("codex")
  })

  test("every field commits through form.set with the card id; a blank commit clears; Cancel is card.dismiss", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<FlowFormCardBody card={formCard({ draft: { purpose: "old" } })} onRunCommand={onRunCommand} />)
    input(host, "flow-form-id", "reviewer")
    const harness = host.querySelector<HTMLSelectElement>("[data-testid=flow-form-harness]")
    if (harness === null) throw new Error("no harness select")
    harness.value = "codex"
    harness.dispatchEvent(new Event("change", { bubbles: true }))
    input(host, "flow-form-bookmark", "work")
    input(host, "flow-form-seq", "3")
    const follow = host.querySelector<HTMLInputElement>("[data-testid=flow-form-follow]")
    if (follow === null) throw new Error("no checkbox")
    follow.click()
    input(host, "flow-form-purpose", "")
    // Returning to the rendered value still commits, even before the previous edit re-renders.
    input(host, "flow-form-purpose", "old")
    host.querySelector<HTMLButtonElement>("[data-testid=flow-form-cancel]")?.click()
    expect(calls).toEqual([
      ["form.set", "form-tab.harness id reviewer"],
      ["form.set", "form-tab.harness harness codex"],
      ["form.set", "form-tab.harness bookmark work"],
      ["form.set", "form-tab.harness seq 3"],
      ["form.set", "form-tab.harness follow true"],
      ["form.set", "form-tab.harness purpose"],
      ["form.set", "form-tab.harness purpose old"],
      ["card.dismiss", "form-tab.harness"]
    ])
    expect(host.querySelector("[data-testid=flow-form-cancel]")?.getAttribute("data-flow")).toBe("card.dismiss")
  })

  test("input commits the live draft, enables Submit without blur, and preserves focus and spaces across updates", () => {
    let card = formCard({ fields: [{ name: "description", label: "What should this issue flow do?", kind: "text", required: true }] })
    const calls: Array<[string, string | undefined]> = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
    const render = () => root.render(<FlowFormCardBody card={card} onRunCommand={(name, args) => {
      calls.push([name, args])
      if (name !== "form.set") return
      const parsed = payloadFor(name, args)
      if (!("payload" in parsed)) throw new Error("field commit did not parse")
      card = { ...card, payload: { ...card.payload, draft: { description: String(parsed.payload.value) } } }
      render()
    }} />)
    flushSync(render)
    const field = host.querySelector<HTMLInputElement>("input")!
    const submit = host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")!
    expect(submit.disabled).toBe(true)
    field.focus()
    for (const value of ["Research", "Research ", "Research errors"]) {
      input(host, "flow-form-description", value)
      expect(host.querySelector("input")).toBe(field)
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe(value)
      expect(submit.disabled).toBe(false)
    }
    submit.click()
    expect(calls.at(-1)).toEqual(["form.submit", card.id])
    input(host, "flow-form-description", "")
    expect(submit.disabled).toBe(true)
  })

  test("Enter submits a complete single-line field once, without blurring; composition and incomplete or busy forms do not submit", () => {
    for (const state of ["ready", "composing", "empty", "busy", "acted"] as const) {
      const { calls, onRunCommand } = recorder()
      const host = mount(<FlowFormCardBody card={formCard({
        fields: [{ name: "id", label: "Id", kind: "text", required: true }],
        draft: state === "empty" ? {} : { id: "reviewer" }, submitting: state === "busy"
      }, state === "acted" ? "acted" : "active")} onRunCommand={onRunCommand} />)
      const field = host.querySelector<HTMLInputElement>("input")!
      field.focus()
      flushSync(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: state === "composing" })))
      expect(calls).toEqual(state === "ready" ? [["form.submit", "form-tab.harness"]] : [])
      if (state === "ready") expect(document.activeElement).toBe(field)
    }
  })

  test("Enter in a multiline field leaves newline editing to the control", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<FlowFormCardBody card={formCard({ fields: [{ name: "text", label: "Brief", kind: "textarea", required: true }], draft: { text: "Goal" } })} onRunCommand={onRunCommand} />)
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    host.querySelector("textarea")!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(calls).toEqual([])
  })

  test("a number field accepts fractional values on the form submission path", () => {
    const { calls, onRunCommand } = recorder()
    const host = mount(<FlowFormCardBody card={formCard({ fields: [{ name: "amount", label: "Amount", kind: "number", required: true }], draft: { amount: 0.5 } })} onRunCommand={onRunCommand} />)
    expect(host.querySelector<HTMLInputElement>("input")!.checkValidity()).toBe(true)
    host.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")!.click()
    expect(calls).toEqual([["form.submit", "form-tab.harness"]])
  })

  test("Submit is form.submit, disabled until every required field is filled; a boolean never blocks it", () => {
    const { calls, onRunCommand } = recorder()
    const empty = mount(<FlowFormCardBody card={formCard()} onRunCommand={onRunCommand} />)
    const disabled = empty.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")
    expect(disabled?.disabled).toBe(true)
    expect(disabled?.getAttribute("data-flow")).toBe("form.submit")
    const filled = mount(
      <FlowFormCardBody card={formCard({ draft: { id: "reviewer", harness: "codex", bookmark: "work" } })} onRunCommand={onRunCommand} />
    )
    const submit = filled.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")
    expect(submit?.disabled).toBe(false)
    expect(submit?.textContent).toBe("Submit")
    submit?.click()
    expect(calls).toEqual([["form.submit", "form-tab.harness"]])
  })

  test("a submitted card keeps its record with the controls disabled and no acts; a refused submit shows the reason and stays editable", () => {
    const acted = mount(
      <FlowFormCardBody card={formCard({ draft: { id: "reviewer", harness: "codex", bookmark: "work" } }, "acted")} onRunCommand={() => {}} />
    )
    expect(acted.querySelector("[data-testid=flow-form-submit]")).toBeNull()
    expect(acted.querySelector("[data-testid=flow-form-cancel]")).toBeNull()
    expect(acted.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.disabled).toBe(true)
    expect(acted.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.value).toBe("reviewer")
    const refused = mount(
      <FlowFormCardBody
        card={formCard({ draft: { id: "ui", harness: "codex", bookmark: "work" }, error: "The harness is unavailable." }, "error")}
        onRunCommand={() => {}}
      />
    )
    expect(refused.querySelector("[role=alert]")?.textContent).toBe("The harness is unavailable.")
    expect(refused.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.disabled).toBe(false)
    expect(refused.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")?.disabled).toBe(false)
  })
})

 test("a user form receives focus from its invoking button without stealing unrelated editing focus", () => {
   const trigger = document.createElement("button")
   trigger.dataset.flow = "tab.harness"
   document.body.append(trigger)
   cleanups.push(() => trigger.remove())
   trigger.focus()
   const form = mount(<FlowFormCardBody card={formCard({ via: "user" })} onRunCommand={() => {}} />)
   expect(document.activeElement).toBe(form.querySelector("input"))
   const editor = document.createElement("textarea")
   document.body.append(editor)
   cleanups.push(() => editor.remove())
   editor.focus()
   mount(<FlowFormCardBody card={formCard({ via: "user" })} onRunCommand={() => {}} />)
   expect(document.activeElement).toBe(editor)
   trigger.focus()
   mount(<FlowFormCardBody card={formCard({ via: "agent" })} onRunCommand={() => {}} />)
   expect(document.activeElement).toBe(trigger)
 })

test("invoking a persisted form again hands focus back without refocusing on draft edits", () => {
 const trigger = document.createElement("button")
 trigger.dataset.flow = "tab.harness"
 const host = document.createElement("div")
 document.body.append(trigger, host)
 const root = createRoot(host)
 cleanups.push(() => { flushSync(() => root.unmount()); host.remove(); trigger.remove() })
 const card = formCard({ via: "user" })
 const render = (ordinal: number, draft = {}) => flushSync(() => root.render(<FlowFormCardBody card={{ ...card, ordinal, payload: { ...card.payload, draft } }} onRunCommand={() => {}} />))
 render(1)
 trigger.focus()
 render(2)
 expect(document.activeElement).toBe(host.querySelector("input"))
 const second = host.querySelector("select")!
 second.focus()
 render(2, { id: "saved" })
 expect(document.activeElement).toBe(second)
})
