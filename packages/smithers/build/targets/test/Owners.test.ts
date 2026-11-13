import { describe, expect, it } from "vitest"
import { Smithers } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import * as Owners from "../src/Owners.ts"
import { metadata, Package } from "../src/Package.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const lint = Shell.Test({
  bin: { _tag: "NodeModuleBin", package: "@biomejs/biome" },
  data: [Input.glob(["**"])]
})

const workspaceOptions = (
  extra: Partial<WorkspaceDeclaration.WorkspaceOptions> = {}
): WorkspaceDeclaration.WorkspaceOptions => {
  const packageJson = Input.file("//package.json")
  return {
    repository: "git+https://example.invalid/fixture.git",
    cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
    runtime: Runtime.Node({ version: "26" }),
    packageManager: PackageManager.Yarn({ manifest: packageJson, lockfile: Input.file("//yarn.lock") }),
    nodeModules: WorkspaceDeclaration.NodeModules({ packageJson }),
    ...extra
  }
}

describe("Owners.declare", () => {
  it("normalizes owners, per-file rules, noparent, agents, and upstream", () => {
    const declaration = Owners.declare({
      owners: ["will", "team:platform", "will"],
      perFile: { "*.sql": "team:data", "migrations/**": ["will", "erik"] },
      noparent: true,
      agents: { default: "human-approve", "auto-land": ["*.md", "docs/**"], deny: ["migrations/**"] },
      upstream: { mode: "approve", packages: ["//lib", "//packages/..."] }
    })
    expect(Owners.isDeclaration(declaration)).toBe(true)
    expect(declaration.owners).toEqual(["will", "team:platform"])
    expect(declaration.perFile).toEqual([
      { pattern: "*.sql", owners: ["team:data"] },
      { pattern: "migrations/**", owners: ["will", "erik"] }
    ])
    expect(declaration.noparent).toBe(true)
    expect(declaration.agents).toEqual({
      default: "human-approve",
      overrides: [
        { pattern: "migrations/**", policy: "deny" },
        { pattern: "*.md", policy: "auto-land" },
        { pattern: "docs/**", policy: "auto-land" }
      ]
    })
    expect(declaration.upstream).toEqual({ mode: "approve", packages: ["//lib", "//packages/..."] })
    expect(Owners.teamReferences(declaration)).toEqual(["data", "platform"])
    expect(Owners.declare(declaration)).toBe(declaration)
  })

  it("orders overrides most restrictive first whatever order the author wrote them in", () => {
    const declaration = Owners.declare({
      owners: ["will"],
      agents: { "auto-land": ["*.md"], "human-approve": ["docs/internal/**"], deny: ["migrations/**"] }
    })
    expect(declaration.agents?.overrides.map((override) => override.policy)).toEqual([
      "deny",
      "human-approve",
      "auto-land"
    ])
  })

  it("accepts the short forms and defaults", () => {
    const short = Owners.declare({ owners: ["will"], agents: "deny", upstream: "review" })
    expect(short.noparent).toBe(false)
    expect(short.perFile).toEqual([])
    expect(short.agents).toEqual({ default: "deny", overrides: [] })
    expect(short.upstream).toEqual({ mode: "review" })
    expect(Owners.declare({ owners: ["will"], upstream: "none" }).upstream).toBeUndefined()
    expect(Owners.declare({ owners: ["will"], agents: { deny: ["a/**"] } }).agents).toEqual({
      default: "human-approve",
      overrides: [{ pattern: "a/**", policy: "deny" }]
    })
  })

  it("rejects malformed owners, patterns, policies, and claims", () => {
    expect(() => Owners.declare({ owners: ["not a login"] })).toThrow(/not a login or team:<name>/)
    expect(() => Owners.declare({ owners: ["team:"] })).toThrow(/not a login or team:<name>/)
    expect(() => Owners.declare({ owners: "will" as never })).toThrow(/array of logins/)
    expect(() => Owners.declare({ perFile: { "/abs/*.ts": ["will"] } })).toThrow(/relative to the package/)
    expect(() => Owners.declare({ perFile: { "../*.ts": ["will"] } })).toThrow(/relative to the package/)
    expect(() => Owners.declare({ perFile: { "*.ts": [] } })).toThrow(/names no owner/)
    expect(() => Owners.declare({ noparent: true })).toThrow(/noparent requires at least one owner/)
    expect(() => Owners.declare({ owners: ["will"], agents: "maybe" as never })).toThrow(
      /auto-land, human-approve, or deny/
    )
    expect(() => Owners.declare({ owners: ["will"], agents: { approve: ["x"] } as never })).toThrow(/unknown key/)
    // A known key is not a known policy: the fallback every unmatched path
    // lands on has to be one of the three, not merely a string.
    expect(() => Owners.declare({ owners: ["will"], agents: { default: "maybe" } as never })).toThrow(
      /default is not auto-land, human-approve, or deny/
    )
    expect(() => Owners.declare({ owners: ["will"], upstream: "all" as never })).toThrow(/none, review, approve/)
    expect(() => Owners.declare({ owners: ["will"], upstream: { mode: "review", packages: [] } })).toThrow(
      /non-empty array/
    )
    expect(() => Owners.declare({ owners: ["will"], upstream: { mode: "review", packages: ["lib"] } })).toThrow(
      /\/\/package label/
    )
    expect(() => Owners.declare({ owners: ["will"], extra: 1 } as never)).toThrow(/unknown option/)
  })

  /**
   * The bound is on the declaration, not on the rendered CODEOWNERS line: a
   * roster longer than this is a team reference written out by hand, and the
   * generated line would be long enough that GitHub silently truncates it.
   */
  it("refuses a roster longer than the owner bound, at the declaration and per file", () => {
    const roster = Array.from({ length: Owners.maximumOwners + 1 }, (_, index) => `owner${index}`)
    expect(roster).toHaveLength(65)
    expect(() => Owners.declare({ owners: roster })).toThrow(
      `Owners owners lists more than ${Owners.maximumOwners} owners`
    )
    expect(() => Owners.declare({ owners: ["will"], perFile: { "*.sql": roster } })).toThrow(
      `lists more than ${Owners.maximumOwners} owners`
    )
    // One under the bound is still a legal declaration.
    expect(Owners.declare({ owners: roster.slice(0, Owners.maximumOwners) }).owners).toHaveLength(
      Owners.maximumOwners
    )
  })
})

