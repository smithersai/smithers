import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Bind from "../src/Bind.ts"
import type * as Contribution from "../src/Contribution.ts"
import * as Keys from "../src/Keys.ts"
import * as Load from "../src/Load.ts"
import * as When from "../src/When.ts"
import { host, minimal, owned, queueManifest } from "./support/hostFacts.ts"

const load = (candidates: ReadonlyArray<Load.Candidate>, facts: Load.HostFacts = host()) =>
  Effect.runPromise(Load.load(facts, candidates))

const builtIn = (manifest: unknown, flows?: ReadonlyArray<Load.OwnedFlow>): Load.Candidate =>
  flows === undefined ? { tier: "built-in", manifest } : { tier: "built-in", manifest, flows }

/** The refusals, as `[plugin, reason, path]`. */
const refusals = async (candidates: ReadonlyArray<Load.Candidate>, facts?: Load.HostFacts) =>
  (await load(candidates, facts)).refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.path])

/** The queue manifest, changed by `edit`, loaded alone as a built-in. */
const queueWith = (edit: (manifest: any) => void, facts?: Load.HostFacts) => {
  const manifest = queueManifest()
  edit(manifest)
  return refusals([builtIn(manifest)], facts)
}

const row = {
  runId: "run-1",
  version: 3,
  execution: "exec-1",
  kind: "ask",
  prompt: "Which?",
  options: ["red", "green", "blue"],
  deadline: 0,
  question: true,
  approval: false,
  addressedTo: "will"
}

describe("the queue fixture", () => {
  it("decodes, checks and loads through the real loader", async () => {
    const { contributions, refused } = await load([builtIn(queueManifest())])
    expect(refused).toEqual([])
    expect(contributions.plugins).toEqual([{
      id: "queue",
      version: "0.1.0",
      title: "Queue",
      tier: "built-in",
      capabilities: [],
      uses: ["run/answer", "app/navigate"],
      owns: []
    }])
    const [view] = contributions.views
    expect(view).toMatchObject({ id: "queue/queue", plugin: "queue", tier: "built-in", reads: ["core/waits"] })
    expect(view!.events.map((event) => [event.name, "flow" in event && event.personOnly])).toEqual([
      ["option", true],
      ["approve", true],
      ["changes", true],
      ["reply", true],
      ["next", false],
      ["previous", false]
    ])
    expect(view!.events[0]).toMatchObject({
      payload: {
        type: "object",
        properties: { index: { type: "integer", minimum: 0, maximum: 8 } },
        required: ["index"],
        additionalProperties: false
      }
    })
    expect(contributions.slots).toMatchObject([{ id: "queue/nav", slot: "shell.nav", plugin: "queue" }])
    expect(contributions.commands).toMatchObject([{ id: "queue/open", flow: "app/navigate", slash: { name: "queue" } }])
    expect(contributions.keybindings.map((binding) => binding.key)).toEqual([
      "g q",
      "digit",
      "a",
      "r",
      "mod+enter",
      "j",
      "k"
    ])
    expect(contributions.keybindings[0]).toMatchObject({ command: "queue/open" })
    expect(contributions.keybindings[5]).toMatchObject({ view: "queue/queue", event: "next", personOnly: false })
  })

  it("answers option from the digit key through $key.index", async () => {
    const { contributions } = await load([builtIn(queueManifest())])
    const digit = contributions.keybindings[1] as Contribution.EventKeybinding
    expect(digit).toMatchObject({ view: "queue/queue", event: "option", personOnly: true })
    expect(When.evaluate(digit.when, { view: "queue/queue", item: row, focusInput: false })).toBe(true)
    expect(When.evaluate(digit.when, { view: "queue/queue", item: row, focusInput: true })).toBe(false)

    const pressed = Keys.match(digit.keys, [{ key: "2", meta: false, ctrl: false, alt: false, shift: false }], {
      mac: true
    })
    expect(pressed).toEqual({ matched: true, partial: false, index: 1 })

    const fields = Bind.bind(digit.fields, { item: row, event: undefined, key: { index: pressed.index! } })
    expect(fields).toEqual(Result.succeed({ index: 1 }))
    const option = contributions.views[0]!.events.find((event) => event.name === "option") as Contribution.FlowEvent
    const args = Bind.bind(option.args, { item: row, event: Result.getOrThrow(fields) })
    expect(args).toEqual(Result.succeed({ runId: "run-1", version: 3, execution: "exec-1", value: "green" }))
  })
})

