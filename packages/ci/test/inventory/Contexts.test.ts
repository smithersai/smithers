import { describe, expect, it } from "vitest"
import type { Host } from "../../src/contract/Inventory.ts"
import {
  admits,
  type Event,
  eventFile,
  eventName,
  eventOf,
  type Facts,
  github,
  type Place,
  runner,
  startedVariables,
  variables
} from "../../src/inventory/Contexts.ts"
import { evaluate, type Evaluated } from "../../src/inventory/Expression.ts"
import { commitMark, parentMark } from "../../src/inventory/Runner.ts"

const eliza: Facts = { repository: "elizaOS/eliza", defaultBranch: "develop" }
const ci: Place = { job: "test", workflow: "CI" }

const read = (
  text: string,
  event: Event | undefined,
  facts: Facts = eliza,
  place: Place = ci,
  host?: Host
): Evaluated =>
  evaluate(text, {
    context: (name) => name === "github" ? github(event, facts, place) : name === "runner" ? runner(host) : undefined
  })

const literal = (held: unknown): Evaluated => ({ kind: "ok", residual: { kind: "literal", value: held } as never })

const variable = (id: string, name: string): Evaluated => ({
  kind: "ok",
  residual: { kind: "variable", variable: { id, name, nullable: false, typed: false } }
})

const or = (left: Evaluated, right: Evaluated): Evaluated => ({
  kind: "ok",
  residual: {
    kind: "binary",
    operator: "||",
    left: left.kind === "ok" ? left.residual : { kind: "literal", value: null },
    right: right.kind === "ok" ? right.residual : { kind: "literal", value: null }
  }
})

const problem = (result: Evaluated): string => {
  expect(result.kind).toBe("problem")
  return result.kind === "problem" ? result.why : ""
}

describe("eventOf", () => {
  const on = (...events: ReadonlyArray<string>) => Object.fromEntries(events.map((event) => [event, null]))

  // Events that trigger workflows: a replay stands for one change event.
  it("prefers a pull request to a push", () => {
    expect(eventOf(on("push", "merge_group", "pull_request"))).toBe("pull_request")
  })

  it("prefers a push to a merge group", () => {
    expect(eventOf(on("merge_group", "push", "workflow_dispatch"))).toBe("push")
  })

  it("takes a merge group when nothing else starts the workflow", () => {
    expect(eventOf(on("merge_group", "schedule"))).toBe("merge_group")
  })

  it("is undefined when no change starts the workflow", () => {
    expect(eventOf(on("workflow_dispatch", "schedule"))).toBeUndefined()
    expect(eventOf({})).toBeUndefined()
  })

  // "Workflow syntax: on.<push|pull_request>.branches": an event starts a workflow only for a branch its filter lets in.
  it("takes the first event whose branch filter lets the default branch in", () => {
    const filtered = { push: { branches: ["main"] }, pull_request: { branches: ["develop"] } }
    expect(eventOf(filtered, "main")).toBe("push")
    expect(eventOf(filtered, "develop")).toBe("pull_request")
    // No filter is known to let `release` in, so the first event stands: the jobs run more often than their CI.
    expect(eventOf(filtered, "release")).toBe("pull_request")
    expect(eventOf(filtered)).toBe("pull_request")
  })
})

describe("admits", () => {
  // "Filter pattern cheat sheet": `*` stops at a slash, `**` does not, and `!` takes a branch out again.
  it.each<[unknown, string, boolean]>([
    [null, "main", true],
    [{}, "main", true],
    [{ types: ["opened"] }, "main", true],
    [{ branches: ["main"] }, "main", true],
    [{ branches: ["main"] }, "develop", false],
    [{ branches: ["release/*"] }, "release/1", true],
    [{ branches: ["release/*"] }, "release/1/hotfix", false],
    [{ branches: ["release/**"] }, "release/1/hotfix", true],
    [{ branches: ["**"] }, "feature/x", true],
    [{ branches: ["v1.x"] }, "v1.x", true],
    [{ branches: ["v1.x"] }, "v1ax", false],
    [{ branches: ["release/**", "!release/**-alpha"] }, "release/1-alpha", false],
    [{ branches: ["release/**", "!release/**-alpha"] }, "release/1", true],
    [{ branches: ["!main", "main"] }, "main", true],
    [{ "branches-ignore": ["main"] }, "main", false],
    [{ "branches-ignore": ["docs/**"] }, "main", true],
    // A filter written with `+`, `?` or `[` is not read here, so it keeps no branch out.
    [{ branches: ["v[0-9]+"] }, "main", true],
    [{ "branches-ignore": ["v?"] }, "v1", true],
    [{ branches: "main" }, "develop", false],
    [{ branches: "main" }, "main", true],
    [{ branches: [1] }, "develop", true]
  ])("%j for %s is %s", (config, branch, admitted) => {
    expect(admits(config, branch)).toBe(admitted)
  })
})

