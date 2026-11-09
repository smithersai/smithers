import { existsSync, readFileSync } from "node:fs"
import { expect, it } from "vitest"
import * as Index from "../src/index.ts"
import * as Route from "../src/Route.vibe"

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")

/** Host globals a release note may name without the package exporting them. */
const hostGlobals = new Set(["JSON"])

/** Members of a dotted token that are file extensions, not namespace members. */
const fileExtensions = new Set(["json", "md", "mjs", "ts"])

const dottedTokens = [...changelog.matchAll(/`([A-Z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)/g)]
  .map(([, namespace, member]) => ({ namespace: namespace!, member: member! }))
  .filter(({ member }) => !fileExtensions.has(member))

it("the release notes name only namespaces the root barrel exports", () => {
  const exported = new Set(Object.keys(Index))
  const unknown = [...new Set(dottedTokens.map(({ namespace }) => namespace))]
    .filter((namespace) => !exported.has(namespace) && !hostGlobals.has(namespace))
    .sort()

  expect(unknown).toEqual([])
})

it("the release notes name only Route constructors Route exports", () => {
  const exported = new Set(Object.keys(Route))
  const unknown = [
    ...new Set(dottedTokens.filter(({ namespace }) => namespace === "Route").map(({ member }) => member))
  ]
    .filter((member) => !exported.has(member))
    .sort()

  expect(unknown).toEqual([])
})

it("the release notes name only package files that exist", () => {
  const paths = [...changelog.matchAll(/`((?:docs|scripts|src|test)\/[A-Za-z0-9_./-]+|README\.md|PACKAGE\.ts)`/g)]
    .map(([, path]) => path!)
  const missing = [...new Set(paths)]
    .filter((path) => !existsSync(new URL(`../${path}`, import.meta.url)))
    .sort()

  expect(missing).toEqual([])
})
