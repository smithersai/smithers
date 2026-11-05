import { Smithers as S } from "@smthrs/targets"
import { describe, expect, it } from "vitest"
import * as Yaml from "yaml"
import * as GithubRender from "../../build-cli/src/GithubRender.ts"
import * as CiToolchain from "../src/CiToolchain.ts"
import { Attrs, render } from "../src/GithubCiGen.ts"
import type * as Target from "../src/Target.ts"
import { packageManager, runtime } from "./toolchain.ts"

const repository = "acme/project"
const secrets = {
  CACHE_URL: "https://cache.example.invalid",
  CACHE_READ: "synthetic-reader",
  CACHE_WRITE: "synthetic-writer"
}
const reader = {
  id: "reader",
  runsOn: "ubuntu-latest",
  toolchain: CiToolchain.Needs({ runtimes: [CiToolchain.Node({ runtime, release: "26.4.0" })] }),
  steps: [{ verb: S.Verb.Ci, pattern: "//packages/..." }]
}
const declaration = {
  packageManager,
  cacheUrlSecret: S.Secret("CACHE_URL"),
  cacheTokenSecret: S.Secret("CACHE_READ"),
  cacheWriteTokenSecret: S.Secret("CACHE_WRITE"),
  cacheWriteRepository: repository,
  cacheWriteEnvironment: "cache-publish",
  pushBranches: ["main", "release"],
  jobs: [reader, { ...reader, id: "publisher", publishesToCache: true }]
}
const attrs = (changes: Record<string, unknown> = {}): Attrs => Attrs.make({ ...declaration, ...changes })

interface Step {
  readonly env?: Record<string, string>
  readonly with?: Record<string, string>
  readonly uses?: string
  readonly if?: string
}
interface Job {
  readonly if?: string
  readonly environment?: string
  readonly env?: Record<string, string>
  readonly steps: ReadonlyArray<Step>
}
interface Workflow {
  readonly env?: Record<string, string>
  readonly jobs: Record<string, Job>
}
interface Event {
  readonly event_name: string
  readonly repository: string
  readonly ref: string
  readonly event: {
    readonly repository: { readonly default_branch: string }
    readonly pull_request: { readonly number: number }
  }
}
const context = (event_name: string, ref: string, repo = repository, branch = "main"): Event => ({
  event_name,
  ref,
  repository: repo,
  event: { repository: { default_branch: branch }, pull_request: { number: 7 } }
})
const cases = [
  { name: "same-repository PR", github: context("pull_request", "refs/pull/7/merge"), writer: false },
  { name: "PR target on default branch", github: context("pull_request_target", "refs/heads/main"), writer: false },
  { name: "manual topic run", github: context("workflow_dispatch", "refs/heads/topic"), writer: false },
  { name: "manual default run", github: context("workflow_dispatch", "refs/heads/main"), writer: false },
  { name: "non-default push admitted by trigger", github: context("push", "refs/heads/release"), writer: false },
  { name: "fork push to its default", github: context("push", "refs/heads/main", "fork/project"), writer: false },
  { name: "same owner, another repository", github: context("push", "refs/heads/main", "acme/other"), writer: false },
  { name: "tag named main", github: context("push", "refs/tags/main"), writer: false },
  { name: "default branch push", github: context("push", "refs/heads/main"), writer: true },
  { name: "repository case alias", github: context("push", "refs/heads/main", "ACME/PROJECT"), writer: true },
  {
    name: "branch case alias requires the exact environment policy",
    github: context("push", "refs/heads/MAIN"),
    writer: true
  },
  {
    name: "renamed default branch push",
    github: context("push", "refs/heads/release", repository, "release"),
    writer: true
  },
  {
    name: "old default after rename",
    github: context("push", "refs/heads/main", repository, "release"),
    writer: false
  },
  { name: "missing default branch", github: context("push", "refs/heads/main", repository, ""), writer: false },
  { name: "scheduled run", github: context("schedule", "refs/heads/main"), writer: false }
]

/**
 * Execute the generated expressions with synthetic contexts and secrets. The
 * renderer's boolean/string subset uses GitHub's case-insensitive string
 * equality and positional format. Environment deployment policies are enforced
 * by GitHub, not this evaluator; branch case aliases demonstrate why those
 * policies remain essential. Evaluate actual YAML, not a copy of the policy.
 */
