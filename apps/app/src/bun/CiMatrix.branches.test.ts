/*
 * The CI matrix preview's two answers (docs/LOCAL-APP.md "Cards: target
 * graph"). When a repository declares a CiGen target the backend renders it
 * in a scratch clone and reads the workflows the GRAPH implies; when it does
 * not — or when no Node sidecar exists to run the loader — it falls back to
 * the workflows already on disk. Both must be honest about which they are,
 * because "scratch-render" and "on-disk" mean different things to a human
 * asking what CI will do with their change.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { renderCiMatrix } from "./CiMatrix"
import { currentSandboxHost, sandboxEnforced } from "./Sandbox"

test.skipIf(!sandboxEnforced(currentSandboxHost()))("a CI preview cannot write back into the original repository through an absolute path", async () => {
  // Keep the original outside the system scratch directory, which the loader may write.
  const original = await mkdtemp(join(process.cwd(), ".ci-preview-confinement-"))
  try {
    const proof = join(original, "escaped")
    const cli = join(original, "cli.mjs")
    await writeFile(cli, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(proof)}, 'escaped')`)
    const result = await renderCiMatrix({ repoId: "read-only", repo: original, labels: ["//:ci"], declarationFiles: [], cli,
      node: { path: process.execPath, version: "v22.19.0" } })
    expect(await Bun.file(proof).exists()).toBe(false)
    expect(result.warnings?.length).toBeGreaterThan(0)
  } finally {
    await rm(original, { recursive: true, force: true })
  }
})

let repo = ""
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "smithers-ci-"))
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const workflow = async (name: string, yaml: string): Promise<void> => {
  await mkdir(join(repo, ".github", "workflows"), { recursive: true })
  await writeFile(join(repo, ".github", "workflows", name), yaml)
}

const CI_YAML = `name: ci
on: [push]
jobs:
  test:
    name: workspace graph
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3]
        os:
          - ubuntu-latest
          - macos-latest
    steps:
      - run: pnpm exec smithers-build test '//packages/...'
      - run: pnpm exec smithers-build ci '//apps/app:check'
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm exec smithers-build lint '//src:lint'
`

test("with no Node sidecar the preview reads the workflows already on disk", async () => {
  await workflow("ci.yml", CI_YAML)
  /*
   * No loader can run, so nothing is rendered. The card still has something
   * true to show — and it is labelled `on-disk`, not passed off as the graph's
   * own output.
   */
  const result = await renderCiMatrix({ repoId: "force", repo, labels: ["//.github:github"], node: null, declarationFiles: [] })
  expect(result.workflows.map((entry) => entry.source)).toEqual(["on-disk"])
  expect(result.warnings ?? []).toEqual([])
  expect(result.durationMs).toBeGreaterThanOrEqual(0)

  const ci = result.workflows[0]!
  expect(ci.name).toBe("ci")
  expect(ci.path).toBe(".github/workflows/ci.yml")
  expect(ci.jobs.map((job) => job.name)).toEqual(["workspace graph", "lint"])
  /* Inline and block matrix axes both fan out. */
  expect(ci.jobs[0]?.matrix).toEqual({ shard: ["1", "2", "3"], os: ["ubuntu-latest", "macos-latest"] })
  /* Every target a job invokes, quoted or not, de-duplicated. */
  expect(ci.jobs[0]?.targets).toEqual(["//packages/...", "//apps/app:check"])
  expect(ci.jobs[1]?.targets).toEqual(["//src:lint"])
  expect(ci.jobs[1]?.matrix).toBeUndefined()
})

test("a repository that declares no CiGen target falls back to disk too", async () => {
  await workflow("release.yaml", "name: release\njobs:\n  publish:\n    steps:\n      - run: echo hi\n")
  const result = await renderCiMatrix({
    repoId: "force", repo, labels: [], declarationFiles: ["PACKAGE.ts"],
    node: { path: process.execPath, version: "v22.19.0" }
  })
  expect(result.workflows.map((entry) => entry.source)).toEqual(["on-disk"])
  /* A `.yaml` extension counts, and a job with no smithers-build step has no targets. */
  expect(result.workflows[0]?.name).toBe("release")
  expect(result.workflows[0]?.jobs).toEqual([{ name: "publish", targets: [] }])
})

test("a repository with no workflows directory answers an empty preview", async () => {
  const result = await renderCiMatrix({ repoId: "force", repo, labels: [], node: null, declarationFiles: [] })
  expect(result).toMatchObject({ repoId: "force", workflows: [], warnings: [] })
})

test("a CiGen label whose scratch render fails warns and shows what is on disk", async () => {
  await workflow("ci.yml", "name: ci\njobs:\n  test:\n    steps:\n      - run: pnpm exec smithers-build test '//src:lint'\n")
  await writeFile(join(repo, "PACKAGE.ts"), "export const x = 1\n")
  const cli = join(repo, "broken-cli.mjs")
  await writeFile(cli, "process.stderr.write('the loader could not resolve //\\u002F.github:github\\n')\nprocess.exit(1)\n")
  const result = await renderCiMatrix({
    repoId: "force", repo, labels: ["//.github:github"], declarationFiles: ["PACKAGE.ts"], cli,
    node: { path: process.execPath, version: "v22.19.0" }
  })
  /* A failed render is reported, never swallowed into a green preview. */
  expect(result.warnings ?? []).toHaveLength(1)
  expect((result.warnings ?? [])[0]).toContain("//.github:github scratch render exited 1")
  expect((result.warnings ?? [])[0]).toContain("could not resolve")
  /* The scratch produced nothing, so the on-disk workflows are what is shown. */
  expect(result.workflows.map((entry) => entry.source)).toEqual(["on-disk"])
})

