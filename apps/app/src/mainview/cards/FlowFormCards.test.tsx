import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { FlowFormCardBody } from "./FlowFormCards"

/*
 * THE FORM LAW (flow-forms.md): the generic form card. One control per
 * field kind, an unpickable option disabled with its reason, every field
 * commit through form.set with the card id, Submit as form.submit (disabled
 * until the required fields are filled), Cancel as card.dismiss, and a
 * submitted card that keeps its record and offers nothing further.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type FlowFormCard = Extract<Card, { kind: "flow-form" }>

const base = { title: "/agent.create", status: "active" as const, createdAt: 0, ordinal: 0 }

const formCard = (payload: Partial<FlowFormCard["payload"]> = {}, status: Card["status"] = "active"): FlowFormCard => ({
  ...base,
  id: "form-agent.create",
  kind: "flow-form",
  status,
  payload: {
    flow: "agent.create",
    via: "agent",
    fields: [
      { name: "id", label: "Id", kind: "text", required: true },
      {
        name: "harness",
        label: "Harness",
        kind: "select",
        required: true,
        optionsFrom: "agent-harnesses",
        options: [
          { value: "claude", label: "Claude Code · will@example.com" },
          { value: "codex", label: "Codex · OPENAI_API_KEY" },
          { value: "opencode", label: "OpenCode", disabled: true, reason: "no credential" },
          { value: "pi", label: "Pi", disabled: true, reason: "not installed" }
        ]
      },
      {
        name: "model",
        label: "Model",
        kind: "text",
        required: true,
        optionsFrom: "harness-models",
        options: [{ value: "gpt-5.6-sol", label: "gpt-5.6-sol" }, { value: "gpt-5.6-terra", label: "gpt-5.6-terra" }]
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
  flushSync(() => {
    createRoot(host).render(node)
  })
  return host
}

const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}

const blur = (host: HTMLElement, testId: string, value: string): void => {
  const input = host.querySelector<HTMLInputElement>(`[data-testid=${testId}]`)
  if (input === null) throw new Error(`no field ${testId}`)
  input.value = value
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
}

describe("the flow form card", () => {
  test("renders one control per field kind: text, select, text with a datalist, number, checkbox", () => {
    const host = mount(<FlowFormCardBody card={formCard()} onRunCommand={() => {}} />)
    expect(host.querySelector("[data-testid=flow-form-id]")?.getAttribute("type")).toBe("text")
    expect(host.querySelector("[data-testid=flow-form-harness]")?.tagName).toBe("SELECT")
    const model = host.querySelector<HTMLInputElement>("[data-testid=flow-form-model]")
    expect(model?.getAttribute("type")).toBe("text")
    expect(model?.getAttribute("list")).toBe("flow-form-options-form-agent.create-model")
    expect([...host.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"))).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"])
    expect(host.querySelector("[data-testid=flow-form-seq]")?.getAttribute("type")).toBe("number")
    expect(host.querySelector("[data-testid=flow-form-follow]")?.getAttribute("type")).toBe("checkbox")
    expect(host.querySelector<HTMLInputElement>("[data-testid=flow-form-purpose]")?.placeholder).toBe("Reviews diffs")
    // The rows say which fields are required; nothing else is added.
    expect([...host.querySelectorAll("[data-field]")].map((row) => [row.getAttribute("data-field"), row.getAttribute("data-required")])).toEqual([
      ["id", "true"],
      ["harness", "true"],
      ["model", "true"],
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
    blur(host, "flow-form-id", "reviewer")
    const harness = host.querySelector<HTMLSelectElement>("[data-testid=flow-form-harness]")
    if (harness === null) throw new Error("no harness select")
    harness.value = "codex"
    harness.dispatchEvent(new Event("change", { bubbles: true }))
    blur(host, "flow-form-model", "gpt-5.6-terra")
    blur(host, "flow-form-seq", "3")
    const follow = host.querySelector<HTMLInputElement>("[data-testid=flow-form-follow]")
    if (follow === null) throw new Error("no checkbox")
    follow.click()
    blur(host, "flow-form-purpose", "")
    // A field left as the draft holds it commits nothing.
    blur(host, "flow-form-purpose", "old")
    host.querySelector<HTMLButtonElement>("[data-testid=flow-form-cancel]")?.click()
    expect(calls).toEqual([
      ["form.set", "form-agent.create id reviewer"],
      ["form.set", "form-agent.create harness codex"],
      ["form.set", "form-agent.create model gpt-5.6-terra"],
      ["form.set", "form-agent.create seq 3"],
      ["form.set", "form-agent.create follow true"],
      ["form.set", "form-agent.create purpose"],
      ["card.dismiss", "form-agent.create"]
    ])
    expect(host.querySelector("[data-testid=flow-form-cancel]")?.getAttribute("data-flow")).toBe("card.dismiss")
  })

  test("Submit is form.submit, disabled until every required field is filled; a boolean never blocks it", () => {
    const { calls, onRunCommand } = recorder()
    const empty = mount(<FlowFormCardBody card={formCard()} onRunCommand={onRunCommand} />)
    const disabled = empty.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")
    expect(disabled?.disabled).toBe(true)
    expect(disabled?.getAttribute("data-flow")).toBe("form.submit")
    const filled = mount(
      <FlowFormCardBody card={formCard({ draft: { id: "reviewer", harness: "codex", model: "gpt-5.6-terra" } })} onRunCommand={onRunCommand} />
    )
    const submit = filled.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")
    expect(submit?.disabled).toBe(false)
    expect(submit?.textContent).toBe("Submit")
    submit?.click()
    expect(calls).toEqual([["form.submit", "form-agent.create"]])
  })

  test("a submitted card keeps its record with the controls disabled and no acts; a refused submit shows the reason and stays editable", () => {
    const acted = mount(
      <FlowFormCardBody card={formCard({ draft: { id: "reviewer", harness: "codex", model: "gpt-5.6-terra" } }, "acted")} onRunCommand={() => {}} />
    )
    expect(acted.querySelector("[data-testid=flow-form-submit]")).toBeNull()
    expect(acted.querySelector("[data-testid=flow-form-cancel]")).toBeNull()
    expect(acted.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.disabled).toBe(true)
    expect(acted.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.value).toBe("reviewer")
    const refused = mount(
      <FlowFormCardBody
        card={formCard({ draft: { id: "ui", harness: "codex", model: "gpt-5.6-terra" }, error: "An agent named ui already exists — agent.edit ui changes it." }, "error")}
        onRunCommand={() => {}}
      />
    )
    expect(refused.querySelector("[role=alert]")?.textContent).toBe("An agent named ui already exists — agent.edit ui changes it.")
    expect(refused.querySelector<HTMLInputElement>("[data-testid=flow-form-id]")?.disabled).toBe(false)
    expect(refused.querySelector<HTMLButtonElement>("[data-testid=flow-form-submit]")?.disabled).toBe(false)
  })
})