describe("describe (how a sentence names the event)", () => {
  it("names each event with the default branch", () => {
    expect(eventName("pull_request", eliza)).toBe("a pull request to develop")
    expect(eventName("push", eliza)).toBe("a push to develop")
    expect(eventName("merge_group", eliza)).toBe("a merge group for develop")
    expect(eventName(undefined, eliza)).toBe("a run no change starts")
  })

  it("names the default branch generically when it is not known", () => {
    expect(eventName("pull_request", {})).toBe("a pull request to the default branch")
    expect(eventName("push", {})).toBe("a push to the default branch")
    expect(eventName("merge_group", {})).toBe("a merge group for the default branch")
  })
})

describe("github context: real eliza expressions", () => {
  const headOrSha = "github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha"

  // Contexts reference: github context; Events that trigger workflows: pull_request.
  it("reads the pull request head as the commit, falling back to github.sha while the job runs", () => {
    expect(read(headOrSha, "pull_request")).toEqual(
      or(variable("sha", "github.event.pull_request.head.sha"), variable("sha", "github.sha"))
    )
  })

  it("falls back to github.sha on a push", () => {
    expect(read(headOrSha, "push")).toEqual(variable("sha", "github.sha"))
  })

  const baseSha =
    "github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.merge_group.base_sha"

  // Events that trigger workflows: pull_request and merge_group carry a base commit.
  it("reads the base of a pull request and of a merge group", () => {
    expect(read(baseSha, "pull_request")).toEqual(
      or(variable("base:the pull request", "github.event.pull_request.base.sha"), literal(null))
    )
    expect(read(baseSha, "merge_group")).toEqual(variable("base:the merge group", "github.event.merge_group.base_sha"))
  })

  // Contexts reference: github.event is the full payload; a payload the event lacks reads as null.
  it("reads a payload name of another event as null", () => {
    expect(read(baseSha, "push")).toEqual(literal(null))
    expect(read("github.event.merge_group", "pull_request")).toEqual(literal(null))
    expect(read("github.event.pull_request", "push")).toEqual(literal(null))
    expect(read("github.event.before", "merge_group")).toEqual(literal(null))
    expect(read("github.event.head_commit", "pull_request")).toEqual(literal(null))
    expect(read("github.event.number", "push")).toEqual(literal(null))
  })

  // "Webhook events and payloads": a push has `head_commit` and `commits`, a pull request has `number`, `action`
  // and, when commits were pushed to it, `before` and `after`. Only GitHub knows what they hold.
  it("refuses a payload name the event has and a replay does not know", () => {
    for (
      const [name, event] of [
        ["head_commit.message", "push"],
        ["commits", "push"],
        ["pusher.name", "push"],
        ["number", "pull_request"],
        ["action", "pull_request"],
        ["before", "pull_request"],
        ["label.name", "pull_request"],
        ["action", "merge_group"]
      ] as const
    ) {
      expect(problem(read(`github.event.${name}`, event))).toContain("is known only on GitHub")
    }
  })

  const toMain = "(github.event_name == 'pull_request' && github.base_ref == 'main') || "
    + "(github.event_name == 'merge_group' && github.event.merge_group.base_ref == 'refs/heads/main')"

  it("decides whether the change targets main", () => {
    expect(read(toMain, "pull_request")).toEqual(literal(false))
    expect(read(toMain, "merge_group")).toEqual(literal(false))
    const main = { ...eliza, defaultBranch: "main" }
    expect(read(toMain, "pull_request", main)).toEqual(literal(true))
    expect(read(toMain, "merge_group", main)).toEqual(literal(true))
  })

  it("finds no labels on a replayed pull request", () => {
    expect(read("contains(github.event.pull_request.labels.*.name, 'staging-artifacts')", "pull_request"))
      .toEqual(literal(false))
  })

  it("reads the pull request head as coming from the repository itself", () => {
    expect(read("github.event.pull_request.head.repo.full_name == github.repository", "pull_request"))
      .toEqual(literal(true))
  })

  // Contexts reference: github.ref of a push is refs/heads/<branch>.
  it("reads the ref of a push to the default branch", () => {
    const text = "contains(fromJSON('[\"refs/heads/staging\",\"refs/heads/main\"]'), github.ref)"
    expect(read(text, "push", { ...eliza, defaultBranch: "main" })).toEqual(literal(true))
    expect(read(text, "push")).toEqual(literal(false))
  })

  // runner context: runner.environment is self-hosted on a machine that is not GitHub's.
  it("is not a GitHub-hosted Linux runner", () => {
    expect(read("runner.os == 'Linux' && runner.environment == 'github-hosted'", "push", eliza, ci, "linux"))
      .toEqual(literal(false))
  })
})