describe("load refuses a plugin and loads the rest", () => {
  it("refuses an undecodable manifest, naming its id only when it reads as one", async () => {
    const throwing = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile")
      },
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile")
      }
    })
    const loaded = await load([
      builtIn({ ...minimal("bad"), extra: 1 }),
      builtIn(5),
      builtIn(null),
      builtIn({ id: "Not An Id" }),
      builtIn({}),
      builtIn(throwing),
      builtIn(minimal("fine"))
    ])
    expect(loaded.contributions.plugins.map((plugin) => plugin.id)).toEqual(["fine"])
    expect(loaded.refused.map((refusal) => [refusal.plugin, refusal.reason])).toEqual([
      [undefined, "invalid"],
      [undefined, "invalid"],
      [undefined, "invalid"],
      [undefined, "invalid"],
      [undefined, "invalid"],
      ["bad", "invalid"]
    ])
    expect(loaded.refused[5]!.path).toBe("extra")
    expect(loaded.refused[0]!.path).toBeUndefined()
  })

  it("refuses an unreadable or unmet api range", async () => {
    expect(
      await refusals([
        builtIn(minimal("later", { requires: { api: "^2.0.0" } })),
        builtIn(minimal("fuzzy", { requires: { api: "1.x" } }))
      ])
    ).toEqual([["fuzzy", "range_unreadable", "requires.api"], ["later", "incompatible", "requires.api"]])
  })

  it("refuses both plugins that share an id, never last-writer-wins", async () => {
    const { contributions, refused } = await load([builtIn(minimal("dup")), builtIn(minimal("dup"))])
    expect(contributions.plugins).toEqual([])
    expect(refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.path])).toEqual([
      ["dup", "conflict", "id"],
      ["dup", "conflict", "id"]
    ])
  })

  it("orders by requires.plugins, ties by id, and refuses cycles and what waits on them", async () => {
    const requires = (plugins: Record<string, string>) => ({ requires: { api: "^1.0.0", plugins } })
    const { contributions, refused } = await load([
      builtIn(minimal("zeta")),
      builtIn(minimal("alpha", requires({ zeta: "^1.0.0" }))),
      builtIn(minimal("one", requires({ two: "*" }))),
      builtIn(minimal("two", requires({ one: "*" }))),
      builtIn(minimal("three", requires({ one: "*", two: "*" })))
    ])
    expect(contributions.plugins.map((plugin) => plugin.id)).toEqual(["zeta", "alpha"])
    expect(refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.path])).toEqual([
      ["one", "cycle", "requires.plugins"],
      ["three", "missing_dependency", "requires.plugins"],
      ["two", "cycle", "requires.plugins"]
    ])
  })

  it("refuses a missing, refused or out-of-range dependency", async () => {
    const requires = (plugins: Record<string, string>) => ({ requires: { api: "^1.0.0", plugins } })
    expect(
      await refusals(
        [
          builtIn(minimal("base")),
          builtIn(minimal("ghostly", requires({ ghost: "*" }))),
          builtIn(
            minimal("broken", {
              contributes: {
                cards: [{ kind: "broken/c", payload: {}, sizes: [], render: { kind: "blocks", blocks: [] } }]
              }
            })
          ),
          builtIn(minimal("leans", requires({ broken: "*" }))),
          builtIn(minimal("newer", requires({ base: "^2.0.0" }))),
          builtIn(minimal("vague", requires({ base: "1.x" })))
        ]
      )
    ).toEqual([
      ["broken", "unsupported_point", "contributes.cards"],
      ["ghostly", "missing_dependency", "requires.plugins.ghost"],
      ["leans", "missing_dependency", "requires.plugins.broken"],
      ["newer", "incompatible", "requires.plugins.base"],
      ["vague", "range_unreadable", "requires.plugins.base"]
    ])
  })

  it("refuses a reserved plugin id", async () => {
    expect(await refusals([builtIn(minimal("app"))])).toEqual([["app", "reserved", "id"]])
  })

  it("refuses a point the host does not fold, and accepts an empty one", async () => {
    expect(await queueWith(() => {}, host({ points: ["views", "slots", "commands"] }))).toEqual([
      ["queue", "unsupported_point", "contributes.keybindings"]
    ])
    expect(
      await refusals(
        [
          builtIn(minimal("cards", { contributes: { cards: [] } })),
          builtIn(
            minimal("carded", {
              contributes: {
                cards: [{ kind: "carded/c", payload: {}, sizes: [], render: { kind: "blocks", blocks: [] } }]
              }
            })
          )
        ],
        host({ points: ["cards"] })
      )
    ).toEqual([["carded", "unsupported_point", "contributes.cards"]])
  })

  it("refuses owned flows on a host that does not load them", async () => {
    expect(
      await refusals([
        builtIn(minimal("dirs", { flows: ["flows"] })),
        builtIn(minimal("names", { owns: ["triage"] })),
        builtIn(minimal("given"), [owned("given/flow")])
      ])
    ).toEqual([
      ["dirs", "unsupported_point", "flows"],
      ["given", "unsupported_point", "flows"],
      ["names", "unsupported_point", "flows"]
    ])
  })

  describe("on a host that loads flows", () => {
    const flowsHost = (catalog: ReadonlyArray<readonly [string, Load.FlowFacts]> = []) =>
      host({
        points: ["views", "slots", "commands", "keybindings", "flows"],
        catalog: new Map([...host().catalog, ...catalog])
      })

    it("refuses an owned flow that is reserved, a system flow, already in the catalog or owned twice", async () => {
      const notify = owned("notify/send", { system: true })
      const triage = owned("triage/go")
      expect(
        await refusals(
          [
            builtIn(minimal("reserves", { flows: ["flows"] }), [owned("run/mine")]),
            builtIn(minimal("systemic", { flows: ["flows"] }), [notify]),
            builtIn(minimal("catalogued", { flows: ["flows"] }), [triage]),
            builtIn(minimal("twice", { flows: ["flows"] }), [owned("twice/x"), owned("twice/x")]),
            builtIn(minimal("first", { flows: ["flows"] }), [owned("shared/flow")]),
            builtIn(minimal("second", { flows: ["flows"] }), [owned("shared/flow")])
          ],
          flowsHost([["notify/send", notify], ["triage/go", triage]])
        )
      ).toEqual([
        ["catalogued", "conflict", "flows"],
        ["reserves", "reserved", "flows"],
        ["second", "conflict", "flows"],
        ["systemic", "conflict", "flows"],
        ["twice", "conflict", "flows"]
      ])
    })

    it("loads a plugin that uses another plugin's flow, with userOnly naming its person-only flows", async () => {
      const { contributions, refused } = await load(
        [
          builtIn(
            minimal("owner", { owns: ["mine"], userOnly: { "owner/mine": "Only the person decides." } }),
            [owned("owner/mine", { modelInvocable: false })]
          ),
          builtIn(
            minimal("borrower", {
              requires: { api: "^1.0.0", plugins: { owner: "^1.0.0" } },
              uses: ["owner/mine"],
              contributes: { commands: [{ id: "borrower/go", flow: "owner/mine", title: "Go", minimum: "anyone" }] }
            })
          )
        ],
        flowsHost()
      )
      expect(refused).toEqual([])
      expect(contributions.plugins.map((plugin) => [plugin.id, plugin.owns])).toEqual([
        ["owner", ["owner/mine"]],
        ["borrower", []]
      ])
      expect(contributions.commands).toMatchObject([{ id: "borrower/go", flow: "owner/mine", plugin: "borrower" }])
    })

    it("refuses capabilities past the ceiling or the tier, and a userOnly that disagrees", async () => {
      const fetching = owned("fetcher/get", { capabilities: ["net:fetch"] })
      expect(
        await refusals(
          [
            builtIn(minimal("fetcher", { flows: ["flows"] }), [fetching]),
            builtIn(minimal("caller", { uses: ["remote/fetch"] })),
            { tier: "repository", manifest: minimal("writer", { capabilities: ["write:repo"] }) },
            builtIn(minimal("silent", { flows: ["flows"] }), [owned("silent/ask", { modelInvocable: false })])
          ],
          flowsHost([["remote/fetch", owned("remote/fetch", { capabilities: ["net:fetch"] })]])
        )
      ).toEqual([
        ["caller", "capability_exceeded", "uses[0]"],
        ["fetcher", "capability_exceeded", "flows"],
        ["silent", "invalid", "userOnly"],
        ["writer", "capability_exceeded", "capabilities[0]"]
      ])
      const { refused } = await load(
        [{ tier: "repository", manifest: minimal("reader", { capabilities: ["read:repo"] }) }],
        flowsHost()
      )
      expect(refused).toEqual([])
    })
  })

  it("refuses an undeclared use, in uses or in a contribution", async () => {
    expect(await queueWith((manifest) => manifest.uses.push("ghost/flow"))).toEqual([
      ["queue", "undeclared_use", "uses[2]"]
    ])
    expect(await queueWith((manifest) => manifest.uses.pop())).toEqual([
      ["queue", "undeclared_use", "contributes.commands[0].flow"]
    ])
  })

  it("refuses a schema outside the closed subset or one that collects a secret", async () => {
    expect(await queueWith((manifest) => (manifest.$defs.Option.format = "date"))).toEqual([
      ["queue", "schema_unresolved", "$defs.Option.format"]
    ])
    expect(
      await queueWith((manifest) => (manifest.contributes.views[0].events[0].payload = { $ref: "#/$defs/Missing" }))
    ).toEqual([["queue", "schema_unresolved", "contributes.views[0].events[0].payload.$ref"]])
    expect(
      await queueWith((manifest) => (manifest.contributes.views[0].events[0].payload = { $ref: "https://x.test/s" }))
    ).toEqual([["queue", "schema_unresolved", "contributes.views[0].events[0].payload.$ref"]])
    expect(await queueWith((manifest) => (manifest.$defs.Note.properties.token = { type: "string" }))).toEqual([
      ["queue", "secret_field", "$defs.Note.properties.token"]
    ])
  })

  it("refuses a contribution id outside the plugin's namespace or taken twice", async () => {
    expect(await queueWith((manifest) => (manifest.contributes.views[0].id = "other/queue"))).toEqual([
      ["queue", "invalid", "contributes.views[0].id"]
    ])
    expect(await queueWith((manifest) => (manifest.contributes.commands[0].id = "core/open"))).toEqual([
      ["queue", "reserved", "contributes.commands[0].id"]
    ])
    expect(await queueWith((manifest) => (manifest.contributes.slots[0].id = "queue/queue"))).toEqual([
      ["queue", "conflict", "contributes.slots[0].id"]
    ])
  })

  it("refuses a view whose minimum is below a flow it dispatches", async () => {
    expect(await queueWith((manifest) => (manifest.contributes.views[0].minimum = "guest"))).toEqual([
      ["queue", "minimum_below_flow", "contributes.views[0].minimum"]
    ])
  })

  it("refuses a query the plugin may not read, and accepts its own", async () => {
    expect(await queueWith((manifest) => manifest.contributes.views[0].reads.push("other/rows"))).toEqual([
      ["queue", "invalid", "contributes.views[0].reads[1]"]
    ])
    expect(await queueWith((manifest) => manifest.contributes.slots[0].reads.push("queue/mine"))).toEqual([])
  })

  it("refuses a component render outside the build", async () => {
    expect(await refusals([{ tier: "repository", manifest: queueManifest() }])).toEqual([
      ["queue", "unsupported_point", "contributes.views[0].render"]
    ])
    const slotOnly = minimal("slotted", {
      contributes: {
        slots: [{ slot: "shell.nav", id: "slotted/nav", minimum: "anyone", render: { kind: "component", export: "X" } }]
      }
    })
    expect(await refusals([{ tier: "personal", manifest: slotOnly }])).toEqual([
      ["slotted", "unsupported_point", "contributes.slots[0].render"]
    ])
  })

  it("refuses an event declared twice", async () => {
    expect(await queueWith((manifest) => (manifest.contributes.views[0].events[5].name = "next"))).toEqual([
      ["queue", "conflict", "contributes.views[0].events[5].name"]
    ])
  })

  it("refuses args that reference a field the reads or the payload lack", async () => {
    const args = (edit: (args: any) => void) =>
      queueWith((manifest) => edit(manifest.contributes.views[0].events[0].args))
    expect(await args((value) => (value.runId = "$item.nope"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.runId"]
    ])
    expect(await args((value) => (value.runId = "$item"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.runId"]
    ])
    expect(await args((value) => (value.runId = "$event.nope"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.runId"]
    ])
    expect(await args((value) => (value.value = "$item.options[$event.nope]"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.value"]
    ])
    expect(await args((value) => (value.value = "$key.nope"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.value"]
    ])
    expect(await args((value) => (value.value = "$bogus"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.value"]
    ])
    expect(await args((value) => (value.extra = 1))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.extra"]
    ])
    expect(await args((value) => (value.value = "$key.index"))).toEqual([])
  })

  it("checks a reference's whole path against the row and payload schemas", async () => {
    const args = (edit: (args: any) => void) =>
      queueWith((manifest) => edit(manifest.contributes.views[0].events[0].args))
    expect(await args((value) => (value.runId = "$item.runId.length"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.runId"]
    ])
    expect(await args((value) => (value.value = "$item.options.length"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.value"]
    ])
    expect(await args((value) => (value.value = "$item.version[0]"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.value"]
    ])
    expect(await args((value) => (value.value = "$event.index.x"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.value"]
    ])
    expect(await args((value) => (value.value = "$item.options[0]"))).toEqual([])
  })

  it("checks literal args against the flow's payload, and that every required field is filled", async () => {
    const args = (edit: (args: any) => void) =>
      queueWith((manifest) => edit(manifest.contributes.views[0].events[0].args))
    expect(await args((value) => (value.version = "three"))).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args.version"]
    ])
    expect(await args((value) => (value.version = 3))).toEqual([])
    expect(await args((value) => delete value.execution)).toEqual([
      ["queue", "invalid", "contributes.views[0].events[0].args"]
    ])
  })

  it("treats a flow payload without required as requiring nothing, and refuses fields an event has no payload for", async () => {
    const facts = (payload?: any): Load.FlowFacts => ({
      capabilities: [],
      minimum: "anyone",
      personOnly: false,
      system: false,
      ...(payload === undefined ? {} : { payload })
    })
    const manifest = (fields?: Record<string, unknown>) =>
      minimal("notes", {
        uses: ["notes/add"],
        contributes: {
          views: [{
            id: "notes/list",
            title: "Notes",
            scope: "app",
            path: "notes",
            sizes: ["full"],
            minimum: "anyone",
            render: { kind: "blocks", blocks: [] },
            events: [{ name: "add", flow: "notes/add", args: { text: "hello" } }]
          }],
          keybindings: [{
            key: "n",
            event: "add",
            when: "view == notes/list",
            ...(fields === undefined ? {} : { fields })
          }]
        }
      })
    const named = host({ catalog: new Map([["notes/add", facts({ properties: { text: {} } })]]) })
    expect(await refusals([builtIn(manifest())], named)).toEqual([])
    expect(await refusals([builtIn(manifest({ text: "x" }))], named)).toEqual([
      ["notes", "invalid", "contributes.keybindings[0].fields.text"]
    ])
  })

  it("loads a flow event with no payload whose flow declares none", async () => {
    const notes = { capabilities: [], minimum: "anyone" as const, personOnly: false, system: false }
    const { contributions, refused } = await load(
      [
        builtIn(
          minimal("notes", {
            uses: ["notes/add"],
            contributes: {
              views: [{
                id: "notes/list",
                title: "Notes",
                scope: "app",
                path: "notes",
                sizes: ["full"],
                minimum: "anyone",
                render: { kind: "blocks", blocks: [] },
                events: [{ name: "add", flow: "notes/add", args: { anything: "goes" } }]
              }, {
                id: "notes/empty",
                title: "Empty",
                scope: "repository",
                path: "empty",
                sizes: ["inline"],
                minimum: "anyone",
                render: { kind: "view", module: "views/empty.tsx" }
              }],
              commands: [{ id: "notes/add", flow: "notes/add", title: "Add", minimum: "anyone", args: { x: 1 } }],
              keybindings: [{ key: "n", event: "add", when: "view == notes/list" }]
            }
          })
        )
      ],
      host({ catalog: new Map([["notes/add", notes]]) })
    )
    expect(refused).toEqual([])
    expect(contributions.views.map((view) => view.events)).toEqual([[{
      name: "add",
      flow: "notes/add",
      args: { anything: "goes" },
      personOnly: false
    }], []])
    expect(contributions.keybindings).toMatchObject([{ event: "add", fields: {}, personOnly: false }])
  })

  it("refuses a slot whose when is outside the grammar, and a seventh header entry", async () => {
    expect(await queueWith((manifest) => (manifest.contributes.slots[0].when = "item.a || item.b"))).toEqual([
      ["queue", "invalid", "contributes.slots[0].when"]
    ])
    expect(await queueWith((manifest) => (manifest.contributes.slots[0].when = "view == queue/queue"))).toEqual([])
    const headers = (id: string, count: number) =>
      minimal(id, {
        contributes: {
          slots: Array.from({ length: count }, (_, index) => ({
            slot: "shell.header",
            id: `${id}/h${index}`,
            order: count - index,
            minimum: "anyone",
            render: { kind: "blocks", blocks: [] }
          }))
        }
      })
    const { contributions, refused } = await load([builtIn(headers("aa", 4)), builtIn(headers("bb", 3))])
    expect(refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.path])).toEqual([
      ["bb", "conflict", "contributes.slots[2].slot"]
    ])
    expect(contributions.slots.map((slot) => slot.id)).toEqual(["aa/h3", "aa/h2", "aa/h1", "aa/h0"])
    expect((await load([builtIn(headers("aa", 3)), builtIn(headers("bb", 3))])).refused).toEqual([])
  })

  it("sorts slots by slot, then order (absent is 0), then id", async () => {
    const slot = (name: string, id: string, order?: number) => ({
      slot: name,
      id,
      minimum: "anyone",
      render: { kind: "blocks", blocks: [] },
      ...(order === undefined ? {} : { order })
    })
    const { contributions } = await load([
      builtIn(minimal("ss", {
        contributes: {
          slots: [
            slot("repo.tabs", "ss/tab", 5),
            slot("shell.nav", "ss/b"),
            slot("shell.nav", "ss/a"),
            slot("shell.nav", "ss/neg", -1),
            slot("shell.nav", "ss/c"),
            slot("shell.nav", "ss/z", 0),
            slot("branch.pane", "ss/pane")
          ]
        }
      }))
    ])
    expect(contributions.slots.map((entry) => entry.id)).toEqual([
      "ss/pane",
      "ss/tab",
      "ss/neg",
      "ss/a",
      "ss/b",
      "ss/c",
      "ss/z"
    ])
  })

  it("refuses command args that bind, fail the flow's payload, or a slash name taken twice", async () => {
    const command = (edit: (command: any) => void) => queueWith((manifest) => edit(manifest.contributes.commands[0]))
    expect(await command((value) => (value.args = { to: "$item.runId" }))).toEqual([
      ["queue", "invalid", "contributes.commands[0].args"]
    ])
    expect(await command((value) => (value.args = { to: 5 }))).toEqual([
      ["queue", "invalid", "contributes.commands[0].args"]
    ])
    expect(await command((value) => delete value.args)).toEqual([["queue", "invalid", "contributes.commands[0].args"]])
    expect(
      await queueWith((manifest) =>
        manifest.contributes.commands.push({ ...manifest.contributes.commands[0], id: "queue/again" })
      )
    ).toEqual([["queue", "conflict", "contributes.commands[1].slash.name"]])
    expect(await command((value) => delete value.slash)).toEqual([])
    const other = minimal("other", {
      uses: ["app/navigate"],
      contributes: {
        commands: [{
          id: "other/open",
          flow: "app/navigate",
          args: { to: "/" },
          title: "Other",
          minimum: "anyone",
          slash: { name: "queue" }
        }]
      }
    })
    expect(await refusals([builtIn(queueManifest()), builtIn(other)])).toEqual([
      ["queue", "conflict", "contributes.commands[0].slash.name"]
    ])
    // A name the host's own commands hold is taken too: a plugin never shadows a core command.
    expect(await refusals([builtIn(queueManifest())], { ...host(), slash: ["queue"] })).toEqual([
      ["queue", "conflict", "contributes.commands[0].slash.name"]
    ])
    expect(await refusals([builtIn(queueManifest())], { ...host(), slash: ["status"] })).toEqual([])
  })

  it("refuses a keybinding outside the key or when grammar, or naming nothing declared", async () => {
    const binding = (index: number, edit: (binding: any) => void) =>
      queueWith((manifest) => edit(manifest.contributes.keybindings[index]))
    expect(await binding(0, (value) => (value.key = "g g g"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[0].key"]
    ])
    expect(await binding(1, (value) => (value.when = "item.a || item.b"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].when"]
    ])
    expect(await binding(0, (value) => (value.command = "queue/nope"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[0].command"]
    ])
    expect(await binding(5, (value) => (value.when = "!focus.input"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[5].when"]
    ])
    expect(await binding(5, (value) => (value.when = "view == queue/other"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[5].when"]
    ])
    expect(await binding(5, (value) => (value.event = "nope"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[5].event"]
    ])
  })

  it("refuses an event key whose fields are not the event's, or not from $key.index on a digit", async () => {
    const binding = (index: number, edit: (binding: any) => void) =>
      queueWith((manifest) => edit(manifest.contributes.keybindings[index]))
    expect(await binding(1, (value) => (value.fields.bogus = 1))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.bogus"]
    ])
    expect(await binding(1, (value) => (value.fields.index = "$item.version"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.index"]
    ])
    expect(await binding(1, (value) => (value.key = "x"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.index"]
    ])
    expect(await binding(1, (value) => (value.fields.index = "$nope"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.index"]
    ])
    expect(await binding(5, (value) => (value.fields = { index: 1 }))).toEqual([
      ["queue", "invalid", "contributes.keybindings[5].fields.index"]
    ])
  })

  it("checks a key's fields against the event's payload, every digit $key.index can fill included", async () => {
    const digit = (edit: (manifest: any) => void) => queueWith(edit)
    expect(await digit((manifest) => (manifest.contributes.keybindings[1].fields.index = "bad"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.index"]
    ])
    expect(await digit((manifest) => (manifest.contributes.keybindings[1].fields.index = 9))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.index"]
    ])
    expect(
      await digit((manifest) => {
        manifest.contributes.keybindings[1].key = "x"
        manifest.contributes.keybindings[1].fields.index = 3
      })
    ).toEqual([])
    expect(await digit((manifest) => (manifest.$defs.Option.properties.index.maximum = 5))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.index"]
    ])
    expect(await digit((manifest) => (manifest.$defs.Option.properties.index.type = "string"))).toEqual([
      ["queue", "invalid", "contributes.keybindings[1].fields.index"]
    ])
  })

  it("lets only a built-in's command run a person-only flow: a plugin can't dress a person-only act as a command", async () => {
    const answering = (tier: Contribution.Tier) =>
      ({
        tier,
        manifest: minimal("asker", {
          uses: ["run/answer"],
          contributes: {
            commands: [{
              id: "asker/go",
              flow: "run/answer",
              title: "Open",
              minimum: "member",
              args: { runId: "r", version: 1, execution: "e", value: "yes" }
            }]
          }
        })
      }) as Load.Candidate
    expect(await refusals([answering("repository")])).toEqual([["asker", "invalid", "contributes.commands[0].flow"]])
    expect(await refusals([answering("personal")])).toEqual([["asker", "invalid", "contributes.commands[0].flow"]])
    expect(await refusals([answering("built-in")])).toEqual([])
  })

  it("refuses a key bound to another plugin's command: it would run a flow outside the binder's uses", async () => {
    const borrower = minimal("zz", { contributes: { keybindings: [{ key: "z", command: "queue/open" }] } })
    const { contributions, refused } = await load([builtIn(borrower), builtIn(queueManifest())])
    expect(refused.map((refusal) => [refusal.plugin, refusal.reason, refusal.path])).toEqual([
      ["zz", "invalid", "contributes.keybindings[0].command"]
    ])
    expect(contributions.plugins.map((plugin) => plugin.id)).toEqual(["queue"])
  })
})
