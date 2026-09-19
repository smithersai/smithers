import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { initialSetup, type RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { StorageApi } from "@tanstack/db"
import { RepositorySetupCard } from "../cards/RepositorySetupCard"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { recordingAgent, unavailableRepositories, waitFor } from "./TestFixtures"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const id = "setup:maintainer:example%2Frepo:issues"
const fixModeOf = (payload: RepositorySetup) => payload.draft.steps.find(step => step.id === "fix")?.mode
const STORAGE_FULL =
  "This browser has no room left for Smithers' saved data, so that change was not saved. Free space for this site in your browser settings, then make the change again."

/*
 * This browser's saved data, with one way to make a SINGLE commit fail the way
 * a browser makes one fail: a quota rejection the commit after it survives.
 * That is the shape the walk recorded — the run-mode pick reached nothing while
 * the two edits made seconds later reached revision 16 — so a whole-store
 * outage is the wrong model for this defect. A commit writes the staged
 * envelope first, so counting staged writes counts commits.
 */
const flakyStorage = (): StorageApi & { refuseCommit: (skip: number) => void; refuseCommitNaming: (marker: string) => void } => {
  const data = new Map<string, string>()
  let countdown: number | undefined
  let marker: string | undefined
  const refuse = (): never => {
    throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
  }
  return {
    refuseCommit: (skip) => { countdown = skip },
    /** Refuse the one commit whose envelope carries this text, whenever it comes. */
    refuseCommitNaming: (text) => { marker = text },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (key.endsWith(".staged")) {
        if (marker !== undefined && value.includes(marker)) { marker = undefined; refuse() }
        if (countdown === 0) { countdown = undefined; refuse() }
        if (countdown !== undefined) countdown -= 1
      }
      data.set(key, value)
    },
    removeItem: (key) => void data.delete(key)
  }
}

/*
 * The whole composed path, as the production walk drove it: a real store on the
 * real transactional storage host, the real controller and command registry,
 * and the real card mounted as a live projection of the store. A pick is made
 * by firing the select's own change event, so it travels card `onRunCommand` →
 * `AppController.runCommand` → registry → `configureRepositorySetup` →
 * `upsert` → the persisted payload, with nothing doubled in between.
 */
async function walk() {
  const storage = flakyStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: { ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1234 }
  } }).isPersisted.promise
  const controller = createAppController(store, unavailableRepositories, recordingAgent([]), {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input) => String(input).includes("/repository-setup/state?")
      ? Response.json({ owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" } })
      : Response.json({}, { status: 404 })
  })
  await waitFor(() => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" && card.payload.recovery?.state === "completed" })

  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => {
    const card = store.collections.cards.get(id)!
    flushSync(() => root.render(<RepositorySetupCard card={card as never} onRunCommand={(name, args) => { controller.runCommand(name, args) }} />))
  }
  render()
  const subscription = store.collections.cards.subscribeChanges(() => render())
  const select = () => {
    const label = [...host.querySelectorAll("label")].find(node => node.textContent?.includes("When to run Fix for real"))!
    return label.querySelector("select")!
  }
  const pick = (mode: string) => {
    const node = select()
    node.value = mode
    node.dispatchEvent(new Event("change", { bubbles: true }))
  }
  const setup = () => (store.collections.cards.get(id) as { payload: RepositorySetup }).payload
  const transcript = () => [...store.collections.messages.values()].map(message => (message as { text?: string }).text ?? "")
  const toastDetails = () => [...store.collections.toasts.values()].map(toast => (toast as { detail?: string }).detail ?? "")
  const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms))
  /** Refuse the commit that saves the edited card; the command's own intent record commits first. */
  const refuseCardWrite = () => { storage.refuseCommit(1) }
  /** Refuse the commit that records the command itself, before the door ever runs. */
  const refuseCommandWrite = () => { storage.refuseCommit(0) }
  /** Refuse the commit that records a pressed setup operation, wherever it lands. */
  const refuseOperationWrite = (operation: string) => { storage.refuseCommitNaming(JSON.stringify(`"operation":"${operation}"`).slice(1, -1)) }
  const close = async () => {
    subscription.unsubscribe(); flushSync(() => root.unmount()); host.remove()
    await Promise.resolve(controller.dispose()).catch(() => {})
    await Promise.resolve(store.dispose?.()).catch(() => {})
  }
  return { store, controller, pick, select, setup, transcript, toastDetails, settle, refuseCardWrite, refuseCommandWrite, refuseOperationWrite, close }
}

