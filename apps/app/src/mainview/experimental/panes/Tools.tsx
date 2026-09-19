/*
 * Mock: Tools. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.tools`. Self-contained on purpose — see ../Pane.ts.
 *
 * The question the product cannot answer today: what can the model call right
 * now, and with whose authority. Every row is one `@smthrs/std` declaration
 * (`Manifest.flows`) or one MCP tool `McpFlows` folded in from a server's
 * `tools/list`, carrying what a `@smthrs/fs` route carries: `capabilities`,
 * the `EffectDeclaration` envelope, the input schema, `modelInvocable`. The
 * debug half is the disclosure ladder: `Command.list` sees a name and a
 * description, `Disclosure.toXml` projects only the model-invocable rows, and
 * the full input schema is loaded once, at the first discovery.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Code, Facts, Rail, Section, Split, Table } from "../Primitives"

const TOOLS = [
  { id: "read", origin: "std", capabilities: "fs:read:/**", tier: "sealed", mode: "hermetic", reads: "/**", writes: "—", level: "schema", tone: "ok" as const, description: "Read a text file by 1-based offset and limit.", narrows: "reads: [input.path]" },
  { id: "write", origin: "std", capabilities: "fs:write:/**", tier: "compensable", mode: "hermetic", reads: "—", writes: "/**", level: "schema", tone: "warn" as const, description: "Write a whole text file.", narrows: "writes: [input.path]" },
  { id: "edit", origin: "std", capabilities: "fs:read:/**, fs:write:/**", tier: "compensable", mode: "hermetic", reads: "/**", writes: "/**", level: "schema", tone: "warn" as const, description: "Replace exact text in a file.", narrows: "reads/writes: [input.path]" },
  { id: "ls", origin: "std", capabilities: "fs:read:/**", tier: "sealed", mode: "hermetic", reads: "/**", writes: "—", level: "xml", tone: "ok" as const, description: "List a directory.", narrows: "reads: [rootSubtree]" },
  { id: "glob", origin: "std", capabilities: "fs:read:/**", tier: "sealed", mode: "hermetic", reads: "/**", writes: "—", level: "schema", tone: "ok" as const, description: "Find files through the Smithers Ripgrep Subset v1 contract.", narrows: "reads: [rootSubtree]" },
  { id: "grep", origin: "std", capabilities: "fs:read:/**", tier: "sealed", mode: "hermetic", reads: "/**", writes: "—", level: "schema", tone: "ok" as const, description: "Search file contents by pattern.", narrows: "reads: [rootSubtree]" },
  { id: "bash", origin: "std", capabilities: "proc:spawn:*", tier: "irreversible", mode: "expected", reads: "*", writes: "*", level: "schema", tone: "bad" as const, description: "Run a shell command, or an interpreter over a script passed as data.", narrows: "mode:hermetic ⇒ compensable" },
  { id: "test", origin: "std", capabilities: "proc:spawn:*", tier: "irreversible", mode: "expected", reads: "—", writes: "—", level: "xml", tone: "bad" as const, description: "Run a test command and attribute its exit code.", narrows: "probe/attribution" },
  { id: "shell_command", origin: "std", capabilities: "proc:spawn:*", tier: "irreversible", mode: "expected", reads: "—", writes: "—", level: "entries", tone: "bad" as const, description: "Run one named shell command.", narrows: "—" },
  { id: "apply_patch", origin: "std", capabilities: "fs:read:/**, fs:write:/**", tier: "compensable", mode: "hermetic", reads: "/**", writes: "/**", level: "xml", tone: "warn" as const, description: "Apply a patch across files.", narrows: "—" },
  { id: "update_plan", origin: "std", capabilities: "—", tier: "sealed", mode: "hermetic", reads: "—", writes: "—", level: "xml", tone: "ok" as const, description: "Record the run's plan steps.", narrows: "—" },
  { id: "fetch", origin: "std", capabilities: "net:get:*", tier: "sealed", mode: "expected", reads: "—", writes: "—", level: "xml", tone: "ok" as const, description: "GET one URL.", narrows: "—" },
  { id: "http-post", origin: "std", capabilities: "net:post:*", tier: "irreversible", mode: "expected", reads: "—", writes: "—", level: "entries", tone: "bad" as const, description: "POST a body to one URL.", narrows: "—" },
  { id: "explore", origin: "std", capabilities: "—", tier: "sealed", mode: "hermetic", reads: "/**", writes: "—", level: "xml", tone: "muted" as const, description: "Read-only reconnaissance over read, ls, glob and grep.", narrows: "no handler — dynamic" },
  { id: "webfetch", origin: "std", capabilities: "net:get:*", tier: "sealed", mode: "expected", reads: "—", writes: "—", level: "xml", tone: "ok" as const, description: "Fetch a page as text.", narrows: "—" },
  { id: "websearch", origin: "std", capabilities: "net:post:*", tier: "sealed", mode: "expected", reads: "—", writes: "—", level: "entries", tone: "ok" as const, description: "Search the web.", narrows: "—" },
  { id: "lsp", origin: "std", capabilities: "fs:read:/**", tier: "sealed", mode: "hermetic", reads: "/**", writes: "—", level: "entries", tone: "ok" as const, description: "Ask the language server for definitions and references.", narrows: "—" },
  { id: "classify", origin: "std", capabilities: "model:call:*", tier: "sealed", mode: "expected", reads: "—", writes: "—", level: "schema", tone: "ok" as const, description: "Ask Jev a typed question about a JSON state.", narrows: "—" },
  { id: "mcp/github/create_issue", origin: "mcp", capabilities: "every action :**", tier: "irreversible", mode: "expected", reads: "**", writes: "**", level: "schema", tone: "bad" as const, description: "Create an issue in a repository.", narrows: "unprojectable authority" },
  { id: "mcp/github/get_issue", origin: "mcp", capabilities: "every action :**", tier: "irreversible", mode: "expected", reads: "**", writes: "**", level: "xml", tone: "bad" as const, description: "Read one issue.", narrows: "unprojectable authority" },
  { id: "mcp/github/list_issues", origin: "mcp", capabilities: "every action :**", tier: "irreversible", mode: "expected", reads: "**", writes: "**", level: "xml", tone: "bad" as const, description: "List a repository's issues.", narrows: "unprojectable authority" }
]

const SCHEMAS: Readonly<Record<string, string | undefined>> = {
  read: `{ "type": "object",
  "properties": {
    "path":   { "type": "string", "description": "Path of the text file to read" },
    "offset": { "type": "integer", "minimum": 1, "description": "1-based line offset" },
    "limit":  { "type": "integer", "minimum": 1, "description": "Maximum number of lines to return" }
  },
  "required": ["path"] }`,
  bash: `{ "oneOf": [
    { "type": "object",
      "properties": {
        "mode":        { "const": "hermetic", "description": "Pre-check path tokens against the declared envelope" },
        "reads":       { "type": "array", "items": { "type": "string" }, "description": "Paths or globs the command may read" },
        "writes":      { "type": "array", "items": { "type": "string" }, "description": "Paths or globs the command may write" },
        "command":     { "type": "string" },
        "script":      { "type": "string" },
        "interpreter": { "type": "string" },
        "args":        { "type": "array", "items": { "type": "string" } },
        "stdin":       { "type": "string" },
        "container":   { "type": "string" },
        "cwd":         { "type": "string" },
        "env":         { "type": "object", "additionalProperties": { "type": "string" } },
        "timeoutMs":   { "type": "number" }
      },
      "required": ["mode", "reads", "writes"] },
    { "type": "object",
      "properties": {
        "mode":        { "const": "unhermetic", "description": "No declared envelope; an irreversible effect" },
        "command":     { "type": "string" },
        "script":      { "type": "string" },
        "interpreter": { "type": "string" },
        "args":        { "type": "array", "items": { "type": "string" } },
        "stdin":       { "type": "string" },
        "container":   { "type": "string" },
        "cwd":         { "type": "string" },
        "env":         { "type": "object", "additionalProperties": { "type": "string" } },
        "timeoutMs":   { "type": "number" }
      },
      "required": ["mode"] }
  ] }`,
  classify: `{ "oneOf": [
    { "type": "object",
      "properties": {
        "state":     { "description": "Any JSON value, at most 32 KiB encoded" },
        "questions": { "$ref": "#/$defs/questions" }
      },
      "required": ["state", "questions"] },
    { "type": "object",
      "properties": {
        "states":    { "type": "array", "minItems": 1, "maxItems": 64, "description": "JSON values judged by the same questions" },
        "questions": { "$ref": "#/$defs/questions" }
      },
      "required": ["states", "questions"] }
  ],
  "$defs": {
    "questions": { "type": "object", "minProperties": 1, "description": "Keyed by the id each answer comes back under",
      "additionalProperties": { "oneOf": [
        { "properties": { "type": { "const": "boolean" }, "instructions": { "type": "string" },
                          "criteria": { "type": "object", "properties": { "true": { "type": "string" }, "false": { "type": "string" } }, "required": ["true", "false"] } },
          "required": ["type", "instructions"] },
        { "properties": { "type": { "const": "choice" }, "instructions": { "type": "string" },
                          "criteria": { "type": "object", "additionalProperties": { "type": "string" }, "minProperties": 2, "maxProperties": 255 } },
          "required": ["type", "instructions", "criteria"] },
        { "properties": { "type": { "const": "score" }, "instructions": { "type": "string" },
                          "criteria": { "type": "array", "items": { "type": "string" }, "minItems": 2 } },
          "required": ["type", "instructions", "criteria"] }
      ] } }
  } }`
}

const DEFAULT_SCHEMA = `{ "type": "object", "properties": { … } }`

const XML = `<available_skills>
  <skill>
    <name>read</name>
    <description>Read a text file by 1-based offset and limit.</description>
  </skill>
  <skill>
    <name>glob</name>
    <description>Find files through the Smithers Ripgrep Subset v1 contract.</description>
  </skill>
</available_skills>`

const LEVELS = [
  { id: "entries", label: "entries", tone: "muted" as const, note: "name + description", count: 4 },
  { id: "xml", label: "xml", tone: "info" as const, note: "modelInvocable only", count: 9 },
  { id: "schema", label: "schema", tone: "ok" as const, note: "loaded at first discovery", count: 8 }
]

const MCP = [
  { id: "server", label: "github", note: "3 of 41 tools", tone: "ok" as const },
  { id: "protocol", label: "2025-06-18", note: "handshake 84 ms", tone: "ok" as const }
]

const ROUTES = [
  { id: "read", name: "read", kind: "module", source: "@smthrs/std/Read.ts", invocable: "yes" },
  { id: "review", name: "review", kind: "markdown", source: "flows/review/flow.mdx", invocable: "yes" },
  { id: "release", name: "release/publish", kind: "skill", source: "flows/release/publish/SKILL.md", invocable: "yes" },
  { id: "draft", name: "draft", kind: "markdown", source: "flows/draft/flow.mdx", invocable: "no" }
]

export const Pane = pane({
  id: "tools",
  title: "Tools",
  summary: "Every tool the model can call, with its schema and disclosure level",
  packages: ["@smthrs/std", "@smthrs/fs", "@smthrs/registry", "@smthrs/mcp"],
  render: (context) => <ToolsBody {...context} />
})

function ToolsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const id = typeof props.id === "string" ? props.id : "bash"
  const tool = TOOLS.find((row) => row.id === id) ?? TOOLS[0]
  const schema = SCHEMAS[tool.id] ?? DEFAULT_SCHEMA
  return (
    <Split
      left={
        <>
          <Section title="Tools" right={`${TOOLS.length}`}>
            <Rail
              items={TOOLS.map((row) => ({ id: row.id, label: row.id, note: row.tier, tone: row.tone }))}
              selected={id}
              onSelect={(id) => runCommandSet("id", id)}
            />
          </Section>
          <Section title="MCP">
            <Rail items={MCP} />
          </Section>
        </>
      }
      right={
        <>
          <Section title={tool.id} right={<Badge tone={tool.tone}>{tool.tier}</Badge>}>
            <Facts rows={[
              { label: "Description", value: tool.description },
              { label: "Origin", value: tool.origin === "std" ? "Manifest.flows" : "McpFlows.mcp", mono: true },
              { label: "Capabilities", value: tool.capabilities, mono: true },
              { label: "Narrowed", value: tool.narrows, mono: true }
            ]} />
          </Section>
          <Section title="Effects" right={<Badge tone="info">{tool.mode}</Badge>}>
            <Facts rows={[
              { label: "tier", value: tool.tier, mono: true },
              { label: "mode", value: tool.mode, mono: true },
              { label: "onConflict", value: "serialize", mono: true },
              { label: "reads", value: tool.reads, mono: true },
              { label: "writes", value: tool.writes, mono: true }
            ]} />
          </Section>
          <Section title="Input schema">
            <Code label={tool.id}>{schema}</Code>
          </Section>
          <Section title="Disclosure" right={<Badge tone={tool.level === "schema" ? "ok" : tool.level === "xml" ? "info" : "muted"}>{tool.level}</Badge>}>
            <Table
              columns={[
                { key: "label", label: "Level", mono: true },
                { key: "note", label: "Carries" },
                { key: "count", label: "Tools", right: true }
              ]}
              rows={LEVELS.map((row) => ({
                id: row.id,
                label: <Badge tone={row.tone}>{row.label}</Badge>,
                note: row.note,
                count: row.count
              }))}
            />
            <Code label="Disclosure.toXml">{XML}</Code>
          </Section>
          <Section title="Routes" right="FileRouter.scan">
            <Table
              columns={[
                { key: "name", label: "Name", mono: true },
                { key: "kind", label: "Kind" },
                { key: "source", label: "Source", mono: true },
                { key: "invocable", label: "Model", right: true }
              ]}
              rows={ROUTES}
            />
          </Section>
        </>
      }
    />
  )
}
