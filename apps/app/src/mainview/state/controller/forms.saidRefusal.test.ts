import { expect, test } from "bun:test"
import { createCommandRegistry } from "../../flows/Commands"
import type { CommandActions } from "../../flows/Flows"
import type { Card, Message } from "../AppState"
import type { ControllerContext } from "./context"
import { createFormsController } from "./forms"

/*
 * Canary W1 item 3a, second half. A consequential door whose refusal has to
 * outlive a four-second toast appends the sentence to the transcript itself
 * and returns it; the form card must not print the same sentence underneath.
 * Which transcript line that is cannot be "the last one": between the door's
 * `message.appended` and the form's patch any other actor may append — and
 * then the tail comparison the first fix used goes false and the duplicate is
 * back. The door marks its own line (`Message.spoken`) and the form reads the
 * mark, within this submission only.
 */
const REFUSAL = 'No schedule "canary-w1-not-registered" is registered on will/flows.'
const AFTERWARDS = "Started a new conversation. Open the archived conversation."

const fixture = (submit: (append: (text: string, spoken?: true) => void) => string) => {
  const cards = new Map<string, Card>()
  const messages = new Map<string, Message>()
  let ordinal = 0
  const append = (text: string, spoken?: true) => {
    ordinal += 1
    const id = `message-${ordinal}`
    messages.set(id, { id, role: "smithers", text, status: "complete", createdAt: ordinal, ordinal, ...(spoken === undefined ? {} : { spoken }) })
  }
  const store = {
    session: () => ({ activeRepoKey: null }),
    collections: { cards, messages, repositories: new Map(), workingCopies: new Map(), harnesses: new Map() },
    dispatch: (event: { type: string; card?: Card }) => {
      if (event.type === "card.upsert") cards.set(event.card!.id, event.card!)
      return { isPersisted: { promise: Promise.resolve() } }
    }
  }
  const actions = {
    repositoryFlows: () => undefined,
    knownRepositories: () => new Set<string>(),
    noteCommandRun: () => {},
    traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false })
  } satisfies Partial<CommandActions>
  const registry = createCommandRegistry(actions as unknown as CommandActions)
  const commands = { ...registry, submit: async () => ({ status: "failed" as const, error: submit(append) }) }
  const context = { store, commands, commandActor: "user" } as unknown as ControllerContext
  return { forms: createFormsController(context, { nextOrdinal: () => 1 }), cards, append }
}

const errorOn = (cards: Map<string, Card>, cardId: string): string | undefined => {
  const card = cards.get(cardId)
  return card?.kind === "flow-form" ? card.payload.error : "no card"
}

const submitted = async (fields: ReturnType<typeof fixture>) => {
  const rendered = fields.forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })!
  await fields.forms.setFormField(rendered.cardId, "url", "https://example.com")
  await fields.forms.submitForm(rendered.cardId)
  return rendered.cardId
}

test("a refusal the door said stays off the form card even when another line lands after it", async () => {
  const fields = fixture(append => {
    append(REFUSAL, true)
    append(AFTERWARDS)
    return REFUSAL
  })
  expect(errorOn(fields.cards, await submitted(fields))).toBeUndefined()
})

test("a refusal no door said is still the card's to state", async () => {
  const fields = fixture(() => REFUSAL)
  expect(errorOn(fields.cards, await submitted(fields))).toBe(REFUSAL)
})

test("a sentence a door said before this submission lands on the card the person is looking at", async () => {
  const fields = fixture(() => REFUSAL)
  fields.append(REFUSAL, true)
  expect(errorOn(fields.cards, await submitted(fields))).toBe(REFUSAL)
})