describe("github context: fields", () => {
  it("names the event, or has none to name", () => {
    expect(read("github.event_name", "pull_request")).toEqual(literal("pull_request"))
    expect(read("github.event_name", "push")).toEqual(literal("push"))
    expect(read("github.event_name", "merge_group")).toEqual(literal("merge_group"))
    expect(problem(read("github.event_name", undefined))).toContain("no change starts this workflow")
  })

  it("has no event payload when no change starts the workflow", () => {
    expect(problem(read("github.event.repository", undefined))).toContain("has no event to read")
  })

  // Default environment variables: GITHUB_SHA and GITHUB_WORKSPACE are set when the job runs.
  it("finishes the commit and the workspace while the job runs", () => {
    expect(read("github.sha", "push")).toEqual(variable("sha", "github.sha"))
    expect(read("github.workspace", undefined)).toEqual(variable("workspace", "github.workspace"))
  })

  it("knows the ref and ref name only of a push", () => {
    expect(read("github.ref", "push")).toEqual(literal("refs/heads/develop"))
    expect(read("github.ref_name", "push")).toEqual(literal("develop"))
    expect(problem(read("github.ref", "push", {}))).toContain("the default branch is not known here")
    expect(problem(read("github.ref_name", "push", {}))).toContain("the default branch is not known here")
    expect(problem(read("github.ref", "pull_request"))).toContain(
      "github.ref of a pull request to develop is known only on GitHub"
    )
    expect(problem(read("github.ref_name", "merge_group"))).toContain(
      "github.ref_name of a merge group for develop is known only on GitHub"
    )
    expect(problem(read("github.ref", undefined))).toContain("github.ref of a run no change starts")
  })

  it("reads the ref type as a branch", () => {
    expect(read("github.ref_type", "merge_group")).toEqual(literal("branch"))
  })

  // Contexts reference: base_ref and head_ref are set only for pull_request events.
  it("knows base_ref of a pull request and is empty otherwise", () => {
    expect(read("github.base_ref", "pull_request")).toEqual(literal("develop"))
    expect(problem(read("github.base_ref", "pull_request", {}))).toContain("the default branch is not known here")
    expect(read("github.base_ref", "push")).toEqual(literal(""))
  })

  it("does not know head_ref of a pull request and is empty otherwise", () => {
    expect(problem(read("github.head_ref", "pull_request"))).toContain("github.head_ref")
    expect(read("github.head_ref", "push")).toEqual(literal(""))
    expect(read("github.head_ref", "merge_group")).toEqual(literal(""))
  })

  it("reads the repository and its owner when known", () => {
    expect(read("github.repository", "push")).toEqual(literal("elizaOS/eliza"))
    expect(read("github.repository_owner", "push")).toEqual(literal("elizaOS"))
    expect(problem(read("github.repository", "push", {}))).toContain("the repository's name is not known here")
    expect(problem(read("github.repository_owner", "push", {}))).toContain("the repository's owner is not known here")
  })

  it("stands in one actor and one run", () => {
    expect(read("github.actor", "push")).toEqual(literal("smithers-ci"))
    expect(read("github.triggering_actor", "push")).toEqual(literal("smithers-ci"))
    expect(read("github.run_id", "push")).toEqual(literal("1"))
    expect(read("github.run_number", "push")).toEqual(literal("1"))
    expect(read("github.run_attempt", "push")).toEqual(literal("1"))
  })

  it("reads the job and workflow from the place", () => {
    expect(read("github.job", "push")).toEqual(literal("test"))
    expect(read("github.workflow", "push")).toEqual(literal("CI"))
  })

  // Contexts reference: github.action_path is set only inside a composite action.
  it("finishes action_path only inside an action", () => {
    expect(read("github.action_path", "push", eliza, { ...ci, actionPath: ".github/actions/setup" }))
      .toEqual(variable("path:.github/actions/setup", "github.action_path"))
    expect(problem(read("github.action_path", "push"))).toContain("has a value only inside an action")
  })

  it("reads the token as the GITHUB_TOKEN secret", () => {
    expect(read("github.token", "push")).toEqual({ kind: "secret", name: "GITHUB_TOKEN" })
  })

  it("reads the server addresses", () => {
    expect(read("github.server_url", "push")).toEqual(literal("https://github.com"))
    expect(read("github.api_url", "push")).toEqual(literal("https://api.github.com"))
    expect(read("github.graphql_url", "push")).toEqual(literal("https://api.github.com/graphql"))
  })

  it("does not know other fields", () => {
    expect(problem(read("github.retention_days", "push"))).toContain("github.retention_days is known only on GitHub")
  })
})