const evaluate = (expression: string, github: Event, inputs: Record<string, string> = {}): unknown =>
  new Function(
    "github",
    "equal",
    "secrets",
    "inputs",
    "format",
    "hashFiles",
    "runner",
    "cancelled",
    "steps",
    `return (${
      expression
        .replace(/\binputs\.([\w-]+)/g, (_match, key: string) => `inputs[${JSON.stringify(key)}]`)
        .replace(
          /(format\([^()]*\)|[\w.]+|'[^']*')\s*(==|!=)\s*(format\([^()]*\)|[\w.]+|'[^']*')/g,
          (_match, left: string, operator: string, right: string) =>
            `${operator === "!=" ? "!" : ""}equal(${left}, ${right})`
        )
    })`
  )(
    github,
    (left: unknown, right: unknown) =>
      typeof left === "string" && typeof right === "string"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right,
    secrets,
    inputs,
    (template: string, ...values: ReadonlyArray<unknown>) =>
      template.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)])),
    () => "synthetic-lock-digest",
    { os: "Linux" },
    () => false,
    { setup: { conclusion: "success" } }
  )
const expand = (value: string, github: Event, inputs: Record<string, string> = {}): string =>
  value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => String(evaluate(expression, github, inputs)))
const enabled = (job: Job | Step, github: Event): boolean =>
  job.if === undefined || Boolean(evaluate(job.if.replace(/^\$\{\{|\}\}$/g, ""), github))
const values = (
  entries: Record<string, string> | undefined,
  github: Event,
  inputs: Record<string, string> = {}
): Array<string> => Object.values(entries ?? {}).map((value) => expand(value, github, inputs))
const exposed = (workflow: Workflow, github: Event): Array<string> =>
  Object.values(workflow.jobs).filter((job) => enabled(job, github)).flatMap((job) => [
    ...values(workflow.env, github),
    ...values(job.env, github),
    ...job.steps.filter((step) => enabled(step, github)).flatMap((step) => [
      ...values(step.env, github),
      ...values(step.with, github)
    ])
  ])

describe("cache publisher trust boundary", () => {
  it.each(cases)("$name: the generated guard controls writer expressions", ({ github, writer }) => {
    const workflow = Yaml.parse(render(attrs())) as Workflow
    const received = exposed(workflow, github)
    expect(received).toContain(secrets.CACHE_READ)
    expect(received.includes(secrets.CACHE_WRITE)).toBe(writer)
    expect(enabled(workflow.jobs.publisher!, github)).toBe(writer)
    expect(workflow.jobs.publisher!.environment).toBe("cache-publish")
    expect(workflow.jobs.reader!.environment).toBeUndefined()
    expect(values(workflow.env, github)).not.toContain(secrets.CACHE_WRITE)
  })

  it.each([undefined, "", "acme", "acme/project/extra", "acme/project' || true", "${{ github.repository }}"])(
    "refuses missing or expression-bearing publisher repository %s",
    (cacheWriteRepository) => {
      expect(() => render(attrs({ cacheWriteRepository }))).toThrow(/cacheWriteRepository/)
    }
  )

  it("refuses repository authority without a writer", () => {
    expect(() =>
      render(attrs({
        cacheWriteTokenSecret: undefined,
        cacheWriteEnvironment: undefined,
        jobs: [reader]
      }))
    ).toThrow(/cacheWriteRepository/)
  })

  it.each([
    { code: "invalid_repository", changes: { cacheWriteRepository: undefined } },
    {
      code: "repository_without_writer",
      changes: { cacheWriteTokenSecret: undefined, cacheWriteEnvironment: undefined, jobs: [reader] }
    },
    { code: "writer_in_endpoint", changes: { cacheUrlSecret: S.Secret("CACHE_WRITE") } }
  ])("reports a typed authority refusal: $code", ({ code, changes }) => {
    let failure: unknown
    try {
      render(attrs(changes))
    } catch (cause) {
      failure = cause
    }
    expect(failure).toMatchObject({ _tag: "smithers-build/InvalidCachePublisher", code })
  })

  it.each([undefined, "", "${{ github.ref }}"])(
    "requires a literal protected environment: %s",
    (cacheWriteEnvironment) => {
      expect(() => render(attrs({ cacheWriteEnvironment }))).toThrow(/cacheWriteEnvironment/)
    }
  )

  it("keeps reader-only workflows independent of publisher configuration", () => {
    const workflow = Yaml.parse(render(attrs({
      cacheWriteRepository: undefined,
      cacheWriteEnvironment: undefined,
      cacheWriteTokenSecret: undefined,
      jobs: [reader]
    }))) as Workflow
    expect(exposed(workflow, context("pull_request", "refs/pull/7/merge"))).toContain(secrets.CACHE_READ)
  })

  it("permits a publisher with no shared cache entries", () => {
    const workflow = Yaml.parse(render(attrs({ cacheUrlSecret: undefined, cacheTokenSecret: undefined }))) as Workflow
    expect(exposed(workflow, context("push", "refs/heads/main"))).toContain(secrets.CACHE_WRITE)
    expect(exposed(workflow, context("pull_request", "refs/pull/7/merge"))).not.toContain(secrets.CACHE_WRITE)
  })

  it.each(["CACHE_WRITE", "cache_write"])("refuses the same reader/writer secret: %s", (name) => {
    expect(() => render(attrs({ cacheTokenSecret: S.Secret(name) }))).toThrow(/must differ/)
  })

  it.each(["CACHE_WRITE", "cache_write"])("refuses a writer exposed as a shared endpoint: %s", (name) => {
    expect(() => render(attrs({ cacheUrlSecret: S.Secret(name) }))).toThrow(/write credential/)
  })
})

