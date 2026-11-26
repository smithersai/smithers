import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect, Result } from "effect"
import { expect, test } from "vitest"
import { select } from "../../worker/branch/Creation"
import { AuthStore, SESSION } from "../features/auth/store"
import { COMMANDS, commandsFor, pluginCommands } from "../features/commands/catalog"
import { Commands } from "../features/commands/commands"
import { agentFlows, catalogDescription } from "../flows/catalog.vibe"
import { declarationOf, modelInvocable } from "../flows/declarations.vibe"
import { names } from "../flows/registry.vibe"
import { member, openTestApp } from "../test/chatApi"
import { BUILTIN, type BuiltIn } from "./builtin"
import { BRANCH_FLOWS } from "./builtinFlows"
import { Plugins } from "./plugins"
import { PluginsUi } from "./ui"

const idOf = ({ manifest }: BuiltIn) => (manifest as { readonly id: string }).id
const tabIds = BUILTIN.map(idOf).sort()

test.each([
  { removed: "all plugins", plugins: [], expected: [], branchFlows: {} },
  { removed: "queue", plugins: BUILTIN.filter((plugin) => idOf(plugin) !== "queue"), expected: tabIds.filter((id) => id !== "queue"), branchFlows: BRANCH_FLOWS },
  { removed: "branches", plugins: BUILTIN, expected: tabIds, branchFlows: {} },
])("boots the host and preserves the app catalog without $removed", async ({ plugins, expected, branchFlows }) => {
  const runtime = openTestApp({ plugins, answers: false })
  try {
    const host = await runtime.runPromise(Effect.service(Plugins))
    const ui = await runtime.runPromise(Effect.service(PluginsUi))
    expect(host.refused).toEqual([])
    expect(ui.contributions.plugins.map(({ id }) => id).sort()).toEqual(expected)
    expect([...host.built.keys()].sort()).toEqual(expected)
    if (expected.includes("queue")) expect(await ui.actions.tab("queue")).toBeDefined()

    const { session } = await runtime.runPromise(Effect.service(AuthStore))
    await session.tanstack.preload()
    await expect.poll(() => session.tanstack.get(SESSION)?.status ?? "loading").not.toBe("loading")
    await runtime.runPromise(session.update(SESSION, (row) => {
      Object.assign(row, { status: "signed_in", login: member.subject.id, role: member.role })
    }))
    const commands = await runtime.runPromise(Effect.service(Commands))
    await commands.queries.menu.preload()
    await commands.actions.type("/")
    const entries = [...COMMANDS, ...pluginCommands(host.contributions.commands)]
    const offered = commandsFor({ signedIn: true, role: member.role }, entries)
    const menu = commands.queries.menu.toArray[0]
    expect(menu?.kind).toBe("commands")
    expect(menu?.items.map(({ id }) => id)).toEqual(offered.map(({ name }) => `command:${name}`))
    expect(menu?.items.map(({ id }) => id)).toContain("command:theme")
    expect(menu?.items.some(({ id }) => id === "command:queue")).toBe(expected.includes("queue"))
    expect(new Set(entries.map(({ name }) => name)).size).toBe(entries.length)
    expect(entries.every(({ flow }) => host.facts.catalog.has(flow))).toBe(true)

    expect([...host.facts.catalog.keys()]).toEqual(names)
    expect(agentFlows).toEqual(names.filter(modelInvocable))
    expect(agentFlows).toContain("app/navigate")
    expect(agentFlows).not.toContain("run/answer")
    for (const name of agentFlows) {
      expect(declarationOf(name)._tag).toBe(name)
      expect(catalogDescription(name).trim()).not.toBe("")
    }
    expect(host.facts.catalog.get("run/answer")).toMatchObject({ personOnly: true, system: true })

    // Branch workflow sources are installed by the Worker rather than the tab.
    for (const operation of ["create", "publish", "update"] as const) {
      const selection = await Effect.runPromise(Effect.result(
        select(undefined, { owner: "octo", name: "hello" }, "builtin", operation, branchFlows),
      ))
      if (operation in branchFlows) {
        expect(Result.isSuccess(selection) && selection.success.tag).toBe(`branches/${operation}`)
      } else {
        expect(Result.isFailure(selection) && selection.failure.code).toBe("unavailable")
      }
    }
  } finally {
    await runtime.dispose()
  }
})

const app = join(import.meta.dirname, "../..")

const filesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "test" ? [] : filesUnder(path)
    if (!entry.isFile() || /\.(?:test|spec)\.[^.]+$/.test(entry.name)) return []
    return [path]
  })

test("public app source contains no internal codename", () => {
  const codename = ["jj", "hub"].join("")
  const matches = ["src", "public"].flatMap((root) =>
    filesUnder(join(app, root)).flatMap((file) =>
      readFileSync(file, "utf8").split(/\r?\n/).flatMap((line, index) =>
        line.toLowerCase().includes(codename) ? [`${relative(app, file)}:${index + 1}`] : [],
      ),
    ),
  )
  expect(matches).toEqual([])
})
