# CLI `--json` stdout contamination + duplicate Effect runtime

> Target repo: **smithers**
> Source: 2026-04-25 hardening review

## Problem

The CLI emits Effect runtime warnings on **stdout** before the JSON
payload, so `--json` output cannot be parsed by automation. Currently
failing assertions:

- `apps/cli/tests/why-command.test.js:481`
- `apps/cli/tests/node-command.test.js:288`
- `apps/cli/tests/cli-devtools-process.test.js:167`

The contamination prefix observed in test output:

```
timestamp=... level=WARN ... Effect versioned 3.21.1 with a Runtime of version 3.21.2
```

Two distinct issues feed this:

1. Effect logger writes to stdout instead of stderr (or is not silenced
   when `--json` is set), so any consumer doing `JSON.parse(stdout)`
   sees the leading log line and fails.
2. Two versions of the `effect` package (3.21.1 vs 3.21.2) are resolved
   at runtime — one is loaded by the CLI, one by a transitive
   dependency. The version-skew detector is what prints the WARN, but
   the skew is itself a real problem and should be deduped.

## Goal

`--json` output is byte-for-byte parseable on stdout, every time, and
the CLI resolves a single Effect runtime version.

## Scope

### stdout discipline for `--json`

- All log output (Effect logger, console.warn/error, picocolors banners,
  progress, hints) routes to **stderr** when the active command is in
  JSON mode.
- Establish a single `setJsonMode(true)` call site in
  `apps/cli/src/index.js` that flips a process-global before any
  command body runs. The Effect logger is configured against that flag.
- For commands that emit JSON directly (`why`, `inspect`, `events`,
  `node`, `tree`, `output`, `diff`, `doctor run`), the only stdout
  writes are the JSON payload + trailing newline.
- Add a regression contract test: every command listed above is run
  with `--json` and its stdout is asserted to `JSON.parse` cleanly.

### Effect version dedupe

- Audit `pnpm why effect` across the workspace; pin a single version in
  the root `package.json` `pnpm.overrides` if a transitive dep pulls a
  different one.
- Verify in CI: a `scripts/check-single-effect-version.mjs` step fails
  the build if more than one resolved version of `effect` ships in the
  CLI bundle.

## Files

- `apps/cli/src/index.js` — JSON-mode flag + logger wiring
- `apps/cli/src/util/logger.ts` (new) — Effect logger configured for
  stdout/stderr switch
- `apps/cli/tests/json-stdout-contract.test.js` (new) — contract test
- `package.json` (root) — `pnpm.overrides.effect` if needed
- `scripts/check-single-effect-version.mjs` (new) — CI gate

## Testing

- Unit: logger respects the JSON-mode flag (writes to stderr).
- Integration: re-run the three failing tests above; stdout parses.
- Contract: every `--json`-supporting command parses its stdout.
- CI: single-version check fails on intentionally-induced skew.

## Acceptance

- [ ] All three currently-failing CLI tests pass.
- [ ] No CLI command writes to stdout when `--json` is set, except the
      JSON payload.
- [ ] Exactly one resolved version of `effect` ships in the CLI bundle.
- [ ] Regression contract test added and green.

## Blocks

- Adjacent to 0020 (uniform `--json`); this fixes a precondition for it.
