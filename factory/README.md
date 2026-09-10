# factory/

The software factory: everything that turns queued prompts into landed,
documented commits. The process design lives in the spec vault, a separate
repository: the "Software Factory" spec (process), the "Clean History" spec
(the `vibe`/`main` branch model), and the "Colocated Docs" spec (documentation
planes).

## Contents

- `queue/` — the intake. One markdown file per requested change; presence is
  registration. See `queue/README.md`.
- `flows/` — factory production lines: flows that run on the Smithers library
  itself (`harness.ts` holds the `AgentTask`/`ShellTask` atoms). Launch with
  `bun factory/flows/<name>.ts`.
- `reports/` — created at run time by `flows/harness.ts` (`REPORTS_DIR`) and
  not tracked: a summary markdown per flow plus tailable per-task logs.

## Planned

Factory tooling consolidates here over time. `bun factory/flows/<name>.ts` is
the only operator path. The `queue-driver` workflow that once consumed the
queue is retired with the `smithers workflow` verb; the factory flow that
replaces it (queue item `0003-factory-flow`) lands under `flows/` when it
becomes tracked code.
