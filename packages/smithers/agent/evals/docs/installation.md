---
title: "Installation"
description: "Install @smthrs/evals from npm, plus its runtime requirements and entry points."
---

Prereleases are published to npm under the `next` tag. Install the package
with its `effect` peer dependency:

```bash
pnpm add @smthrs/evals@next effect@4.1.1
```

## Runtime requirements

- Node.js 22.19.0 or later, from the package's `engines` field.
- `effect` `4.1.1`. Suites, runs, baselines, and gates are all `Effect`
  values, so every program composes with the `effect` library directly.
- `@smthrs/core` supplies `Flow` values. `@smthrs/scorers` supplies scorers,
  bindings, and the pure `@smthrs/scorers/ScoreGate` grading contract, including
  `ScoreGateError`. The evaluation runtime does not load `@smthrs/testing`;
  that package supplies a test facade for development consumers. To run the
  agent behind a case, add [@smthrs/agent](/api/agent) as well.

## Entry points

- `@smthrs/evals` exports the nine namespaces: `EvalError`, `Suite`,
  `CaseExecutor`, `Runner`, `Baseline`, `Regression`, `Report`, `Gate`, and
  `Trials`.
- `@smthrs/evals/<Module>` imports one namespace directly, for example
  `@smthrs/evals/Suite`.
- `@smthrs/evals/package.json` is exported. The `internal/*` modules and
  nested `*/index` subpaths are not public.
