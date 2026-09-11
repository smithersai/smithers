/*
 * The palette's hot path (Search and Command Palette Spec 2026-09-07 §2, §5).
 *
 * `controller.searchPalette(draft)` is what the composer calls on EVERY
 * keystroke while the overlay is open. Deriving an item's actions walks the
 * registry and derives a form per namespace flow, so doing it per indexed
 * fact made a thousand-file repository cost tens of thousands of form
 * derivations per character. The seam ranks facts and derives actions only
 * for the rows it shows (PALETTE_GROUP_CAP per group) or answers (`limit`).
 *
 * These tests pin that as a CALL COUNT of actionsFor against a 500-file
 * fixture, not a description: attaching actions before ranking fails here
 * immediately with hundreds of calls per keystroke.
 */
import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import * as SearchQuery from "../../flows/SearchQuery"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { PALETTE_GROUP_CAP, SEARCH_DEFAULT_LIMIT } from "./SearchSeam"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const FILE_COUNT = 500

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A signed-in app whose files seam has listed 500 files under src/, every one matching `src/f`. */
const ready = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    fetchImpl: async () => new Response(JSON.stringify({ status: "error", message: "no backend" }), { status: 404 })
  })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: "files-many",
      kind: "file-list",
      title: "files",
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: {
        repo: "smithers",
        localRepoId: "r1",
        path: "src",
        entries: Array.from({ length: FILE_COUNT }, (_, index) => ({ name: `file-${String(index).padStart(3, "0")}.ts`, kind: "file" as const }))
      }
    }
  })
  await settled()
  return { store, controller }
}

const derivations: Array<ReturnType<typeof spyOn>> = []

afterEach(() => {
  while (derivations.length > 0) derivations.pop()?.mockRestore()
})

const countActions = () => {
  const spy = spyOn(SearchQuery, "actionsFor")
  derivations.push(spy)
  return () => spy.mock.calls.length
}

describe("the palette hot path: actions are derived for shown rows only", () => {
  test("a run of keystrokes over 500 files derives actions for the capped rows of each answer, never per file", async () => {
    const { controller } = await ready()
    const calls = countActions()
    let shown = 0
    // Every draft reads in the path mode (a `/` in the query), so the answer is one Files group.
    for (const draft of ["src/", "src/f", "src/fi", "src/fil", "src/file"]) {
      const answer = controller.searchPalette(draft)
      expect(answer.parsed.mode).toBe("path")
      const rows = answer.groups.flatMap((group) => group.items)
      // The fixture is large enough that the cap, not the index, bounds the rows.
      expect(rows.length).toBe(PALETTE_GROUP_CAP)
      expect(rows.every((row) => row.item.kind === "file" && row.item.actions.length > 0)).toBe(true)
      shown += rows.length
    }
    expect(calls()).toBe(shown)
    expect(calls()).toBeLessThan(FILE_COUNT)
  })

  test("the flow door derives actions for the rows it answers (the default limit), not for the whole index", async () => {
    const { store, controller } = await ready()
    const calls = countActions()
    const outcome = await controller.commands.run("search.files", "src/f")
    expect(outcome.status).toBe("executed")
    const card = store.collections.cards.get("search-search.files")
    if (card?.kind !== "search-results") throw new Error("expected the search-results card")
    expect(card.payload.items.length).toBe(SEARCH_DEFAULT_LIMIT)
    expect(card.payload.items.every((item) => item.actions.some((action) => action.flow === "files.read"))).toBe(true)
    expect(calls()).toBe(SEARCH_DEFAULT_LIMIT)
    expect(calls()).toBeLessThan(FILE_COUNT)
  })
})
