# 0009. One command registry, three agent surfaces

**Status:** accepted, 2026-11-07. **Rulings:** VL-5, VL-7, VL-10, VL-13, VL-14, VL-26.

**Decision.** `src/surfaces/commands.vibe` owns each command's name, description, Effect Schema input and output,
CLI parameters, handler and text rendering. `ask` and `read` are defined once. The CLI (`effect/cli`), stdio MCP
server (`effect/ai`'s `McpServer` and `Toolkit`) and `--llms` Markdown manifest derive from that registry. The
CLI skill is `skills/vibelang-factory/SKILL.md`. No new runtime package is added. The library catalog's CLI entry
is the Smithers control CLI; these app-specific Factory commands use Effect's own CLI and AI modules as VL-10 asks.
The existing `@effect/platform-node` host adapter supplies Node services at the executable boundaries.

**Commands.** `ask <text> [--conversation <id>]` posts through `Factory` and follows numbered events until the
matching reply finishes or fails. It returns `conversation`, completed reply `text` and `events` (the post's event
number plus every event of its reply). Each call generates a fresh client id with Effect's `IdGenerator`. Replies
start in post order, as the mock agent's queue already guarantees (0004); replaying from zero matches earlier queued
posts before matching this call. A live layer must preserve that ordering contract. Independent conversations are
isolated. A refused post and a failed reply are typed failures, never successful partial output.

`read [--after <seq>] [--conversation <id>]` returns immediately with `conversation`, `seq` (the snapshot's event
cursor) and `entries`: current copies of messages touched by an event strictly after `after`. This includes updates
to replies created before the cursor. Merge by entry `id`; then advance the cursor. The default conversation is
`home` and the default cursor is zero. Negative, fractional and unsafe cursors fail Schema validation.

**Finite reads belong to Factory.** An event stream cannot distinguish an empty snapshot from waiting for another
event. `Factory.read(conversation, after)` therefore adds a finite read to the core service. `MockFactory` reads its
existing sequencer state and event log in one Ref read, selects touched ids and returns their current entries. No
state-machine transition changes; every write still uses `decide` and `apply` (0003, 0005). The later live layer
implements this same snapshot method as well as `post` and `events`.

**Backend choice is at the edge.** `--mock` or `VIBELANG_FACTORY=mock` selects `MockFactory`; otherwise a layer fails
with typed `LiveBackendNotDeployed`: “The live Factory backend is not deployed yet. Use --mock or
VIBELANG_FACTORY=mock.” Roadmap 1b replaces that layer and exposes the live selection flag. Neither handlers nor
schemas change. An MCP process builds one Factory for all its tool calls. A separate CLI invocation has a fresh
mock world; the skill and manifest state this explicitly. There is no invented disk persistence.

**Boundaries.** Only the `.ts` executable entries read process arguments/environment or run the program. All Effect
logic is `.vibe`. Emission uses `tsconfig.surfaces.json` into ignored `dist-factory/`; the package bin is
`dist-factory/surfaces/cli-entry.js`. `pnpm cli ...` and `pnpm mcp --mock` build before running. MCP build logs
go to stderr, leaving stdout for NDJSON-RPC. `--json` emits just the declared result; failures go to stderr with a
nonzero exit. `--help` and `--llms` need no backend. The local pnpm workspace preserves the owning workspace's
explicit no-build-script policy and already-approved first-party release-age exceptions; setup remains independent
of the monorepo's older Effect version. `@types/node` is an explicit development dependency for the Node entries.

**Prior art.** `~/vl/ref/incur`'s README, SKILL and `src/{Cli,Mcp,Skill}.ts`: one command tree, derived tools and a
compact Markdown discovery surface. We use Effect Schema and Effect transports rather than incur's runtime stack.

**Proof.** `test/commands.test.vibe` exercises the commands through Factory with the product mock backend, including
concurrent asks, separate rooms, incremental reads, invalid input and unavailable live mode. `test/cli.test.ts`
spawns the emitted executable and checks complete text, JSON, environment selection, help, errors and exit codes;
it also validates the shipped skill. `test/mcp.test.vibe` drives the emitted stdio server through Effect's
`McpClient`, calls both tools across one shared conversation, checks protocol failures, and compares the tool list's
exact input/output schemas against the built CLI's `--llms` Markdown. No additional mock is introduced. Existing
browser tests continue to cover dark, light and phone.

**Upstream observation.** VibeLang 0.0.12 emits false-positive EK4802 warnings for Effect CLI's Effectable Commands
inside effect functions. The normal combinators are retained, with no diagnostic suppression. Minimal reproduction
and compiler receipt: `~/vl/upstream-bugs/vibelang-cli-effectable-warning/`. Typechecking still exits zero.