describe("github.event of a pull request", () => {
  // Events that trigger workflows: pull_request.
  it("reads the repository from the facts", () => {
    expect(read("github.event.repository.full_name", "pull_request")).toEqual(literal("elizaOS/eliza"))
    expect(read("github.event.repository.default_branch", "pull_request")).toEqual(literal("develop"))
    expect(problem(read("github.event.repository.full_name", "pull_request", {}))).toContain("not known here")
    expect(problem(read("github.event.repository.default_branch", "pull_request", {}))).toContain("not known here")
    expect(problem(read("github.event.repository.id", "pull_request"))).toContain(
      "github.event.repository.id is known only on GitHub"
    )
  })

  it("reads the base branch and the head as not a fork", () => {
    expect(read("github.event.pull_request.base.ref", "pull_request")).toEqual(literal("develop"))
    expect(problem(read("github.event.pull_request.base.ref", "pull_request", {}))).toContain("not known here")
    expect(read("github.event.pull_request.head.repo.fork", "pull_request")).toEqual(literal(false))
    expect(read("github.event.pull_request.base.repo.default_branch", "pull_request")).toEqual(literal("develop"))
  })

  it("does not know the head branch or other side fields", () => {
    expect(problem(read("github.event.pull_request.head.ref", "pull_request"))).toContain(
      "github.event.pull_request.head.ref is known only on GitHub"
    )
    expect(problem(read("github.event.pull_request.base.label", "pull_request"))).toContain(
      "github.event.pull_request.base.label is known only on GitHub"
    )
  })

  it("is no draft, and does not know its number or title", () => {
    expect(read("github.event.pull_request.draft", "pull_request")).toEqual(literal(false))
    expect(problem(read("github.event.pull_request.number", "pull_request"))).toContain(
      "github.event.pull_request.number is known only on GitHub"
    )
    expect(problem(read("github.event.pull_request.title", "pull_request"))).toContain("known only on GitHub")
  })

  it("does not know a top-level name no payload has", () => {
    expect(problem(read("github.event.sender", "pull_request"))).toContain(
      "github.event.sender is known only on GitHub"
    )
  })
})

