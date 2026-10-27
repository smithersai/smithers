import { expect, test } from "vitest"
import { TodoCommands } from "../src/index.ts"

test("slash TODO numbers retain their exact identity or are refused", () => {
  const parse = TodoCommands.parseTodoArgs("answer")
  expect(parse("T9007199254740991 yes")).toEqual({ payload: { n: Number.MAX_SAFE_INTEGER, answer: "yes" } })
  for (const digits of ["9007199254740992", "9007199254740993", "9".repeat(400)]) {
    for (const prefix of ["", "T"]) expect(parse(`${prefix}${digits} yes`)).toEqual({ error: "Invalid TODO input" })
  }
})
