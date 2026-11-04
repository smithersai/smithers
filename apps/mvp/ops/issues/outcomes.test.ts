import { expect, test } from "vitest"
import { cleanRecord } from "./scrub.mjs"
import { confirmRepositories } from "./repositories.mjs"
import { commandArguments } from "./command-options.mjs"

const confirm = async (rows: unknown[], publicNames: string[] = []) => {
  const asked: string[] = []
  const repositoryVerdicts = await confirmRepositories(rows, {
    cacheFile: null,
    fetch: async (url: string) => {
      const name = url.split("/repos/")[1]!
      asked.push(name)
      return publicNames.includes(name) ? new Response(JSON.stringify({ private: false })) : new Response(null, { status: 404 })
    },
  })
  return { asked, repositoryVerdicts, records: rows.map((row) => cleanRecord(typeof row === "string" ? { body: row } : row, { repositoryVerdicts })) }
}

test.each(["smithersai", "nobody"])("bare colon credentials never acquire a lookup (%s)", async (owner) => {
  const bodies = [`gh repo view ${owner}/open\ncreds ${owner}:example-pass`]
  if (owner === "smithersai") bodies.push(`${owner}:example-pass`, `my login is ${owner}:example-pass on the registry`, `# ${owner}:example-pass`)
  for (const body of bodies) {
    const { asked, records } = await confirm([body], [`${owner}/open`])
    expect(asked.some((name) => name.includes("example-pass"))).toBe(false)
    expect(records[0]!.record.body).not.toContain("example-pass")
    expect(records[0]!.record.body).toContain("[repo]")
  }
})

test.each(["curl", "wget"])("user options carry credential roles (%s)", async (tool) => {
  for (const args of [["-u", "nobody:example-pass"], ["-unobody:example-pass"], ["--user", "nobody:example-pass"], ["--user=nobody:example-pass"]]) {
    expect(commandArguments([tool, ...args], 0).some((argument: { role: string }) => argument.role === "credential")).toBe(true)
    const { asked, records } = await confirm([`${tool} ${args.join(" ")} https://example.org/check`])
    expect(asked).toEqual([])
    expect(records[0]!.record.body).not.toContain("example-pass")
  }
})

test.each(["See nobody/hidden-tool for the fix.", "Edit `nobody/hidden-tool/src/main.ts` first.", "**nobody/hidden-tool** is down", "Blocked on nobody/hidden-tool#12."])("untied slash references fail closed (%s)", async (body) => {
  const { asked, records } = await confirm([body])
  expect(asked).toContain("nobody/hidden-tool")
  expect(records[0]!.record.body).not.toContain("nobody/hidden-tool")
  expect(records[0]!.record.body).toContain("[repo]")
})

test("a suspect-only owner tie cannot authorize ordinary prose", async () => {
  const { asked, repositoryVerdicts, records } = await confirm(["```yaml\ntoken: example\nrepo: nobody/open\n```\nAlso nobody/hidden-tool is affected."], ["nobody/open"])
  expect(asked).toEqual(["nobody/hidden-tool"])
  expect(repositoryVerdicts.watched).not.toContain("nobody")
  expect(records[0]!.record.body).not.toContain("nobody/hidden-tool")
  expect(records[0]!.record.body).toContain("[repo]")
})

test("untied prose exceptions survive without requests", async () => {
  const body = "node/bun ts/tsx and/or TCP/IP src/path/file.ts @scope/pkg origin/main feature/x"
  const { asked, records } = await confirm([body])
  expect(asked).toEqual([])
  expect(records[0]).toMatchObject({ ok: true, record: { body } })
})

test.each(["head=nobody:branch", "base=nobody:branch", "compare/main...nobody:branch", "git@github.com:nobody/branch", "https://github.com/nobody/branch"])("explicit reference forms retain requests (%s)", async (body) => {
  const { asked, records } = await confirm([body], ["nobody/branch"])
  expect(asked).toContain("nobody/branch")
  expect(records[0]!.record.body).not.toContain("[repo]")
})

test.each(["compare", "tree", "blob", "commit", "commits", "repos"])("route words cannot exempt an ordinary repository pair (%s)", async (owner) => {
  const { asked, records } = await confirm([`${owner}/hidden-tool`])
  expect(asked).toEqual([`${owner}/hidden-tool`])
  expect(records[0]).toMatchObject({ ok: true, record: { body: "[repo]" } })
})

test("an example breadcrumb cannot turn its tree identity private", async () => {
  const metadata = { key: "tree:repos:opencode", parent: "tree:repos:opencode", body: "retained" }
  const { asked, records } = await confirm(["Example repos / opencode", metadata])
  expect(asked).toEqual([])
  expect(records[1]).toMatchObject({ ok: true, record: metadata })
})