test("the scratch clone follows a declaration's relative imports, including .js to .ts", async () => {
  /*
   * A PACKAGE.ts that imports a sibling renders nothing in the scratch unless
   * the sibling is copied too — the loader fails on a missing module and the
   * preview silently degrades to whatever happened to be on disk.
   */
  await mkdir(join(repo, "ci"), { recursive: true })
  await writeFile(join(repo, "PACKAGE.ts"), "import { shard } from './ci/shards.js'\nexport { shard }\n")
  await writeFile(join(repo, "ci", "shards.ts"), "import './nested.ts'\nexport const shard = 3\n")
  await writeFile(join(repo, "ci", "nested.ts"), "export const nested = true\n")
  await writeFile(join(repo, "WORKSPACE.ts"), "export const workspace = 1\n")

  /* The stand-in loader writes the workflow it was asked for, and lists what it saw. */
  const cli = join(repo, "render-cli.mjs")
  await writeFile(
    cli,
    `import { mkdirSync, writeFileSync, existsSync } from "node:fs"
mkdirSync(".github/workflows", { recursive: true })
const seen = ["PACKAGE.ts", "ci/shards.ts", "ci/nested.ts", "WORKSPACE.ts"].filter((file) => existsSync(file))
writeFileSync(".github/workflows/generated.yml", \`name: generated\\njobs:\\n  build:\\n    steps:\\n      - run: pnpm exec smithers-build build '//src:build'\\n      - run: echo \${seen.join(",")}\\n\`)
`
  )
  const result = await renderCiMatrix({
    repoId: "force", repo, labels: ["//.github:github"], declarationFiles: ["PACKAGE.ts"], cli,
    node: { path: process.execPath, version: "v22.19.0" }
  })
  expect(result.warnings ?? []).toEqual([])
  expect(result.workflows.map((entry) => entry.source)).toEqual(["scratch-render"])
  const generated = result.workflows[0]!
  expect(generated.name).toBe("generated")
  expect(generated.jobs[0]?.targets).toEqual(["//src:build"])
  /* The whole transitive import closure reached the scratch, `.js` specifier and all. */
  expect(generated.yaml).toContain("PACKAGE.ts,ci/shards.ts,ci/nested.ts,WORKSPACE.ts")
})

test("an import that escapes the repository is not copied into the scratch", async () => {
  /*
   * The repository and its neighbour are siblings under one fixture parent, so
   * `../<neighbour>/secret.ts` names a file that really exists. Without the
   * containment check the copy loop follows it to
   * `join(scratch, "../<neighbour>/secret.ts")`: beside the scratch, in the
   * system temporary directory the scratch itself was made in.
   */
  const parent = await mkdtemp(join(tmpdir(), "smithers-ci-escape-"))
  const neighbour = `neighbour-${basename(parent)}`
  const contained = join(parent, "repo")
  const secret = join(parent, neighbour, "secret.ts")
  /* Where a followed `../` import lands, because `scratch` is a direct child of `tmpdir()`. */
  const escapee = join(tmpdir(), neighbour, "secret.ts")
  try {
    await mkdir(join(parent, neighbour), { recursive: true })
    await mkdir(contained, { recursive: true })
    await writeFile(secret, "export const secret = 'do not copy me'\n")
    /* The absolute specifier is inert: the scanner only follows `./` and `../`. */
    await writeFile(
      join(contained, "PACKAGE.ts"),
      `import '${secret}'\nimport '../${neighbour}/secret.ts'\nexport const x = 1\n`
    )
    const cli = join(contained, "list-cli.mjs")
    await writeFile(
      cli,
      `import { mkdirSync, writeFileSync, existsSync } from "node:fs"
mkdirSync(".github/workflows", { recursive: true })
writeFileSync(".github/workflows/generated.yml", \`name: generated\\njobs:\\n  build:\\n    steps:\\n      - run: echo escaped=\${existsSync("../${neighbour}/secret.ts")}\\n\`)
`
    )
    const result = await renderCiMatrix({
      repoId: "force", repo: contained, labels: ["//.github:github"], declarationFiles: ["PACKAGE.ts"], cli,
      node: { path: process.execPath, version: "v22.19.0" }
    })
    /* A `../` specifier resolves outside the repo and is refused, not followed. */
    expect(existsSync(secret)).toBe(true)
    expect(existsSync(escapee)).toBe(false)
    expect(result.workflows[0]?.yaml).toContain("escaped=false")
  } finally {
    await rm(parent, { recursive: true, force: true })
    await rm(join(tmpdir(), neighbour), { recursive: true, force: true })
  }
})