describe("github.event of a push", () => {
  // Events that trigger workflows: push.
  it("reads before and after as the parent and the commit", () => {
    expect(read("github.event.before", "push")).toEqual(variable("before", "github.event.before"))
    expect(read("github.event.after", "push")).toEqual(variable("sha", "github.event.after"))
  })

  it("reads the ref when the default branch is known", () => {
    expect(read("github.event.ref", "push")).toEqual(literal("refs/heads/develop"))
    expect(problem(read("github.event.ref", "push", {}))).toContain("the default branch is not known here")
  })

  it("is neither created, deleted nor forced", () => {
    expect(read("github.event.created || github.event.deleted || github.event.forced", "push")).toEqual(literal(false))
  })

  it("reads the repository", () => {
    expect(read("github.event.repository.full_name", "push")).toEqual(literal("elizaOS/eliza"))
  })
})

describe("github.event of a merge group", () => {
  // Events that trigger workflows: merge_group.
  it("reads the head and base commits", () => {
    expect(read("github.event.merge_group.head_sha", "merge_group"))
      .toEqual(variable("sha", "github.event.merge_group.head_sha"))
    expect(read("github.event.merge_group.base_sha", "merge_group"))
      .toEqual(variable("base:the merge group", "github.event.merge_group.base_sha"))
  })

  it("reads the base ref when the default branch is known", () => {
    expect(read("github.event.merge_group.base_ref", "merge_group")).toEqual(literal("refs/heads/develop"))
    expect(problem(read("github.event.merge_group.base_ref", "merge_group", {}))).toContain(
      "the default branch is not known here"
    )
  })

  it("does not know other merge group fields", () => {
    expect(problem(read("github.event.merge_group.head_ref", "merge_group"))).toContain(
      "github.event.merge_group.head_ref is known only on GitHub"
    )
  })
})

describe("runner context", () => {
  // runner context: runner.os is Linux, Windows or macOS.
  it("names the system of each host", () => {
    expect(read("runner.os", "push", eliza, ci, "linux")).toEqual(literal("Linux"))
    expect(read("runner.os", "push", eliza, ci, "darwin")).toEqual(literal("macOS"))
    expect(read("runner.os", "push", eliza, ci, "win32")).toEqual(literal("Windows"))
    // A runner whose name does not say its system runs here as this machine: the step reads it when it starts.
    expect(read("runner.os", "push")).toEqual({
      kind: "ok",
      residual: { kind: "variable", variable: { id: "os", name: "runner.os", nullable: false, typed: false } }
    })
  })

  it("finishes the architecture and directories while the job runs", () => {
    expect(read("runner.arch", "push")).toEqual(variable("arch", "runner.arch"))
    expect(read("runner.temp", "push")).toEqual(variable("temp", "runner.temp"))
    expect(read("runner.tool_cache", "push")).toEqual(variable("toolcache", "runner.tool_cache"))
  })

  it("is a self-hosted runner named smithers-ci", () => {
    expect(read("runner.name", "push")).toEqual(literal("smithers-ci"))
    expect(read("runner.environment", "push")).toEqual(literal("self-hosted"))
  })

  it("reads debug as null and does not know other fields", () => {
    expect(read("runner.debug", "push")).toEqual(literal(null))
    expect(problem(read("runner.label", "push"))).toContain("runner.label is known only on GitHub")
  })
})

