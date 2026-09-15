import { expect, test } from "bun:test"
import { tutorialTranscript } from "../onboarding/transcriptScope"
import { createAppStore } from "./AppStore"
import { initialGuide, type Card } from "./AppState"
import { memoryStorage } from "./TestFixtures"

test("explicit slash cards and forms remain visible in the open guide conversation", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "guide.visibility.changed", actor: "system", visible: true }).isPersisted.promise
  await store.dispatch({
    type: "guide.changed",
    actor: "user",
    guide: { ...initialGuide(), step: 2, conversationOpen: true }
  }).isPersisted.promise
  const worldCard: Card = {
    id: "wiki-open-world-home", kind: "world", title: "World", status: "active", createdAt: 1, ordinal: 1,
    payload: { documents: [{ id: "world-home", path: "World.md", title: "World", confidence: 1 }], selectedDocumentId: "world-home" }
  }
  const formCard: Card = {
    id: "form-wiki.open", kind: "flow-form", title: "Open a Wiki note", status: "active", createdAt: 2, ordinal: 2,
    payload: {
      flow: "wiki.open", via: "user", fields: [{ name: "path", label: "Path", kind: "text", required: true }],
      draft: {}, given: {}
    }
  }
  const unrelatedCard: Card = {
    id: "workspace-home", kind: "repo-home", title: "Home", status: "active", createdAt: 3, ordinal: 3,
    payload: { repo: "acme/api", path: ".smithers/home.json", blocks: [], featuredFlows: null }
  }
  await store.dispatch({ type: "card.upsert", actor: "user", card: worldCard }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: formCard }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: unrelatedCard }).isPersisted.promise

  expect(store.session().guide?.transcript?.[worldCard.id]).toMatchObject({ source: "chat", owned: true })
  expect(store.session().guide?.transcript?.[formCard.id]).toMatchObject({ source: "chat", owned: true })
  expect(store.session().guide?.transcript?.[unrelatedCard.id]).toBeUndefined()

  const visible = tutorialTranscript([...store.collections.cards.values()], store.session().guide?.transcript)
  expect(visible.map(card => card.id)).toEqual(expect.arrayContaining([worldCard.id, formCard.id]))
})
