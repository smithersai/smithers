# Experimental panes

Hidden mocks of Smithers abstractions that ship in `packages/` and have no UI.
One pane per abstraction, one flow per pane, one card kind for all of them.

The panes carry invented data, so only an operator reaches them. In an admin
session (or a Vite dev build) use `/app.experimental on`; the setting persists
with your session. Use `/app.experimental off` to disable it; bare
`/app.experimental` toggles it. Every other session has no switch, and a stored
setting enables nothing there.

For a build that should boot with it on, keep using
`VITE_SMITHERS_EXPERIMENTAL=true`. The build flag and an explicit host feature
also enable the panes, independently of the session setting.

Then `/experimental.<id>` in the composer, or ask the agent for it by name —
these are ordinary flows with all three doors.

While disabled the namespace does not register, so no experimental flow can
be found, disclosed to a model, or run.

## Adding one

1. `panes/<Name>.tsx` exporting `Pane` from `pane({ id, title, summary, packages, render })`.
2. One row in `Manifest.ts` repeating that pane's `file`, `id`, `title`,
   `summary` and `packages`.

Nothing else. The flow is generated from the manifest
(`../flows/entries/experimental.ts`), and the card carries the pane's id rather
than a payload shape, so a pane costs the wire no card kind of its own.

`Manifest.ts` is identity; `Registry.ts` is the drawing, behind
`import.meta.glob`. Every boot pays for the manifest so the flows can
register; a pane's own chunk arrives when its card first mounts, which is what
keeps ~190 KiB of mocks out of the app's main chunk. `Manifest.test.ts` holds
the two copies to each other in both directions.

## Rules a mock follows

- Compose `Primitives.tsx`; write no CSS. Every rule lives in
  `../styles/experimental.css` and `../styles/DeadCss.test.ts` keeps it honest.
- Mock data is inline at module scope. A pane reads no collection, calls no
  seam and dispatches no transition.
- Use the abstraction's real vocabulary — real table names, real field names,
  real verdicts. Invent values, never fields. A value never names a real
  person: addresses use `example.com` (`Manifest.test.ts` checks).
- Selection lives in the card's `payload.props`, with the pane's default
  used when absent. Change it through the context's `set(key, value)`, which
  runs `experimental.set` through the registry for both cards and agents.
- `flows/parity.test.ts` scans every pane and pins its affordance census.

## Promotion

A pane earns its own card kind, payload schema, migration and flow when it
leaves here for `../cards/`. The three-door law and affordance census already
bind its selections. Its mock data and copy remain a proposal.
