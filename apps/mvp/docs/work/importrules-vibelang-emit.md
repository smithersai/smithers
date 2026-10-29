---
title: ImportRules checks VibeLang compiler output and refuses empty scopes
status: blocked
area: build
owner: codex-importrules-vibe
updated: 2026-10-29
links: [../rules.md, import-rules-and-jev-lint.md]
---

Fail rules whose patterns cover no source, and analyze VibeLang through the compiler's emitted representation. Preserve existing verdicts except previously empty rules, correcting their scopes with evidence. Library catalog: `@smthrs/repo-targets` (ImportRules).

Validation required: red-first regressions; Latitude build and repo-targets checks and coverage suites; every declared importRules target; read-only Codex Astra review. No push or deployment.

The empty-scope regressions failed on the old implementation: the CLI returned 0 for `src/Answer.ts` when only `src/Answer.vibe` existed. The new check reports every empty scope before parsing.

VibeLang emission is blocked. The installed `vibelang@0.0.8` exports `compileProjectSync` from `vibelang/project`, returning JavaScript and a source map. It erases `import type` and private types. `projectImports` includes type-only specifiers but returns no reference forms, imported names, member uses or source locations; it cannot restore ImportRules' existing distinctions. No TypeScript emit is exported or offered by the compiler CLI. `--estree` returns an AST rather than the requested emitted TypeScript or JavaScript. No workaround was added and `ImportAnalysis.ts` is unchanged.

Minimal reproduction, compiled successfully on Latitude with `compileProjectSync({ project, cache: false })` and a local `Forbidden.ts` exporting `type Hidden = string`:

```vibe
import type { Hidden } from "./Forbidden.ts"
type Private = Hidden
export function value(): number {
  return match (1) { when 1: 1; default: 0; }
}
```

The emitted JavaScript contains only `value` and its lowered match. It contains no `Forbidden` reference, so a rule forbidding `./Forbidden.ts` would pass. smithers-f2 needs to expose emitted TypeScript preserving all module-reference kinds, names, member uses and source locations (or equivalent compiler-owned reference metadata accompanying JavaScript), before the parser change is safe. Do not use TS5 error recovery as migration proof.

Validation on nyc-02, based on main `572b7369`:

- All 27 `smthrs test '//...:importRules'` targets ran and passed before and after the empty-scope fix, with no skips or cache hits. Previously empty rules: none. No patterns changed and no empty-scope option was added. This establishes verdict parity on main, not correct VibeLang parsing.
- The three new empty-scope regression cases failed on the old code; all 60 ImportRules tests now pass, including the CLI failure after a `.ts` to `.vibe` rename.
- Repo-targets typecheck and full suite pass: 192 tests, 100% statements, branches, functions and lines. Its build fixtures needed current `Effect<...>` annotations: the old `!` annotations made two happy-path builds fail with EK1014. The unhappy-path fixture now fails for its intended return-type error.
- Build typecheck and full suite pass: 328 tests; coverage statements 97.26%, branches 93.07%, functions 95.50%, lines 98.61%, above the unchanged configured thresholds. Build lint fails on duplicate imports in `infra/scripts/remote-state.topology.test.ts` (lines 1–2) and an unnecessary assertion in `infra/worker/test/deployment-config.test.ts` (line 255). Both files are byte-for-byte identical to main.
- Read-only Codex Astra review found no correctness issues and confirmed the emit blocker. Its noted JSDoc snapshot and pending validation concerns were resolved before delivery. No VibeLang parser fix or passing VibeLang-only forbidden-import regression is claimed.

The compiler-output requirement remains unfinished. No push or deployment.
