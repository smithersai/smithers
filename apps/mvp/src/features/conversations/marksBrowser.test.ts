// @vitest-environment happy-dom

import { expect, test } from "vitest"
import { DEVICE_ADOPTED_EVENT } from "../auth/contract"
import * as Marks from "./marks"

test("browser storage adapters share the same refusal count and a missing Web Locks API disables durable grants", () => {
  const principal = crypto.randomUUID()
  const key = Marks.keyOf("open", principal, "old")
  const host = () => ({
    storage: {
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => localStorage.setItem(key, value),
      removeItem: (key: string) => localStorage.removeItem(key),
      key: (index: number) => localStorage.key(index),
      get length() {
        return localStorage.length
      },
    },
    principal: () => principal,
    changes: () => () => {},
  })
  const one = Marks.make(host())
  const two = Marks.make(host())
  const stop = one.listen(() => {})
  localStorage.setItem(key, "1")
  try {
    expect(one.granted("old")).toBe(false)
    two.grant("new")
    expect(localStorage.getItem(Marks.keyOf("open", principal, "new"))).toBeNull()
    expect(two.memory()).toBe(0)
    one.advance()
    expect(two.memory()).toBe(1)
  } finally {
    stop()
    localStorage.clear()
  }
})

test("a browser without BroadcastChannel still records its refusal generation", () => {
  // happy-dom has no BroadcastChannel. Remove Node's ambient implementation for this capability check.
  const native = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel")
  Reflect.deleteProperty(globalThis, "BroadcastChannel")
  try {
    const principal = crypto.randomUUID()
    const marks = Marks.make({ storage: localStorage, principal: () => principal, changes: () => () => {} })
    const stop = marks.listen(() => {})
    marks.advance()
    marks.broadcast({ kind: "refuse", id: "conversation" })
    expect(marks.memory()).toBe(1)
    stop()
  } finally {
    Object.defineProperty(globalThis, "BroadcastChannel", native!)
    localStorage.clear()
  }
})


test("the browser window announces adoption and anchors the new principal even without an owners callback", () => {
  let principal = "visitor"
  const marks = Marks.make({ storage: localStorage, principal: () => principal, changes: () => () => {} })
  const stop = marks.listen(() => {})
  try {
    expect(marks.epoch()).toBeNull()
    principal = "ada"
    window.dispatchEvent(new Event(DEVICE_ADOPTED_EVENT))
    expect(marks.epoch()).toMatch(/^[0-9a-f]{16}$/)
    expect(localStorage.getItem(Marks.keyOf("epoch", "visitor"))).toBeNull()
  } finally {
    stop()
    localStorage.clear()
  }
})
