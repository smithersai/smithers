/**
 * The two shipped template manifests, checked against the workspace they are
 * cut from.
 *
 * A template's `@smthrs/*` specifier is a literal version string, not a
 * `workspace:*` range, because a scaffolded app is not a workspace member.
 * Nothing but this test holds those literal versions in step with the release.
 */
import { describe, expect, it } from "@effect/vitest"
import { Fixture } from "@smthrs/testing/Fixture"
import * as Schema from "effect/Schema"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const templateRoot = join(packageRoot, "template")

/**
 * Every workspace package's manifest, keyed by its npm name.
 *
 * Keyed by name rather than reached at `packages/<name after the scope>`,
 * because a package's directory is not its identity: packages nest, so
 * `@smthrs/flow` lives at `packages/smithers/flows/flow` and `@smthrs/cli` at
 * `packages/smithers`. The walk descends and stops at nothing, so a template
 * pin is always compared against the manifest that really publishes it.
 */
const manifestsByName = (): ReadonlyMap<string, Manifest> => {
  const found = new Map<string, Manifest>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist") continue
      const path = join(directory, entry.name)
      const manifestPath = join(path, "package.json")
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest & { readonly name?: string }
        if (typeof manifest.name === "string" && !found.has(manifest.name)) found.set(manifest.name, manifest)
      }
      walk(path)
    }
  }
  walk(join(workspaceRoot, "packages"))
  return found
}

interface Manifest {
  readonly version?: string
  readonly private?: boolean
  readonly overrides?: Record<string, string>
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly pnpm?: { readonly overrides?: Record<string, string> }
}

const read = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest

const workspaceManifests = manifestsByName()

const templates = readdirSync(templateRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const smthrsSpecifiers = (manifest: Manifest): ReadonlyArray<readonly [string, string]> =>
  [...Object.entries(manifest.dependencies ?? {}), ...Object.entries(manifest.devDependencies ?? {})]
    .filter(([name]) => name.startsWith("@smthrs/"))
    .sort(([a], [b]) => a.localeCompare(b))

const publishedTemplates = new Set(["default"])

const allSpecifiers = (manifest: Manifest): Readonly<Record<string, string>> => ({
  ...manifest.dependencies,
  ...manifest.devDependencies
})

/**
 * The Effect host adapters that reach the shared adapter through a caret range.
 *
 * Each of these depends on `@effect/platform-node-shared` at `^<its own
 * version>`, so a resolver may select the next shared RC, whose `effect` peer
 * is that next RC and conflicts with the exact `effect` a template pins.
 */
const shared = "@effect/platform-node-shared"
const adaptersNeedingShared = ["@effect/platform-node", "@effect/platform-bun"]

describe.each(templates)("template/%s", (template) => {
  const manifest = read(join(templateRoot, template, "package.json"))
  const specifiers = smthrsSpecifiers(manifest)

  it("depends on at least one workspace package", () => {
    expect(specifiers.length).toBeGreaterThan(0)
  })

  it("requires no package-manager overrides", () => {
    expect(manifest.overrides).toBeUndefined()
    expect(manifest.pnpm?.overrides).toBeUndefined()
  })

  it.each(specifiers)("pins %s at the installable release line", (name, specifier) => {
    const workspace = workspaceManifests.get(name)
    expect(workspace, `${name} is not a package in this workspace`).toBeDefined()
    // The first CLI release has no `latest` tag. A generated application must
    // follow `next` until 1.0 is final instead of baking one release candidate
    // into every future scaffold.
    const expected = name === "@smthrs/cli" ? "next" : workspace?.version
    expect(
      specifier,
      `template/${template} pins ${name} at ${specifier}; the installable release is ${String(expected)}`
    ).toBe(expected)
  })

  it("has no private dependency when included in the npm package", () => {
    const privateNames = specifiers
      .map(([name]) => name)
      .filter((name) => workspaceManifests.get(name)?.private === true)
    if (publishedTemplates.has(template)) expect(privateNames).toEqual([])
    else expect(privateNames).toEqual(["@smthrs/ui"])
  })

  // The workspace pins the shared adapter in its root `overrides`, and a
  // scaffolded app is not a workspace member, so it inherits nothing: naming
  // the adapter without naming what it floats to is what made
  // `npm install --strict-peer-deps` and `pnpm install --strict-peer-dependencies`
  // exit 1 on a generated app. A direct pin rather than an `overrides` entry,
  // because the cell above forbids overrides and because pnpm reads
  // `pnpm.overrides` and would ignore npm's field anyway. The real install is
  // `scripts/check-template-peers.test.mjs`; this cell is what makes the
  // omission fail before anything reaches a registry.
  it("names the shared adapter alongside every Effect host adapter it pins", () => {
    const pins = allSpecifiers(manifest)
    const adapters = adaptersNeedingShared.filter((name) => pins[name] !== undefined)
    if (adapters.length === 0) {
      expect(pins[shared], `template/${template} pins ${shared} with no adapter that needs it`).toBeUndefined()
      return
    }
    for (const adapter of adapters) {
      expect(
        pins[shared],
        `template/${template} pins ${adapter}, which floats ${shared}; pin ${shared} at the same version`
      ).toBe(pins[adapter])
    }
  })
})

/**
 * Every fixture a template ships, decoded with the schema the replay path uses.
 *
 * A template's own suite runs against the scaffolded copy's `node_modules` and
 * never runs here, so a fixture that stopped decoding would otherwise only
 * surface in a scaffolded app. Decoding is the part of that suite this package
 * can own.
 */
describe("template fixtures", () => {
  const decode = Schema.decodeUnknownSync(Fixture)

  const fixtures = templates.flatMap((template) => {
    const flowsDir = join(templateRoot, template, "flows")
    let flows: ReadonlyArray<string> = []
    try {
      flows = readdirSync(flowsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) =>
        entry.name
      )
    } catch {
      return []
    }
    return flows.flatMap((flow) => {
      const dir = join(flowsDir, flow, "fixtures")
      let names: ReadonlyArray<string> = []
      try {
        names = readdirSync(dir).filter((name) => name.endsWith(".json"))
      } catch {
        return []
      }
      return names.map((name) => [`${template}/flows/${flow}/fixtures/${name}`, join(dir, name)] as const)
    })
  })

  it("ships at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  it.each(fixtures)("decodes %s", (_label, path) => {
    const decoded = decode(JSON.parse(readFileSync(path, "utf8")))
    expect(decoded.calls.length).toBeGreaterThan(0)
  })
})