describe("Owners.Teams", () => {
  it("normalizes and sorts the roster", () => {
    const teams = Owners.Teams({ platform: ["will", "erik", "will"], data: ["chungyi"] })
    expect(Owners.isTeamsDeclaration(teams)).toBe(true)
    expect(teams.teams).toEqual({ data: ["chungyi"], platform: ["erik", "will"] })
    expect(Owners.Teams(teams)).toBe(teams)
  })

  it("rejects bad names and members", () => {
    expect(() => Owners.Teams({ "bad name": ["will"] })).toThrow(/portable identifier/)
    expect(() => Owners.Teams({ platform: "will" as never })).toThrow(/array of member logins/)
    expect(() => Owners.Teams({ platform: ["team:x"] })).toThrow(/not a login/)
  })
})

describe("owners on Package and Workspace", () => {
  it("carries the validated declaration in the Package metadata", () => {
    const value = Package({ targets: { lint }, owners: { owners: ["will"], upstream: "review" } })
    expect(metadata(value).owners).toEqual({
      _tag: "Owners",
      owners: ["will"],
      perFile: [],
      noparent: false,
      upstream: { mode: "review" }
    })
    expect(metadata(Package({ targets: { lint } })).owners).toBeUndefined()
    expect(() => Package({ targets: { lint }, owners: { owners: ["nope nope"] } })).toThrow(/not a login/)
  })

  it("carries workspace owners and the team roster, validated", () => {
    const workspace = WorkspaceDeclaration.Workspace(
      "fixture",
      workspaceOptions({ owners: { owners: ["team:platform"], agents: "deny" }, teams: { platform: ["will"] } })
    )
    expect(workspace.owners?.owners).toEqual(["team:platform"])
    expect(workspace.owners?.agents).toEqual({ default: "deny", overrides: [] })
    expect(workspace.teams?.teams).toEqual({ platform: ["will"] })
    expect([...WorkspaceDeclaration.teamNames(workspace)]).toEqual(["platform"])
    expect(WorkspaceDeclaration.Workspace("fixture", workspaceOptions()).teams).toBeUndefined()
    expect(() => WorkspaceDeclaration.Workspace("fixture", workspaceOptions({ teams: { "x y": [] } }))).toThrow(
      /portable identifier/
    )
  })
})

