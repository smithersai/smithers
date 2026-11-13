/**
 * `errorCode` never throws while classifying a failure, even for a value
 * whose own `code` property cannot be read yet.
 *
 * A module namespace is the one ordinary, non-Proxy object whose own property
 * lookup throws: a binding still in its temporal dead zone raises a
 * ReferenceError. A module that hands its namespace out and then suspends on
 * top-level await leaves `code` uninitialized for as long as it waits. The
 * modules live under `node_modules` so Vitest loads them natively, with real
 * namespace semantics.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, expect, it } from "vitest"
import { errorCode } from "../src/internal/Fs.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

interface Hand {
  readonly held: object | undefined
  readonly release: () => void
}

it("reads no code from a namespace whose code binding is not initialized yet", async () => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-fs-tdz-"))
  roots.push(root)
  const directory = NodePath.join(root, "node_modules", "late-code")
  await Fs.mkdir(directory, { recursive: true })
  await Fs.writeFile(
    NodePath.join(directory, "hand.mjs"),
    [
      "export let held",
      "export let release",
      "export const gate = new Promise((resolve) => { release = resolve })",
      "export function hand(namespace) { held = namespace }",
      ""
    ].join("\n")
  )
  await Fs.writeFile(
    NodePath.join(directory, "late.mjs"),
    [
      "import { gate, hand } from \"./hand.mjs\"",
      "import * as self from \"./late.mjs\"",
      "hand(self)",
      "await gate",
      "export let code = \"EIO\"",
      ""
    ].join("\n")
  )
  const url = (name: string) => pathToFileURL(NodePath.join(directory, name)).href
  const hand: Hand = await import(/* @vite-ignore */ url("hand.mjs"))
  const pending = import(/* @vite-ignore */ url("late.mjs"))
  for (let attempt = 0; attempt < 200 && hand.held === undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const namespace = hand.held!
  expect(Object.prototype.toString.call(namespace)).toBe("[object Module]")
  expect(() => Object.getOwnPropertyDescriptor(namespace, "code")).toThrow(ReferenceError)
  expect(errorCode(namespace)).toBeUndefined()
  hand.release()
  await pending
  // Once the binding is initialized the same namespace reads normally.
  expect(errorCode(namespace)).toBe("EIO")
})