/*
 * The accepted half, through the door the person actually used: the walk's own
 * dispatch (`step.fix.mode` → `automatic`) is what this select fires, and the
 * draft it reaches is the one `Create test issue` submits.
 */
test("a run-mode pick made on the card reaches the durable draft", async () => {
  const t = await walk()
  try {
    const before = t.setup().revision
    expect(fixModeOf(t.setup())).toBe("manual")
    t.pick("automatic")
    await t.settle()
    expect(fixModeOf(t.setup())).toBe("automatic")
    expect(t.setup().revision).toBe(before + 1)
    expect(t.select().value).toBe("automatic")
    expect(t.transcript()).toEqual([])
  } finally { await t.close() }
})

/*
 * Walk run 3, B3-N5. `When to run Fix for real` was set to `Automatic`, the
 * select went back to `Manual`, the durable draft stayed at `fix: manual`
 * (`B3-16-state-trial-terminal.json` at revision 16 is byte-equal to the
 * revision 14 draft), and NOTHING was appended to the transcript. The door
 * never refused — `applySetupEdit` accepts a mode three other steps already
 * hold — the WRITE failed, and a failed write left this door as a rejected
 * promise the flow harness relabelled `/setup.configure failed`: one toast,
 * four seconds, an internal id, and silence where the person was looking.
 */
test("a run-mode pick this browser did not save is named in the transcript, not only on a toast", async () => {
  const t = await walk()
  try {
    const before = t.setup().revision
    t.refuseCardWrite()
    t.pick("automatic")
    await t.settle()
    // The pick is still lost. That is honest; saying nothing about it was not.
    expect(fixModeOf(t.setup())).toBe("manual")
    expect(t.setup().revision).toBe(before)
    expect(t.select().value).toBe("manual")
    expect(t.transcript()).toEqual([STORAGE_FULL])
    expect(t.toastDetails()).toEqual([STORAGE_FULL])
    // Not an internal id, not a storage boundary key, not a raw decode message.
    expect(t.transcript()[0]).not.toContain("setup.configure")
    expect(t.transcript()[0]).not.toContain(id)
    expect(t.transcript()[0]).not.toContain("quota")
  } finally { await t.close() }
})

/*
 * The adjacent hazard. One card's writes are ordered by a promise chain, and
 * `.then(apply)` made a failed write the verdict of the NEXT edit: press
 * `Inspect repository`, have that write fail, set a run mode, and the mode
 * never ran `apply` at all — it reached nothing and said nothing, one step
 * removed from a cause that was never the person's. Ordering is what the queue
 * owes the card; a verdict is not, and the press owns its own sentence.
 */
test("a run-mode pick made while an earlier write is still failing still reaches the draft", async () => {
  const t = await walk()
  try {
    const before = t.setup().revision
    t.refuseOperationWrite("inspect")
    // Both doors are entered before either settles, which is the only state in
    // which the queue can hand one edit another's verdict. Pressed from the
    // card, that overlap is a race; here it is the precondition under test.
    const pressed = t.controller.runRepositorySetup(id, "inspect")
    const picked = t.controller.configureRepositorySetup(id, "step.fix.mode", "automatic")
    // The press owns its own failure; only the pick's fate is under test here.
    await expect(pressed).rejects.toThrow()
    expect(await picked).toEqual({ value: "Draft updated." })
    await t.settle(400)
    expect(t.setup().request).toBeUndefined()
    expect(fixModeOf(t.setup())).toBe("automatic")
    expect(t.setup().revision).toBe(before + 1)
    expect(t.select().value).toBe("automatic")
  } finally { await t.close() }
})
