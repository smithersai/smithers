import { expect, test } from "vitest"
import { probe } from "./Probe.ts"

test("readiness refuses remote plaintext before calling a process", () => {
  expect(probe("postgresql://private-user:private-pass@database.invalid/private-db", {})).toEqual({
    code: 1, message: "BLOCKED: DATABASE_URL for database.invalid requires sslmode=verify-full or sslmode=require with a pinned CA",
  })
})

test("readiness names only the unreachable loopback host", () => {
  expect(probe("postgresql://private-user:private-pass@127.0.0.1:1/private-db?connect_timeout=1", { PATH: process.env.PATH })).toEqual({
    code: 1, message: "BLOCKED: no PostgreSQL at 127.0.0.1 (database tests must run, not skip)",
  })
})
