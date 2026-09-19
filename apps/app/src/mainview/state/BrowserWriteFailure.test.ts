import { expect, test } from "bun:test"
import { DurableStorageConflictError } from "../chain/DurableCollection"
import { browserWriteFault, browserWriteFaultClass, browserWriteRefusal, lostActFault, lostActRefusal, spokenLostAct } from "./BrowserWriteFailure"
import { WriterHeldByAnotherTabError, WriterMovedToAnotherTabError } from "./StorageRecoveryContract"

/*
 * Each arm is decided by a type this app threw or by the quota spelling the
 * browser used — never by the failure's prose, which is the whole reason this
 * table exists: `DurableStorageConflictError` says "Stored state changed at
 * app-cards/s:setup:maintainer:…", which is a storage boundary key in front of
 * a person, and the quota rejections say nothing a reader can act on.
 */
test("every way a durable write fails is classified from a type, not from its words", () => {
  expect(browserWriteFault(new WriterMovedToAnotherTabError())).toBe("writer-moved")
  expect(browserWriteFault(new WriterHeldByAnotherTabError())).toBe("writer-held")
  expect(browserWriteFault(new DurableStorageConflictError("app-cards/s:setup"))).toBe("storage-conflict")
  expect(browserWriteFault(Object.assign(new Error("x"), { name: "QuotaExceededError" }))).toBe("storage-full")
  expect(browserWriteFault(Object.assign(new Error("x"), { name: "NS_ERROR_DOM_QUOTA_REACHED" }))).toBe("storage-full")
  expect(browserWriteFault(Object.assign(new Error("x"), { code: 22 }))).toBe("storage-full")
  expect(browserWriteFault(Object.assign(new Error("x"), { code: 1014 }))).toBe("storage-full")
  expect(browserWriteFault(Error("something else"))).toBe("storage-unavailable")
  expect(browserWriteFault(undefined)).toBe("storage-unavailable")
  expect(browserWriteFault("QuotaExceededError")).toBe("storage-unavailable")
})

/*
 * The two faults nothing the person did could have avoided say so in their own
 * words; the three that a person can clear name the act that clears them. None
 * of them carries the thrown message, a flow id or a storage key.
 */
test("every sentence says what was lost, whose fault it was, and the next act", () => {
  const cases = [
    new WriterMovedToAnotherTabError(), new WriterHeldByAnotherTabError(),
    new DurableStorageConflictError("app-cards/s:setup:maintainer:example%2Frepo:issues"),
    Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" }),
    Error("indexedDB is closed")
  ]
  for (const failure of cases) {
    const sentence = browserWriteRefusal(failure)
    expect(/\bnot saved\b|\bdid not save\b/u.test(sentence)).toBe(true)
    expect(sentence).not.toContain("app-cards")
    expect(sentence).not.toContain("quota")
    expect(sentence).not.toContain("/setup")
    expect(sentence.endsWith(".")).toBe(true)
    if (browserWriteFaultClass(failure) === "infra") expect(sentence).toContain("Not your fault")
  }
  expect(browserWriteFaultClass(new WriterMovedToAnotherTabError())).toBe("user")
  expect(browserWriteFaultClass(new DurableStorageConflictError("app-cards"))).toBe("infra")
  expect(browserWriteFaultClass(Error("indexedDB is closed"))).toBe("infra")
})

/*
 * The same classification, asked one frame further out. At a write the only
 * thing that ran IS the write, so an unrecognized throw is storage. At a door,
 * a handler or the staging step before a write, an unrecognized throw is this
 * app's own bug — and calling that storage hands the person "make it again; if
 * it fails twice, reload the page" for something no retry will ever fix.
 */
test("a throw outside a write defaults to this app's bug, never to this browser's storage", () => {
  expect(lostActFault(new TypeError("the form card is not ready"))).toBe("app-bug")
  expect(lostActFault(Error("indexedDB is closed"))).toBe("app-bug")
  expect(lostActFault(undefined)).toBe("app-bug")
  // The recognized faults are still recognized, wherever they are caught.
  expect(lostActFault(new WriterMovedToAnotherTabError())).toBe("writer-moved")
  expect(lostActFault(new DurableStorageConflictError("app-cards/s:setup"))).toBe("storage-conflict")
  expect(lostActFault(Object.assign(new Error("x"), { code: 22 }))).toBe("storage-full")
  // A stopped act is not a bug and is not a lost write.
  expect(lostActFault(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("cancelled")
})

/*
 * The bug's sentence is the one that must not borrow a storage fault's words:
 * no "free space", no "not saved" claim (a bug can just as easily run after
 * the bytes landed), and nothing about the throw that produced it.
 */
test("the bug's sentence names the bug and asks for nothing the person could have done", () => {
  const sentence = lostActRefusal(new TypeError("the card projection is not ready"))
  expect(sentence).toContain("bug of its own")
  expect(sentence).toContain("Not your fault")
  expect(sentence).not.toContain("This browser")
  expect(sentence).not.toContain("not saved")
  expect(sentence).not.toContain("projection")
  expect(sentence.endsWith(".")).toBe(true)
})

/*
 * A surface handed one of these sentences knows it is owed to the person where
 * they are still looking, without every door in between carrying a flag. A
 * stopped act is the one arm that stays quiet: the person stopped it.
 */
test("this app's own lost-act sentences are the ones that are never silent", () => {
  expect(spokenLostAct(lostActRefusal(Object.assign(new Error("x"), { code: 22 })))).toBe(true)
  expect(spokenLostAct(lostActRefusal(new TypeError("bug")))).toBe(true)
  expect(spokenLostAct(lostActRefusal(Object.assign(new Error("x"), { name: "AbortError" })))).toBe(false)
  expect(spokenLostAct("Open the setup first.")).toBe(false)
  expect(spokenLostAct("")).toBe(false)
})
