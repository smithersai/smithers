/*
 * Mock: Plugin kernel. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.plugins`. Self-contained on purpose — see ../Pane.ts.
 *
 * Vite's plugin model with hooks as ordinary Effects. Every plugin bug is an
 * ordering bug, and the order is not the one the plugin list reads: `enforce`
 * sorts the plugins once into pre / normal / post, then a hook's own `order`
 * re-partitions that list for that hook alone, so a `{ order: "pre" }` handler
 * on an `enforce: "post"` plugin runs first. That inversion is what this
 * draws, beside the rank inputs it came from and the copy the resolution
 * boundary made. Names are `@smthrs/plugin`'s: FlowsHooks, HookKind,
 * HandlerRecord, rank, Config.merge, Boundary.admit, PluginErrorCode.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Facts, Rail, Section, Split, Steps, Table, type Tone } from "../Primitives"

interface Handler {
  readonly id: string
  readonly plugin: string
  readonly enforce: string
  readonly order: string
  readonly index: number
  readonly note: string
  readonly tone: Tone
}

interface Hook {
  readonly id: string
  readonly kind: string
  readonly handlers: ReadonlyArray<Handler>
  readonly resolution: ReadonlyArray<{ readonly id: string; readonly path: string; readonly value: string; readonly plugin: string }>
  readonly errors: ReadonlyArray<{ readonly id: string; readonly code: string; readonly plugin: string; readonly path: string }>
}

const PLUGINS = [
  { id: "cache", label: "flows-plugin-cache", note: "pre", tone: "info" as const },
  { id: "tevm", label: "flows-plugin-tevm", note: "normal", tone: "muted" as const },
  { id: "panes", label: "flows-plugin-ui-panes", note: "normal", tone: "muted" as const },
  { id: "audit", label: "flows-plugin-audit", note: "post", tone: "warn" as const }
]

const HOOKS: ReadonlyArray<Hook> = [
  {
    id: "config",
    kind: "waterfall",
    handlers: [
      { id: "1", plugin: "flows-plugin-cache", enforce: "pre", order: "—", index: 0, note: "{ cache }", tone: "info" },
      { id: "2", plugin: "flows-plugin-tevm", enforce: "normal", order: "—", index: 1, note: "{ tools }", tone: "muted" },
      { id: "3", plugin: "flows-plugin-audit", enforce: "post", order: "—", index: 3, note: "{ audit, cache }", tone: "warn" }
    ],
    resolution: [
      { id: "a", path: "cache.remote", value: "false", plugin: "flows-plugin-audit" },
      { id: "b", path: "cache.dir", value: ".smithers/cache", plugin: "flows-plugin-cache" },
      { id: "c", path: "tools.network", value: "true", plugin: "flows-plugin-tevm" },
      { id: "d", path: "audit.sink", value: "flows_journal_events", plugin: "flows-plugin-audit" }
    ],
    errors: []
  },
  {
    id: "configResolved",
    kind: "parallel",
    handlers: [
      { id: "1", plugin: "flows-plugin-cache", enforce: "pre", order: "—", index: 0, note: "ok", tone: "ok" },
      { id: "2", plugin: "flows-plugin-tevm", enforce: "normal", order: "—", index: 1, note: "ok", tone: "ok" },
      { id: "3", plugin: "flows-plugin-ui-panes", enforce: "normal", order: "—", index: 2, note: "ok", tone: "ok" },
      { id: "4", plugin: "flows-plugin-audit", enforce: "post", order: "—", index: 3, note: "hook_failed", tone: "bad" }
    ],
    resolution: [],
    errors: [
      { id: "e1", code: "hook_failed", plugin: "flows-plugin-audit", path: "audit.sink" }
    ]
  },
  {
    id: "cellRegistry",
    kind: "waterfall",
    handlers: [
      { id: "1", plugin: "flows-plugin-tevm", enforce: "normal", order: "—", index: 1, note: "+9 flows", tone: "muted" },
      { id: "2", plugin: "flows-plugin-ui-panes", enforce: "normal", order: "—", index: 2, note: "+6 flows", tone: "muted" }
    ],
    resolution: [
      { id: "a", path: "registry", value: "15 flows", plugin: "flows-plugin-ui-panes" }
    ],
    errors: []
  },
  {
    id: "cellFlows",
    kind: "waterfall",
    handlers: [
      { id: "1", plugin: "flows-plugin-audit", enforce: "post", order: "pre", index: 3, note: "12 bindings", tone: "warn" },
      { id: "2", plugin: "flows-plugin-cache", enforce: "pre", order: "—", index: 0, note: "12 bindings", tone: "info" },
      { id: "3", plugin: "flows-plugin-tevm", enforce: "normal", order: "—", index: 1, note: "18 bindings", tone: "muted" },
      { id: "4", plugin: "flows-plugin-ui-panes", enforce: "normal", order: "—", index: 2, note: "21 bindings", tone: "muted" }
    ],
    resolution: [
      { id: "a", path: "bindings", value: "21", plugin: "flows-plugin-ui-panes" },
      { id: "b", path: "bindings[0]", value: "audit/record", plugin: "flows-plugin-audit" }
    ],
    errors: []
  },
  {
    id: "cellModelRequest",
    kind: "waterfall",
    handlers: [
      { id: "1", plugin: "flows-plugin-cache", enforce: "pre", order: "—", index: 0, note: "cache hint", tone: "info" },
      { id: "2", plugin: "flows-plugin-audit", enforce: "post", order: "—", index: 3, note: "+1 system line", tone: "warn" }
    ],
    resolution: [
      { id: "a", path: "system", value: "4 lines", plugin: "flows-plugin-audit" },
      { id: "b", path: "seat", value: "openai:gpt-6-sol", plugin: "flows-plugin-cache" }
    ],
    errors: []
  }
]

const KIND_TONE: Readonly<Record<string, Tone>> = {
  waterfall: "info",
  parallel: "muted",
  first: "ok",
  sequential: "muted"
}

export const Pane = pane({
  id: "plugins",
  title: "Plugin kernel",
  summary: "Hook order and which plugin won a resolution",
  packages: ["@smthrs/plugin"],
  render: (context) => <PluginsBody {...context} />
})

function PluginsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const hook = typeof props.hook === "string" ? props.hook : "cellFlows"
  const selected = HOOKS.find((row) => row.id === hook) ?? HOOKS[0]
  return (
    <Split
      left={
        <>
          <Section title="Plugins" right={<Badge tone="muted">4</Badge>}>
            <Rail items={PLUGINS} />
          </Section>
          <Section title="Hooks">
            <Rail
              items={HOOKS.map((row) => ({
                id: row.id,
                label: row.id,
                note: row.kind,
                tone: KIND_TONE[row.kind] ?? "muted"
              }))}
              selected={hook}
              onSelect={(id) => runCommandSet("hook", id)}
            />
          </Section>
        </>
      }
      right={
        <>
          <Section title={selected.id} right={<Badge tone={KIND_TONE[selected.kind] ?? "muted"}>{selected.kind}</Badge>}>
            <Steps steps={selected.handlers.map((row) => ({
              id: row.id,
              label: row.plugin,
              note: row.note,
              tone: row.tone
            }))} />
          </Section>
          <Section title="Rank" right="order ▸ enforce ▸ index">
            <Table
              columns={[
                { key: "plugin", label: "Plugin", mono: true },
                { key: "order", label: "order", mono: true },
                { key: "enforce", label: "enforce", mono: true },
                { key: "index", label: "index", mono: true, right: true }
              ]}
              rows={selected.handlers.map((row) => ({
                id: row.id,
                plugin: row.plugin,
                order: row.order === "pre" ? <Badge tone="warn">pre</Badge> : row.order,
                enforce: row.enforce,
                index: row.index
              }))}
            />
          </Section>
          {selected.errors.length > 0
            ? (
              <Section title="PluginError" right={<Badge tone="bad">1</Badge>}>
                <Table
                  columns={[
                    { key: "code", label: "code", mono: true },
                    { key: "plugin", label: "plugin", mono: true },
                    { key: "path", label: "path", mono: true }
                  ]}
                  rows={selected.errors}
                />
              </Section>
            )
            : (
              <Section title="Resolution" right="last non-void wins">
                <Table
                  columns={[
                    { key: "path", label: "Path", mono: true },
                    { key: "value", label: "Value", mono: true },
                    { key: "plugin", label: "Won by", mono: true }
                  ]}
                  rows={selected.resolution}
                />
              </Section>
            )}
          <Section title="Boundary" right={<Badge tone="ok">copied</Badge>}>
            <Facts rows={[
              { label: "admit", value: "BoundedJson.admitStrict · detached, then frozen" },
              { label: "ownData", value: "enumerable data properties; accessors never invoked" },
              { label: "snapshot", value: "4 plugin records · 13 hook objects", mono: true },
              { label: "admittedConfigs", value: "WeakSet · reuse hit", mono: true },
              { label: "parallelConcurrency", value: 16, mono: true },
              { label: "identity", value: "flows/cell-composition/v1:8c41…d7e0", mono: true }
            ]} />
          </Section>
        </>
      }
    />
  )
}
