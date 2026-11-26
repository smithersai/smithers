import { WebCrypto } from "@smthrs/crypto"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { operationWriteId } from "./writeIdentity.vibe"

test.each([
  ["publish", "run-1", "e7d48cc1-1267-543c-a11d-5219335f7612"],
  ["update", "run-1", "36a4c788-bee4-58d5-8b1a-84efd16c0ab0"],
  ["publish", "run-2", "d5296179-c277-5477-bbb0-5b076f3f319c"],
] as const)("derives the stable %s receipt from execution %s", async (operation, executionId, expected) => {
  const writeId = operationWriteId(operation, executionId).pipe(Effect.provide(WebCrypto.layer))
  expect(await Effect.runPromise(writeId)).toBe(expected)
  expect(await Effect.runPromise(writeId)).toBe(expected)
})
