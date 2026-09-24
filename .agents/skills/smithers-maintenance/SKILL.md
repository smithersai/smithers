---
name: smithers-maintenance
description: Work on Smithers workspace graph, generated documentation, benchmark or eval evidence, or durable flow authoring in this repository.
---

# Smithers maintenance

Use the owning source and current docs on the revision being changed. The installed `smthrs --help` and `--schema` decide CLI syntax when they differ from a checked-in example. The 1.0 CLI separates target graph commands (`smthrs targets`, `show target`, `build|test|lint|docs|review|ci`) from durable flow commands (`smthrs flow list|plan|start`, `smthrs runs ...`). A flow start receipt does not prove completion; inspect its run and action receipts.

- **Graph or root files:** read [CONTRIBUTING.md](../../../CONTRIBUTING.md), especially root-file and target-index generation. `PACKAGE.ts` declares targets; generated companions and the whole declaration-set index have explicit checks. Use `pnpm run target-index` when that contract calls for regeneration.
- **Documentation:** read [apps/docs/README.md](../../../apps/docs/README.md) and [authoring rules](../../../apps/docs/shared/AUTHORING.md). Author in a package's `docs/` directory; the 48 sites under `apps/docs` are generated/staged copies. Use `pnpm run docs:sync` and `pnpm run docs:check` to keep them aligned.
- **Benchmarks or performance claims:** read [scripts/bench/README.md](../../../scripts/bench/README.md). Distinguish the deterministic PR gate from scheduled observed timings, review candidate baselines, and retain methods and limitations with any claim.
- **Evals:** read the owning suite's README, including [agent](../../../evals/agent/README.md) and [seeded review](../../../evals/review-seeded-bugs/README.md). Keep offline deterministic gates and deliberate baseline updates separate from live model measurements and spending.
- **Flows:** read [@smthrs/flow](../../../packages/smithers/flows/flow/README.md) and [CLI reference](../../../packages/smithers/docs/reference/cli/README.md). A file flow at `flows/<name>/flow.ts` default-exports a tagged `Flow.make` from `@smthrs/flow`. Use stable `Node.capture` callbacks for canonical persisted composition and matching `implementationVersion` declarations/registrations for sealed idempotent actions. New authoring uses Effect Schema, not retired JSX/Zod task examples.
- **Generated or untrusted flow declarations:** read [core planning rules](../../../packages/smithers/flows/core/README.md). `Graph.build` executes bodies and planning callbacks with the caller's process authority; capability/effect metadata does not sandbox that code. Translate validated data into nodes with trusted code, or plan untrusted code in an externally isolated process.
- **Runtime or persistence:** read [engine](../../../packages/smithers/flows/engine/README.md) and [engine-store](../../../packages/smithers/flows/engine-store/README.md). `@smthrs/flow` declares behavior, the engine makes decisions, and the storage seam changes where state lives. Durable execution currently composes SQLite on Node through `@smthrs/flows`; run migrations before SQL-backed services and use one writer for journal/state transitions. Browser bundling alone does not establish durable browser execution.

For TUI changes, read [apps/tui/AGENTS.md](../../../apps/tui/AGENTS.md) and its linked README. For app/server work, use their scoped `AGENTS.md` files. Treat issue state and wiki freshness as separate receipts from code status.
