# Rules

Uphill writes these rules from each metric's `description`. Write code that meets them. `uphill` scores each metric against its target, and `uphill --compare HEAD --compact` lists what a change made worse.

## Correctness

- Avoid explicit `any` annotations and `as any` casts; model data with Effect Schema or Zod. At most 0.
- Do not add @ts-ignore, @ts-expect-error, or @ts-nocheck in production sources. At most 0.
- Never use React useState or useEffect in apps/mvp components; keep UI state in TanStack DB collections.
- Never call Model.stream directly in app or worker code; route model calls through durable flow steps.

## Architecture

- Keep production source modules focused and under 600 lines. At most 0.
- Resolve or track TODO/FIXME/HACK markers in the maintainer app instead of leaving them in source. At most 0.
- Register every built-in UI plugin manifest in apps/mvp/src/plugins/manifests.ts with apiVersion 1.

## Footprint

- Keep core source surfaces lean; prefer shared SDK primitives over duplicated app code. At most 500 kB.

## Documentation

- Document every shipped feature in apps/mvp/docs/features/ and keep AGENTS.md current.
- Keep all relative links in apps/mvp/docs/features/*.md valid. At most 0.
