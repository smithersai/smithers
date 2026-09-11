# Seam results

Seams implement the [flow result contract](../src/mainview/flows/entries/Declare.ts):

- A string reports an error.
- `void` reports success without data, for actions such as mutations.
- `{ readonly value: string }` reports success with model-readable data.

Model-invocable reads must use `Promise<string | { readonly value: string }>`.
Publishing a card alone does not supply data to the agent. Build the result
from the same parsed payload used by the card. See
[SeamContext](../src/mainview/state/seams/SeamContext.ts) and
[FilesSeam](../src/mainview/state/seams/FilesSeam.ts).

Issue list results include numbered rows, state and GitHub provenance,
including the source-only fallback. Issue details include repository, number,
title, state, author, labels, body and comments. PR lists include numbered
rows and state; details include body, reviews and checks. Secret lists include
only names, hosts, header names and update times from parsed metadata.
Secret values must never enter results.

These issue, PR and secret read results are capped at 16,000 characters,
including a `[truncated]` marker when needed. Cards retain their parsed data.
Empty lists return an explicit sentence naming the repository; source-only
issue lists also name GitHub and the requested state filter.

Regression coverage: `IssuesSeam.test.ts`, `LandingsSeam.test.ts` and
`SecretsSeam.test.ts` under `src/mainview/state/seams`.