describe("variables", () => {
  const always = {
    GITHUB_ACTIONS: "true",
    GITHUB_ACTOR: "smithers-ci",
    GITHUB_TRIGGERING_ACTOR: "smithers-ci",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW: "CI",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_NUMBER: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF_TYPE: "branch",
    RUNNER_NAME: "smithers-ci",
    RUNNER_ENVIRONMENT: "self-hosted"
  }
  const repository = { GITHUB_REPOSITORY: "elizaOS/eliza", GITHUB_REPOSITORY_OWNER: "elizaOS" }

  // Default environment variables: GITHUB_REF and GITHUB_REF_NAME of a push name the branch.
  it("sets the ref of a push", () => {
    expect(variables("push", eliza, ci)).toEqual({
      ...always,
      ...repository,
      GITHUB_EVENT_NAME: "push",
      GITHUB_BASE_REF: "",
      GITHUB_HEAD_REF: "",
      GITHUB_REF: "refs/heads/develop",
      GITHUB_REF_NAME: "develop"
    })
  })

  // Default environment variables: GITHUB_BASE_REF is set only for pull_request events.
  it("sets the base ref of a pull request and leaves the head ref out", () => {
    expect(variables("pull_request", eliza, ci)).toEqual({
      ...always,
      ...repository,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "develop"
    })
  })

  it("sets empty base and head refs for a merge group", () => {
    expect(variables("merge_group", eliza, ci)).toEqual({
      ...always,
      ...repository,
      GITHUB_EVENT_NAME: "merge_group",
      GITHUB_BASE_REF: "",
      GITHUB_HEAD_REF: ""
    })
  })

  it("leaves out what is not known", () => {
    expect(variables(undefined, {}, ci)).toEqual({ ...always, GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "" })
    expect(variables("push", {}, ci)).toEqual({
      ...always,
      GITHUB_EVENT_NAME: "push",
      GITHUB_BASE_REF: "",
      GITHUB_HEAD_REF: ""
    })
    expect(variables("pull_request", { repository: "elizaOS/eliza" }, ci)).toEqual({
      ...always,
      ...repository,
      GITHUB_EVENT_NAME: "pull_request"
    })
  })

  it("names the variables set when a step starts", () => {
    expect(startedVariables).toContain("GITHUB_SHA")
    expect(startedVariables).toContain("GITHUB_JOB")
    expect(startedVariables).toContain("GITHUB_EVENT_PATH")
    expect(startedVariables).toContain("RUNNER_TOOL_CACHE")
  })
})

describe("eventFile", () => {
  // Events that trigger workflows: pull_request payload, written for GITHUB_EVENT_PATH.
  it("writes a pull request payload", () => {
    const repo = { full_name: "elizaOS/eliza", default_branch: "develop", fork: false }
    expect(JSON.parse(eventFile("pull_request", eliza))).toEqual({
      pull_request: {
        head: { sha: commitMark, repo },
        base: { sha: parentMark, ref: "develop", repo },
        labels: [],
        draft: false
      },
      repository: { full_name: "elizaOS/eliza", default_branch: "develop" }
    })
  })

  it("writes a pull request payload without facts", () => {
    expect(JSON.parse(eventFile("pull_request", {}))).toEqual({
      pull_request: {
        head: { sha: commitMark, repo: { fork: false } },
        base: { sha: parentMark, repo: { fork: false } },
        labels: [],
        draft: false
      },
      repository: {}
    })
  })

  // Events that trigger workflows: push payload.
  it("writes a push payload", () => {
    expect(JSON.parse(eventFile("push", eliza))).toEqual({
      before: parentMark,
      after: commitMark,
      ref: "refs/heads/develop",
      created: false,
      deleted: false,
      forced: false,
      repository: { full_name: "elizaOS/eliza", default_branch: "develop" }
    })
    expect(JSON.parse(eventFile("push", {}))).toEqual({
      before: parentMark,
      after: commitMark,
      created: false,
      deleted: false,
      forced: false,
      repository: {}
    })
  })

  // Events that trigger workflows: merge_group payload.
  it("writes a merge group payload", () => {
    expect(JSON.parse(eventFile("merge_group", eliza))).toEqual({
      merge_group: { head_sha: commitMark, base_sha: parentMark, base_ref: "refs/heads/develop" },
      repository: { full_name: "elizaOS/eliza", default_branch: "develop" }
    })
    expect(JSON.parse(eventFile("merge_group", {}))).toEqual({
      merge_group: { head_sha: commitMark, base_sha: parentMark },
      repository: {}
    })
  })

  it("writes only the repository when no change starts the workflow", () => {
    expect(JSON.parse(eventFile(undefined, { repository: "elizaOS/eliza" }))).toEqual({
      repository: { full_name: "elizaOS/eliza" }
    })
  })
})
