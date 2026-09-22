# Fixture: `jsx-single.migrated`

The hand-written 1.0 output for the `jsx-single` fixture. `Checks.run` and `Checks.discovery` run against it, so it is the definition of a clean migration: no old import, no JSX pragma, no React under `flows/`, no escape hatch, no scheduler loop, no direct database access, a `description` the registry can read, and a warning-free discovery scan.

Origin: written by hand from `jsx-single/simple-workflow.jsx`, following `examples/src/11-agent-step.ts` in the flows tree. The `<Workflow>` element declares no payload schema, so `Mapping.snippet` gives it no rewrite and the flow's `payload` is the one decision a person makes here; every other line is the shape `Mapping.snippet` emits.

`flows/simple-workflow/flow.ts` carries one declaration: the default export, a `@smthrs/flow` `Flow.make(tag, { description, capabilities, effects, payload, success, error, body })`. `Discovery` reads the literal token sequence `export default Flow.make(` and takes the `description`, `capabilities` and `effects` out of the options object without evaluating the module; `Executable` loads that same default export and hands it to the engine. One declaration is therefore one contract: what the control plane admits is what runs. The old `<Sequence>` of two `<Task agent>` elements is one `Node.bindPlanned` over two `AgentAction`s.

`test/MigratedFixture.test.ts` and `test/Checks.test.ts` pin the executed half by building the flow and finding the two agent calls with the second waiting on the first and the `Article` success schema, and `test/MigratedFixture.test.ts` also loads it through the registry's `Executable` path with no registered delegates, which is what a host does.

Each `seat` is the model the source names: `jsx-single/simple-workflow.jsx` builds both agents with `anthropic("claude-sonnet-5")`, so both steps read `seat: "anthropic:claude-sonnet-5"`. The tool has no default seat, and `Checks.run` fails a migrated file whose seat literal does not appear in the unit's source.

The two MDX prompts became template literals on the two `AgentAction`s, which is why the fixture has no `prompts/` directory. The zod schemas became `effect/Schema` structs. The migrated project has no bun preload, no `bunfig.toml`, and no `mdx-assets.d.ts`: those three configured the MDX loader, and a template literal on an `AgentAction` needs no loader.
