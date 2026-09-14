# Everyday run and review improvements

These additions serve individual developers and small engineering teams. They extend the existing cards, flow registry, controller actions and persisted form drafts.

## Needs attention

Run `/runs.attention owner/repo`, or choose **Needs attention** on a run list. The card combines pending approval requests with explicitly failed, parked or approval-waiting runs. **Review request** opens the existing approval controls; **Open** opens the run and its existing recovery controls. Refresh reads the original repository and gateway again, including after reload. Read failures remain visible.

Example: three coding runs finish overnight, one fails and another pauses for approval. The attention view gives you the two interventions to inspect. It does not infer failure from a quiet stream or an absent harness heartbeat.

## Editable handoff

Choose **Prepare handoff** on a run trace, or use `/runs.handoff run-id`. The ordinary form editor holds a Markdown brief with the recorded goal, plan, starting revision, verified result revision when available, observations and source references. Edit remaining work and the next action, then choose **Copy brief**. Edits persist across reload and reopening the draft. Copying remains a human clipboard gesture.

Example: prepare a brief after an agent attempts a retry fix, add “Integration tests still need checking; start with the timeout case,” and paste it into another coding tool. Agent reports, planned checks, completion and human acceptance remain distinct. This is a manual context handoff; no process or agent session transfers. Source frame links require this workspace's saved history. Raw launch payloads and tool logs are excluded; review the editable text before sharing it.

## Review evidence on a Change

The Change card summarizes check results and their revision, current versus older or unlinked findings, unresolved review threads and available walkthrough evidence. Missing reads and unknown revisions remain explicit. **Inspect** opens the existing facet; **Diff since my review** uses the existing review action.

Example: a change is at revision 3 but its passing build belongs to revision 2. The summary says “not current” and gives you the checks action instead of suggesting the change is ready to land. This adds no new approval or landing authority.

## Forms for declared flow inputs

Repository slash commands, `/flow.run` and a catalog's **Run** button use the same launcher. When opened without inputs, or with incomplete declared input, the existing form system asks for its fields, preserves provided values and submits named input through the existing plan/approval/run path. Text, numbers, booleans and literal choices use the existing controls. Drafts and the originating catalog's gateway survive reload.

Example: `/review` opens the repository's declared `args` field. Enter “Review retry handling in src/retries.ts” and choose **Run flow**. A schema declaring `path`, `attempts` and `mode` produces those fields instead of requiring a JSON object.

The catalog now carries input metadata for Markdown flows and inline schema declarations. Regenerate a repository's `.smithers/factory.json` with `smithers-build target //:factoryProjection --write`. Module-located schemas are not evaluated during discovery; unreadable or unsupported metadata retains the existing JSON launch path and runtime validation. This does not create new flow templates or a separate visual builder.

## Deferred

Accepted-run extraction into reusable flows, competing implementations and production-evidence repair remain future directions documented in Smithers-Ops. None is enabled by these changes.
