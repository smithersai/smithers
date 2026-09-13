import { expect, it } from "@effect/vitest"
import { fileURLToPath } from "node:url"
import { runCachedModelTest } from "../src/testing.ts"
import { collectedCards, resetCollectedCards } from "../template/default/tools/ui.ts"

it("the shipped default chat fixture replays and renders its pane without a provider", async () => {
  resetCollectedCards()
  await runCachedModelTest<{ message: string }, { answer: string; cards: ReadonlyArray<string> }>("default template", {
    fixture: new URL("../template/default/flows/chat/fixtures/answer.json", import.meta.url),
    root: fileURLToPath(new URL("../template/default", import.meta.url)),
    flow: "chat",
    payload: { message: "What does durable execution buy me?" },
    expect: (output) => {
      expect(output.answer.trim().length).toBeGreaterThan(0)
      expect(output.cards.length).toBeGreaterThan(0)
      expect(collectedCards.some((card) => card.kind === "pane")).toBe(true)
    }
  })
})