const modernRender = (
  url: string | null = "CACHE_URL",
  token: string | null = "CACHE_READ",
  split = true
): GithubRender.CiRender => {
  const workspace = S.Workspace("fixture", {
    repository: "git+https://github.com/acme/project.git",
    runtime,
    packageManager,
    nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
    cache: S.Cache({
      directory: ".flows",
      remote: S.RemoteCache.make({
        endpoint: secrets.CACHE_URL,
        read: S.Secret("CACHE_READ"),
        ...(split ? { write: S.Secret("CACHE_WRITE") } : {})
      })
    })
  })
  const run = S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["fixture"] })
  const setup = S.Github.Setup({
    ...(url === null ? {} : { cacheUrl: S.Secret(url) }),
    ...(token === null ? {} : { cacheToken: S.Secret(token) })
  })
  const workflow = S.Github.Workflow({
    name: "ci",
    on: { push: { branches: ["main", "release"] }, pullRequest: {}, workflowDispatch: true },
    setup,
    run: [run]
  })
  const ciGen = S.Github.CiGen({ workflows: [workflow], changes: ["workflows/**", "actions/setup/**"] })
  const labels = new Map<Target.AnyTarget, string>([[ciGen, "//.github:ci"], [run, "//:test"], [
    setup,
    "//.github:setup"
  ]])
  return GithubRender.render({
    ciGen,
    workspace,
    packageDir: ".github",
    resolve: { labelOf: (target) => labels.get(target) }
  })
}

describe("repository-local setup keeps documented read-only access", () => {
  it.each(cases)("$name: setup inputs and composite step env receive only the reader", ({ github }) => {
    const rendered = modernRender()
    const workflow = Yaml.parse(rendered.files.find((file) => file.path === "workflows/ci.yml")!.content) as Workflow
    const composite = Yaml.parse(rendered.files.find((file) => file.path === "actions/setup/action.yml")!.content) as {
      readonly runs: { readonly steps: ReadonlyArray<Step> }
    }
    const received = exposed(workflow, github)
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses !== "./.github/actions/setup") continue
        const inputs = Object.fromEntries(
          Object.entries(step.with ?? {}).map(([name, value]) => [name, expand(value, github)])
        )
        for (const inner of composite.runs.steps) {
          received.push(...values(inner.env, github, inputs), ...values(inner.with, github, inputs))
        }
      }
    }
    expect(received.filter((value) => value === secrets.CACHE_READ)).toHaveLength(2)
    expect(received).not.toContain(secrets.CACHE_WRITE)
  })

  it.each([
    ["CACHE_URL", "CACHE_WRITE"],
    ["CACHE_URL", "cache_write"],
    ["CACHE_WRITE", "CACHE_READ"],
    ["cache_write", "CACHE_READ"]
  ])("refuses the workspace writer in shared setup (%s, %s)", (url, token) => {
    expect(() => modernRender(url, token)).toThrow(/write credential/)
  })

  it.each([[null, "CACHE_READ"], ["CACHE_URL", null], [null, null]])(
    "permits absent shared setup inputs (%s, %s)",
    (url, token) => {
      expect(modernRender(url, token).files).toHaveLength(2)
    }
  )

  it("preserves existing reader declarations without split metadata", () => {
    expect(modernRender("CACHE_URL", "CACHE_READ", false).files).toHaveLength(2)
  })
})