describe("the generated-file rules", () => {
  it("report their rule ids and default to check-capable kinds", () => {
    expect(Smithers.Owners.Codeowners.id).toBe("Owners.Codeowners")
    expect(Smithers.Owners.Tree.id).toBe("Owners.Tree")
    expect(Smithers.Owners.declare).toBe(Owners.declare)
    expect(Smithers.Teams).toBe(Owners.Teams)
    const codeowners = Smithers.Owners.Codeowners({ org: "artsy" })
    expect(Target.metadata(codeowners).target).toBe("Owners.Codeowners")
    expect(Target.metadata(codeowners).kinds).toEqual(["build", "lint"])
    const tree = Smithers.Owners.Tree({})
    expect(Target.metadata(tree).kinds).toEqual(["build", "lint"])
    expect(() => Smithers.Owners.Codeowners({ org: "not an org" } as never)).toThrow()
  })
})

describe("Owners pattern lists", () => {
  // `patternList` guards every glob a declaration carries, and the agents map
  // is the path that reaches it with an author-supplied value. A pattern list
  // that is not a list, is longer than the bound, or holds something that is
  // not a usable glob has to be refused where it is written: a policy keyed on
  // a pattern nobody can match is a rule that silently applies to nothing.
  const base = { owners: ["will"] } as const

  it("refuses a policy whose patterns are not an array", () => {
    expect(() => Owners.declare({ ...base, agents: { deny: "a/**" as never } })).toThrow(
      /agents deny must be an array of glob patterns/
    )
  })

  it("refuses more patterns than the bound one policy may carry", () => {
    const patterns = Array.from({ length: Owners.maximumPatterns + 1 }, (_, index) => `p${index}/**`)

    expect(() => Owners.declare({ ...base, agents: { deny: patterns } })).toThrow(
      new RegExp(`agents deny lists more than ${Owners.maximumPatterns} patterns`)
    )
  })

  it.each([
    ["", "an empty string"],
    ["a\0b", "a NUL byte"]
  ])("refuses a pattern that is %j, which is %s", (pattern) => {
    expect(() => Owners.declare({ ...base, agents: { deny: [pattern] } })).toThrow(
      /agents deny pattern must be a non-empty string/
    )
  })
  // A per-file glob becomes one CODEOWNERS line, `<pattern> <owners...>`, and
  // GitHub splits that line on whitespace and reads `#` as a comment. A
  // newline in a pattern therefore writes a second rule with owners nobody
  // declared, so these are refused where they are written.
  it.each([
    ["src/a.ts\n* @intruder", "a newline that writes a second CODEOWNERS rule"],
    ["src/a.ts\r* @intruder", "a carriage return"],
    ["src/a b.ts", "whitespace that splits the CODEOWNERS line"],
    ["src/a.ts\t@intruder", "a tab"],
    ["#src/*.ts", "a leading # that CODEOWNERS reads as a comment"],
    ["!src/*.ts", "a leading ! that CODEOWNERS does not support"],
    ["src/\u007f.ts", "a DEL control character"]
  ])("refuses a perFile pattern %j: %s", (pattern) => {
    expect(() => Owners.declare({ perFile: { [pattern]: ["will"] } })).toThrow(
      /perFile pattern must be a glob without whitespace, control characters, or a leading # or !/
    )
  })

  it("refuses the same unsafe text in an agents policy pattern", () => {
    expect(() => Owners.declare({ ...base, agents: { deny: ["a\n*"] } })).toThrow(
      /agents deny pattern must be a glob without whitespace/
    )
  })

  it("keeps ordinary globs", () => {
    const declaration = Owners.declare({ perFile: { "src/**/*.{ts,tsx}": ["will"], "[ab]?.md": "team:docs" } })
    expect(declaration.perFile.map((rule) => rule.pattern)).toEqual(["[ab]?.md", "src/**/*.{ts,tsx}"])
  })
})

