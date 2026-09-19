import { expect, test } from "bun:test"
import { DurableStorageConflictError } from "../chain/DurableCollection"
import { browserWriteFault, browserWriteFaultClass, browserWriteRefusal } from "./BrowserWriteFailure"
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