describe("tagged ownership declarations", () => {
  const tagged = (extra: Partial<Owners.Declaration> = {}): Owners.Declaration => ({
    _tag: "Owners",
    owners: ["alice"],
    perFile: [],
    noparent: false,
    ...extra
  })

  const unsafePatterns = [
    "",
    "/outside/**",
    "../outside/**",
    "src/../outside/**",
    "src/..",
    "src/a b.ts",
    "x @evil\n/ @evil\n../other/**",
    "a\rb",
    "a\tb",
    "a\0b",
    "a\u001fb",
    "a\u007fb",
    "#src/**",
    "!src/**"
  ]

  it.each(unsafePatterns)("refuses unsafe tagged per-file and policy patterns %j", (pattern) => {
    for (
      const value of [
        tagged({ perFile: [{ pattern, owners: ["alice"] }] }),
        tagged({ agents: { default: "human-approve", overrides: [{ pattern, policy: "deny" }] } })
      ]
    ) {
      expect(Owners.isDeclaration(value)).toBe(false)
      expect(() => Owners.declare(value)).toThrow()
    }
  })

  it("refuses tagged declarations that exceed bounds or leave paths ownerless", () => {
    const owners = Array.from({ length: Owners.maximumOwners + 1 }, (_, index) => `owner${index}`)
    const patterns = Array.from({ length: Owners.maximumPatterns + 1 }, (_, index) => `p${index}/**`)
    for (
      const value of [
        tagged({ owners }),
        tagged({ perFile: [{ pattern: "src/**", owners }] }),
        tagged({ perFile: [{ pattern: "src/**", owners: [] }] }),
        tagged({ perFile: patterns.map((pattern) => ({ pattern, owners: ["alice"] })) }),
        tagged({
          agents: { default: "human-approve", overrides: patterns.map((pattern) => ({ pattern, policy: "deny" })) }
        }),
        tagged({ owners: [], noparent: true }),
        ...[[], ["relative"], ["//src\n*"], patterns.map((_, index) => `//p${index}`)].map((packages) =>
          tagged({ upstream: { mode: "approve", packages } })
        )
      ]
    ) {
      expect(Owners.isDeclaration(value)).toBe(false)
      expect(() => Owners.declare(value)).toThrow()
    }
  })

  it("rejects forged values through the public Package and Workspace boundaries", () => {
    const owners = tagged({ perFile: [{ pattern: "x @evil\n/ @evil", owners: ["alice"] }] })
    const teams: Owners.TeamsDeclaration = { _tag: "Teams", teams: { platform: ["alice\n@evil"] } }
    expect(() => Package({ targets: { lint }, owners })).toThrow()
    expect(() => WorkspaceDeclaration.Workspace("fixture", workspaceOptions({ owners }))).toThrow()
    expect(() => WorkspaceDeclaration.Workspace("fixture", workspaceOptions({ teams }))).toThrow()
  })

  it("accepts valid tagged declarations at every bound, including each policy separately", () => {
    const owners = Array.from({ length: Owners.maximumOwners }, (_, index) => `owner${index}`)
    const patterns = Array.from({ length: Owners.maximumPatterns }, (_, index) => `p${index}/**`)
    const value = tagged({
      owners,
      perFile: patterns.map((pattern) => ({ pattern, owners })),
      noparent: true,
      agents: {
        default: "human-approve",
        overrides: (["deny", "human-approve", "auto-land"] as const).flatMap((policy) =>
          patterns.map((pattern) => ({ pattern, policy }))
        )
      },
      upstream: { mode: "review", packages: patterns.map((_, index) => `//p${index}/...`) }
    })
    expect(Owners.isDeclaration(value)).toBe(true)
    expect(Owners.declare(value)).toBe(value)
    expect(
      Owners.declare(tagged({ owners: [], perFile: [{ pattern: "src/**", owners: ["alice"] }], noparent: true }))
        .noparent
    )
      .toBe(true)
  })

  it.each([
    { "bad name": ["alice"] },
    { "": ["alice"] },
    { platform: ["not a login"] },
    { platform: ["alice\n@evil"] },
    { platform: ["team:other"] },
    { platform: Array.from({ length: Owners.maximumOwners + 1 }, (_, index) => `owner${index}`) }
  ])("refuses an unsafe tagged team roster %j", (teams) => {
    const value = { _tag: "Teams", teams } as Owners.TeamsDeclaration
    expect(Owners.isTeamsDeclaration(value)).toBe(false)
    expect(() => Owners.Teams(value)).toThrow()
  })

  it.each([
    { members: ["alice\n@evil"] },
    { members: Array.from({ length: Owners.maximumOwners + 1 }, (_, index) => `owner${index}`) }
  ])("refuses unsafe non-enumerable tagged team members %j", ({ members }) => {
    const teams = Object.defineProperty({}, "platform", { value: members, enumerable: false })
    const value: Owners.TeamsDeclaration = { _tag: "Teams", teams }
    expect(Owners.isTeamsDeclaration(value)).toBe(false)
    expect(() => Owners.Teams(value)).toThrow()
  })

  it("accepts a tagged team roster at the member bound", () => {
    const value: Owners.TeamsDeclaration = {
      _tag: "Teams",
      teams: { platform: Array.from({ length: Owners.maximumOwners }, (_, index) => `owner${index}`) }
    }
    expect(Owners.isTeamsDeclaration(value)).toBe(true)
    expect(Owners.Teams(value)).toBe(value)
  })
})
