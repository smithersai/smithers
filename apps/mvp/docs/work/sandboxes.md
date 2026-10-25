---
title: Branch sandboxes (feature 5)
status: in-progress
area: infra
owner: unassigned (the sandboxes builder handed off on 2026-10-23)
updated: 2026-10-25 PDT
links: [branch-terminal.md, branch-sharing.md, ../decisions/0005-sandboxes-secrets-and-the-forge.md, ../todo.md, sandbox-budgets.md, ../decisions/0007-roles-and-tags.md, ../decisions/0002-local-first.md, design-questions.md, ../decisions/0011-the-agent-runs-in-the-browser.md, connect-agents-sandboxes-forge.md, model-endpoint.md, token-spend-alerts.md, secrets-proxy.md]
---

## Every box reaches the package registries — 2026-10-25

Ruling ARCH-15: most repositories install and build in most sandboxes. Production's branch terminal failed
`npm install` with `EAI_AGAIN registry.npmjs.org` on 2026-10-25: only check jobs had an egress.

- Every box, a branch's, a TODO's or a check job's, now gets the registry egress (`worker/branch/RegistryEgress.ts`,
  renamed from `JobEgress.ts`): npm, PyPI, crates.io, Go's proxy, GitHub's releases and dprint's plugins, no secret.
  With `SANDBOX_SECRETS` on, a branch's or a TODO's box gets the secrets egress, whose allow list now always includes
  those registries.
- A box without secrets trusts the container's CA on every wake without an environment file (`SandboxEgress.TRUST`),
  so `no-secrets-6` in `e2e/sandbox-lifecycle.spec.ts` holds. pip and Go read the system store; no extra variable.
- The image adds Go 1.27.3, Python with pip and venv, and `build-essential`.
- The browser's run tool states the deployment's `SANDBOX_COMMAND_MAX_SECONDS`, which the build captures.

## Handoff — 2026-10-23

**Works in production (push 28):** branch machines (terminal, keep-awake, sleep, wake with the working copy), agent tools on
the same machine, commands up to an hour as `sandbox/Command` jobs (a 20-minute command settled once), a drive budget
under Cloudflare's 15-minute alarm limit, and command latency: `git status` call to settled 0.9 to 1.1 s (5.6 s cold).
**Open:**
- A run woken after a job settles takes 12.0 s to answer (benchmark 7.3 s, expected ~2 s near the database). It only hits
  commands that outlive the 10-minute drive budget. Next step: read the alarm's `build_ms`, `route_ms` and `drive_ms`
  during one long command to split runtime build, routing and replay.
- Done 2026-10-25: the browser's run tool states the deployment's `SANDBOX_COMMAND_MAX_SECONDS`, which the build
  captures (`vite.config.ts`).
- Done, for the record: PR check scripts already run up to `SANDBOX_COMMAND_MAX_SECONDS` (worker/flows/Checks.ts).

## A command answers in the step that asks — 2026-10-22 PDT (evening)

A step that asks for a command (the TODO agent's tool, a head's checks) starts it, waits on it and collects it itself,
for as long as the command may run and the drive's budget allows, and only a command still running then goes on as the
`sandbox/Command` job. Command-latency benchmark at 25 ms round trips: a command that exits at once 47 s to 0.1 s, a
30 s command 47 s to 0.1 s. **Trade-off, decided by the lead:** latency over Durable Object wall time. While a step
waits, its alarm is held and billed; `flows_external_job_step_wait_ms` shows that time by outcome, and
`SANDBOX_COMMAND_STEP_WAIT_SECONDS` caps it (0 returns to parking on every command). Revisit when real usage shows up.

## A command no longer holds a host: `sandbox/Command` — 2026-10-22 04:15 PDT

**State:** works in production (evidence below, 08:29 PDT). A TODO's `pnpm install` failed twice in production on 2026-10-22 with
`ToolLost`: the alarm driving the run hit Cloudflare's 15-minute limit while the command held one of its steps, and the
next alarm found the command's fence with no exit. A `run` (the TODO agent's tool, and `sandbox/Call` for a person or the
branch agent) is now its own `sandbox/Command` job (`worker/flows/SandboxCommand.ts`), `@smthrs/sandbox`'s new
`SandboxCommand` over `ExternalJob`: start detached once per key, park between probes, collect once
([long commands](../features/sandbox-tools.md#long-commands)). Regression tests kill the host mid-command on the Durable
Object handlers and on the Node engine; the command runs once and its result arrives. `e2e/sandbox-tools.spec.ts`
"long command" runs a 9.5-minute command end to end; it runs in production after the deploy.
Known: a run cancelled while its job is parked leaves the command to its own timeout (at most
`SANDBOX_COMMAND_MAX_SECONDS`, an hour unless set; corrected 2026-10-22 13:21 PDT, it said 600 s), because the
job's rollback lives in the host that parked. A pull request's check scripts run as the same job (`checks/Scripts`).
The long-command e2e found every first provision of a person's user hung under `alchemy dev`: `useradd` warns on
stderr that the uid is outside UID_MIN..UID_MAX, and there a piped stream nobody reads holds the exec's exit. Commands
the object runs for their exit alone now pipe no output, each exec of a command operation answers within 2 minutes or
the job asks again, and the e2e passes on the mini farm with the 570 s command.
In production, a TODO's detached command (`sandbox-command:c2d28282`, launched 08:18:30 PDT, timeout 600 s) ran as a
job: the TODO stayed parked, each observe drive took 5 to 24 s, the result was collected once, and the run resumed at
08:29:27 with no `ToolLost`, steal or internal error. A TODO drive that reached its 600 s budget (617,657 ms with the
step in flight) yielded and continued on the next alarm.

## Works in production on the new image — 2026-10-22 01:20 PDT

**State:** works. Production (smithers.sh) runs main `6ea8caeea2fa`, deployed 00:20 to 00:22 PDT with the image whose
PID 1 is tini and which carries Node 26.5.0 and pnpm 11.25.0. `e2e/sandbox-lifecycle.spec.ts` passed against it from
00:32 to 01:02: the terminal opened as the person's own uid (5.5 minutes: the first open after the deploy, on the new
image's first pull), a commit in it, a command past the idle time kept the machine awake for 16.5 minutes, the idle
machine slept, reopening woke it in 52 s with the working copy and the commit, and the agent's tool ran on the same
machine, its file in the terminal's checkout. GIF: `sandbox-lifecycle-sandbox-lifecycle.gif` from the production run.
It had also passed on `81a8e357` (the zombie-skipping probe, old image) from 21:06 to 21:27 PDT on 2026-10-21.

**Image push:** a network that breaks large TLS uploads to Cloudflare makes Alchemy's push of a big layer fail with
`use of closed network connection`; this image's main layer is 107 MB. The private deploy runbook's image-push step
pushes the layers from a host with a steady uplink, after which the deploy itself sends only small blobs and manifests.

**Open:**
- The first terminal open after the deploy waited 5 minutes before its Wake step began (run created 07:30:19 UTC, Wake
  07:35:33). The records don't say why; that is an observability gap to close before guessing.
- Landing: session stage logs and a 60 s bound (`89f373ae`), the Terminal link showing the terminal at once
  (`a2c7b533`), and Open terminal offered again for a stuck `opening` row (`8f76cf84`).
- The Mac mini's e2e slots share one Postgres but not their Durable Object state, so generation-numbered runs such as
  `sandbox-keep:<branch>:<generation>` collide across slots; the farm's owner is giving each slot its own database.

## PID 1 reaps orphans — 2026-10-21 21:00 PDT

**Cause:** the box's PID 1 was `sleep infinity`, which never reaps the orphans reparented to it, so three exited `git`s
stayed zombies and the idle probe called the machine busy for hours (the 17:18 lifecycle run failed at the sleep).
c816c9e7 makes the probe skip zombies.

**Fix:** the image runs tini as PID 1 (Debian's `tini` 0.19.0), which reaps them; under it the box idles as
`smithers-idle`, which the probe ignores. Folded into the Node 26.5.0 and pnpm 11.25.0 image change (was a98f91e4).

**Evidence (real Docker, this Mac):** `worker/branch/Probe.docker.test.ts` 4 passed. Main's old image: PID 1 `sleep`,
an orphan stays a zombie; new image: PID 1 `tini`, no zombie. Removing either probe exclusion makes the probe say busy.
The linux/amd64 build runs PID 1 `tini`, Node v26.5.0, pnpm 11.25.0. Production proof: the lifecycle e2e after deploy.

## Production sandboxes — 2026-10-21 10:07 PDT

**State:** doesn't work in production yet; nothing has ever started a container there (0 instances). The four-model panel (Sol, Astra, Opus, Fable) agreed on the cause; the merged plan is in the session's `sandbox-panel/MERGED.md`.

**Why it fails in production** (each fixed in this change unless noted):
- Every sandbox flow runs on `FlowExecution`, which fails `MigrationError` in prod. The prod-remote-flows builder owns that fix; sandboxes wait on it.
- A deployed container's `exec` refuses user names; local Docker accepts them, so dev passed. Every command now runs as a numeric `uid:gid`, with `HOME`, `USER` and `LANG`, which `exec` doesn't pass.
- Every box started as `lite` (256 MiB). It now starts as `SANDBOX_INSTANCE`, `standard-1` by default.
- A deploy restarts the object, which loses the inactivity timeout, and Cloudflare then stops a busy box. The object now re-arms it in its constructor and on every ask.
- A failed restore marked the checkpoint restored, and the next save overwrote it; a commit made in the box was lost on wake. Restore now fails on a transient error, keeps an unrestorable checkpoint aside, and carries unpushed commits as a git bundle.
- Wake failures now log the step that failed.
- The image was already published and bound in prod; it now also has Node and npm.
- Not fixed here: a signed-in Member and the Spoon-Knife fixture in prod (the prod-e2e builder's sign-in).

**Next step:** land the fix, run `e2e/sandbox-lifecycle.spec.ts` locally, deploy once the MigrationError fix is live, then run the same spec against production with a GIF.

## Tracker reconciliation — 2026-10-21 21:34 PDT
**What:** Prove production branch commands, sleep and restored wake.
**Why:** Hosted coding must preserve work and stop idle spending.
**Current state:** At 21:29 the lead reports the complete production lifecycle passed during 21:06–21:27: terminal and commit, busy-command keepalive, sleep 23 seconds after completion, wake in 52 seconds with work intact, and agent commands visible in the terminal. The proper tini image remains a separate pending deployment after the smithers.sh cutover.
**Next step:** Retain the lifecycle recording; deploy the init image after cutover and verify its lifecycle.
**Open questions for Will:** None newly required; existing product decisions and account provisioning remain in their owning workstreams.
Evidence: script-filtered user text and lead replies from the latest approximately two hours across both requested session paths, current rulings and queue answers, and surviving reports where named. Product checks are reported receipts. Implementation owner retained; Codex maintains this tracker entry. Earlier history below is preserved; reboot-wiped briefs are not missing work.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 21:10 PDT
**What:** Prove commands, idle sleep and restored wake in production.
**Why:** Idle machines must stop spending and preserve work.
**Current state:** At 20:58 the lead reports a real-container proof for tini with Node 26.5/pnpm 11.25, queued behind the zombie-process probe fix. The probe fix deploys at 21:05; the roughly 50-minute production lifecycle starts at 21:06. No lifecycle completion or deployed init-image receipt yet.
**Next step:** Collect lifecycle result, land/deploy the init image and repeat its real sleep/wake proof.
**Open questions for Will:** None.
Evidence: script-filtered user text and lead replies, 19:06–21:06 PDT; current rulings and queue answers through 21:06; surviving briefs and reports. Product results are reported receipts, not rerun here. Implementation ownership retained; Codex curates documentation. Wiped scratch files are not missing work.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 20:47 PDT
**What:** Prove sandbox command execution, sleep and restored wake.
**Why:** Idle machines must stop spending without losing work.
**Current state:** At 20:33 production sleep still fails because PID 1 leaves zombie git children counted as activity. A fresh builder owns recovery; the ignore-zombies fix awaits push at 20:37. A proper init in the container image remains the lasting fix. No later lifecycle pass appears.
**Next step:** Push and deploy the idle fix, rerun the real lifecycle, then ship and verify the init image.
**Open questions for Will:** Push access restoration is tracked separately.
Evidence: script-filtered human text and lead replies, 18:46–20:46 PDT, session 6253ecf2; current rulings and queue answers prevail. Runner results are recovered report receipts. Codex curates this update; existing implementation ownership is retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 20:34 PDT
**What:** Prove branch terminal, command execution, idle sleep and restored wake in production.
**Why:** Hosted coding must preserve work and stop spending when idle.
**Current state:** At 20:33 the lead corrects the earlier sleep claim: production lifecycle failed again at sleep. PID 1 is sleep infinity and fails to reap finished children; three leftover processes are mistaken for active work. The mitigation that ignores those leftovers is first in the landing queue. The lasting fix is a proper container init; image uploads are now possible off the hotspot. Terminal use and agent commands work according to the lead; the complete lifecycle does not.
**Next step:** Land the mitigation, deploy and rerun the complete production lifecycle. Publish the corrected sandbox image and retain sleep/restored-wake evidence.
**Open questions for Will:** None.
Evidence: lead text replies script-filtered from session 6253ecf2, approximately 18:34–20:34 PDT, and recovered briefs where named. Automated notifications and tool content are excluded. Current rulings and queue answers prevail over older plans. Existing implementation ownership is retained; Codex curates the tracker. Product results are reported evidence, not tests rerun by this refresh.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 17:23 PDT
**What:** Prove production branch startup, terminal, sleep, restored wake and agent tools.
**Why:** Hosted coding requires preserved work through the complete sandbox lifecycle.
**Current state:** The idle-sleep fix landed as 4be64dd8 and is live from 17:17. The lead reports a production machine slept at 17:14. The full lifecycle test started around 17:18 and needs roughly 50 minutes; no final pass or GIF is reported.
**Next step:** Collect the full production lifecycle result and GIF, then unblock the Node 26.5 image once hotspot upload restrictions lift.
**Open questions for Will:** None newly identified; retained unresolved decisions remain with their owning workstreams.
Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, approximately 15:23–17:23 PDT. Automated notifications and tool content excluded. Rulings and queue answers govern over older briefs, designs and planning docs. Implementation ownership retained; Codex maintains tracker documentation. Product results are lead-reported.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 16:53 PDT
**What:** Prove branch startup, terminal, sleep and restored wake.
**Why:** A usable terminal must also preserve the working copy through idle sleep.
**Current state:** At 16:47 the lead reports startup timeout landed on main 83534f86. At 16:51 the idle-sleep cause is identified: closing the terminal starts a checkpoint save killed with exit 137, leaving no checkpoint and therefore an awake box. The builder reports a fix moving the save into its own request, once on the next keep-alive check; it is queued ahead of legacy removal. No production lifecycle pass is reported.
**Next step:** Land the checkpoint fix, deploy once, and rerun the full production lifecycle including restored wake and agent tools.
**Open questions for Will:** None newly identified; earlier unresolved items remain in the retained history.
Evidence: lead text replies, script-filtered from session 6253ecf2 for 14:53–16:53 PDT; tool content, automated messages, relayed agent reports and compaction summaries excluded. Rulings and queue answers take precedence over historical briefs and plans. Implementation owners and statuses retained; Codex curates this update. Product checks are lead-reported.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 16:43 PDT
**What:** Prove branch startup, terminal, sleep and restored wake.
**Why:** Terminal success alone does not prove durable sandbox lifecycle.
**Current state:** At 16:38 the builder waits for 98702a02 deployment before investigating idle sleep. The 150-second startup timeout is locally tested and queued after diagnostics. Diagnostics are now on main; no full production sleep/wake acceptance receipt exists.
**Next step:** Complete deployment, land startup limit, fix idle sleep and prove restored wake plus the agent tool step.
**Open questions for Will:** None.
Evidence: user-typed messages and lead text replies script-filtered from session 6253ecf2, 14:43–16:43 PDT; synthetic notifications, tools and compaction summaries excluded. Rulings and queue answers govern over historical briefs, panels, decisions, proposals, TODOs and rules. Implementation ownership retained; Codex curates this note. Product results are lead-reported.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 16:33 PDT
**What:** Bound sandbox startup and prove production sleep/wake.
**Why:** A slow start must fail visibly; the lifecycle still needs real acceptance.
**Current state:** At 16:33 PDT the lead reports the 150-second startup limit done and tested on the MacBook, with a clear start-timeout failure instead of a 20-minute browser wait. It is queued immediately after sandbox diagnostics. The idle-sleep bug remains under repair; terminal success does not establish full lifecycle acceptance.
**Next step:** Land diagnostics and startup limit, deploy, then prove idle sleep, restored wake and the agent tool step in production.
**Open questions for Will:** None.
Evidence: lead text replies in session 6253ecf2, script-filtered through 16:33 PDT from its latest two hours; automated notifications, tool records and compaction summaries excluded. Rulings and queue answers take precedence over historical briefs. Implementation ownership retained; Codex curates tracker documentation. Product results are lead-reported.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 14:54 PDT
**What:** Prove production branch terminals, tools and durable sleep/wake.
**Why:** Sandboxes remain the top production priority.
**Current state:** Routing fix d60a5f2b deployed at 13:44. At 14:51 the lead reports the full production run started around 14:50 and needs about 50 minutes with real sleep timers. Terminal, busy, sleep and restored wake run first; the model-dependent agent step runs last. No final acceptance receipt yet.
**Next step:** Record each terminal/lifecycle result and deployed revision, then separately prove the agent tool step after model access recovers.
**Open questions for Will:** None for this repair. Existing pending decisions remain in the retained history.
Evidence: script-extracted user-typed text and lead replies from session 6253ecf2, 12:54–14:54 PDT; automated notifications excluded. Rulings and queue answers govern over historical briefs and proposals. Product receipts are lead-reported; this pass verifies only the maintainer-site build. Implementation owners remain assigned; Codex maintains tracker documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 14:17 PDT
**What:** Prove hosted checkout, terminal, agent tools and sleep/wake.
**Why:** Hosted coding needs a working branch machine.
**Current state:** At 14:16 the lead reports a terminal opened in production at 14:14, the first successful checkout through the git proxy and Code Storage. Routing fix d60a5f2b works and sandbox logs appear in the live tail. This proves the terminal step only. Agent tools and the real 15-minute sleep/wake lifecycle wait on the model-budget increase deploying now.
**Next step:** Collect tool and restored-work receipts after budget recovery; retain the terminal result and finish the pinned Node/pnpm image proof.
**Open questions for Will:** None.
Evidence: script-filtered user-typed messages and lead text replies in session 6253ecf2, approximately 12:16–14:16 PDT on 2026-10-21; automated notifications, relayed agent reports and tool blocks excluded. Rulings and queue answers prevail over historical briefs/designs and docs. Product receipts are lead-reported; tracker verification is the maintainer-site build. Implementation ownership is retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 14:05 PDT
**What:** Prove hosted checkout, terminal, agent tools and sleep/wake.
**Why:** Hosted coding requires a working branch machine.
**Current state:** Routing fix d60a5f2b is live from 13:44 PDT. The 14:02 lead correction supersedes earlier claims that production E2E was already running: it had been waiting on the suite lock. At 14:02 it actually starts alongside the suite with isolated Spoon-Knife terminal/tool usage. No terminal/tool or lifecycle pass is reported. Node image a98f91e4 still follows this proof.
**Next step:** Collect actual terminal/tool and full lifecycle receipts, repair failures, then land/deploy the pinned Node/pnpm image.
**Open questions for Will:** None.
Evidence: user-typed text and lead text replies extracted by script from session 6253ecf2 for approximately 12:04–14:04 PDT on 2026-10-21; synthetic notifications and tool records excluded. Rulings and queue answers override historical briefs, designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this tracker validates the maintainer-site build only. Engineering owners remain responsible; Codex owns this documentation reconciliation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 13:54 PDT
**What:** Prove branch checkout, terminal, agent tools and sleep/wake in production.
**Why:** Hosted coding requires a working branch machine.
**Current state:** The routing fix d60a5f2b went live at 13:44 on its first deploy attempt. Production lifecycle E2E is running; sandbox logs now appear in the live tail. At 13:49 no passing result is reported. Full lifecycle validation uses real 15-minute timings and is expected to take roughly 50 minutes. Node image change a98f91e4 follows this test.
**Next step:** Collect terminal/tool and full lifecycle results, repair any failures, then land/deploy the pinned toolchain image. Keep the feature in progress until real E2E passes.
**Open questions for Will:** None.
Evidence: lead text replies at 13:44–13:53 PDT on 2026-10-21, extracted by script from session 6253ecf2 within its latest approximately two hours. Automated notifications, relayed agent messages and tool content are excluded. Rulings and queue answers take precedence over historical briefs and designs. Results are lead-reported; this tracker verifies the maintainer-site build. Existing implementation ownership is retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 13:44 PDT
**What:** Prove branch checkout, terminal, tools and sleep/wake in production.
**Why:** Hosted coding needs a working branch machine.
**Current state:** At 13:42 PDT the supported-routing and structured-log fix landed as d60a5f2b; deployment is underway at 13:44. No successful production lifecycle is reported. Node 26.5 image change a98f91e4 is committed and scheduled after the production sandbox test.
**Next step:** Confirm deployment, immediately run production lifecycle tests, then land/deploy pinned Node 26.5.0 and pnpm 11.25.0 for checks.
**Open questions for Will:** None.
Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, approximately 11:44–13:44 PDT; automated notifications and tool content excluded. Rulings and queue answers govern over historical briefs, panel designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this pass validates the site build only. Existing execution owners retained; Codex curates tracker documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 13:24 PDT
**What:** Prove production checkout, terminal, tools and sleep/wake recovery.
**Why:** Hosted coding requires a working branch machine.
**Current state:** At 13:19 PDT the lead reports the probe confirmed unsupported Cloudflare routing between the sandbox and proxy as the production checkout failure. The same proxy/token clones successfully in the production image on the Mac. The builder is changing routing and fixing missing sandbox logs in the live tail. No passing production lifecycle is reported.
**Next step:** Land and deploy supported routing plus log visibility, then rerun terminal, tools and sleep/wake tests.
**Open questions for Will:** None.
Evidence: script-filtered lead text replies in session 6253ecf2, latest two-hour window through 13:23 PDT; rulings and queue answers take precedence. Execution ownership retained; Codex curates tracker documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 13:16 PDT
**What:** Prove production branch checkout, tools, terminal and sleep/wake recovery.
**Why:** The hosted coding loop needs working branch machines.
**Current state:** The latest 13:15 PDT production matrix still reports terminal and agent-tool failures. Containers start and git runs, but checkout between the container and Code Storage fails. The routing probe and supported-routing repair remain with the sandbox builder; no successful production lifecycle receipt is reported.
**Next step:** Complete the probe, land/deploy the routing fix and rerun lifecycle and tools tests; finish pinned check-job tooling.
**Open questions for Will:** None.
Evidence: script-filtered user-typed text and lead replies, 11:16–13:16 PDT, session 6253ecf2; current rulings and queue answers override older briefs and docs. Product receipts are lead-reported; this refresh validates the maintainer-site build only. Execution owners remain unchanged; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 12:54 PDT
**What:** Prove branch machines can check out code, run tools and recover after sleep.
**Why:** Branch sandboxes must actually open a terminal and preserve work.
**Current state:** At 12:53 PDT the lead reports production sandbox E2E fails at Open the terminal. Containers start, numeric users and the image work, and the box runs git; every wake fails at checkout despite the mirror containing the test branch. Unsupported routing from the forge intercept to a Durable Object stub is the main suspect, not a confirmed cause. A five-minute probe is authorized without the production E2E lock; the builder also prepares supported routing. The pinned Node 26.5.0/pnpm 11.25.0 check image is still being built. No production lifecycle pass exists.
**Next step:** Confirm the checkout failure with the probe, repair forge routing, deploy and rerun the terminal and sleep/wake lifecycle. Finish the pinned check image and bounded command-record retention.
**Open questions for Will:** None.
Evidence: script-filtered human text and lead replies for the latest approximately two hours of session 6253ecf2 through 12:54 PDT; automated notifications, relayed agents and tool blocks excluded. Current rulings and queue answers govern over older briefs, panels, decisions, proposals, TODOs and rules. Product receipts are lead-reported; Codex curates tracker documentation and runs the site build. Existing execution owners are retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 12:46 PDT
**What:** Prove production terminal/tools, sleep/wake, checkpoints and bounded command records.
**Why:** Branch machines must preserve work without accumulating unlimited per-run records.
**Current state:** At 12:31 the lead reports the command-record retention fix built and going to the lander, dropping records older than 24 hours. The production lifecycle test started at 12:31: Member sign-in succeeded and repository clones were requested. Its sleep can take roughly 20 minutes. At 12:39 the broader suite reports branch-terminal failures; no completed sandbox lifecycle pass is available. The sandbox builder also owns upgrading the check image to pinned Node 26.5.0 and pnpm 11.25.0, with registry egress limited to check jobs.
**Next step:** Finish the production lifecycle test and repair terminal failures; land record retention and the pinned toolchain, retaining retry-window, checkpoint and egress regressions.
**Open questions for Will:** None.
Evidence: script-filtered user-typed text and lead replies, approximately 10:44–12:44 PDT on 2026-10-21, session 6253ecf2; synthetic notifications, relayed agents and tool blocks excluded. Rulings and queue answers govern over shared briefs/designs and historical decisions, proposals, TODOs and rules. Product receipts are lead-reported; Codex curates documentation and validates the site build. Existing execution ownership is retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 11:54 PDT
**What:** Prove production terminals, tools, sleep/wake and unpushed-work restoration.
**Why:** Branch machines must preserve work across shutdown and deployment.
**Current state:** Sandbox fixes are reported live with the 11:47 production deployment. At 11:51 the production sandbox E2E waits for the shared lock while watching live logs. Earlier local coverage and container tests do not establish a production lifecycle pass.
**Next step:** Finish the queued production E2E and retain terminal, tool, sleep/wake and checkpoint-restoration receipts.
**Open questions for Will:** None.
Evidence: script-filtered user text and lead replies from session 6253ecf2, approximately 09:54–11:54 PDT; current rulings and queue answers take precedence over historical briefs, decisions, proposals, TODOs and rules. Product results are lead-reported; this tracker validates the site build only. Existing implementation ownership is retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 11:40 PDT
**What:** Prove terminals, tools, sleep/wake and unpushed-work restoration on production Containers.
**Why:** ARCH-14 requires durable branch machines.
**Current state:** At 11:39 the lead reports the sandbox repairs landed in main revision 931fed70 alongside remote-host fixes; deployment is underway. Earlier docs/test-capacity waits do not establish a production pass. No successful production sandbox journey is reported.
**Next step:** After deployment completes, retain production terminal, tool, sleep/wake and unpushed-commit restoration receipts, plus outstanding validation results.
**Open questions for Will:** None.
Evidence: lead text replies through 11:39 PDT in session 6253ecf2, extracted by script from the latest two hours; rulings and queue answers take precedence over shared briefs, designs and older docs. Product results are reported evidence; this refresh validates the site build only. Existing implementation ownership is retained; Codex curates this note.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 11:24 PDT
**What:** Prove branch terminals, tools, sleep/wake and restoration on production Containers.
**Why:** ARCH-14 requires durable branch machines, including unpushed work.
**Current state:** Reviewed fixes remain queued: numeric command users, larger instances, sleep rearming and Astra restore/input repairs. At 11:16 and 11:23 the builder waits for shared test capacity; lander and Mac mini E2E jobs go first. No passing production sandbox receipt is reported. Remote flows now wait on QuickJS deployment after successful migration recovery.
**Next step:** Complete docs checks and the Mac mini E2E retry, land/deploy repairs in order and retain production terminal, tool, sleep/wake and unpushed-commit restoration receipts.
**Open questions for Will:** None; access is settled and the sandbox image already exists.
Evidence: script-filtered human messages and lead text replies, 09:26–11:24 PDT, session 6253ecf2; current rulings and queue answers supersede historical briefs, designs, decisions, proposals, TODOs and rules. Engineering receipts are lead-reported; this refresh validates the site build only. Existing implementation ownership is retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 11:04 PDT
**What:** Make branch terminals, tools, sleep and restore work on production Cloudflare Containers.
**Why:** ARCH-14 and PROC-20 prioritize production sandbox proof.
**Current state:** At 10:56 the builder reports all four Astra findings fixed: preserve terminal input during checkpoint saves; fetch an old base before restoration; recover transient GitHub restore failures; use 30-bit command user ids. These join numeric users, larger instances and deploy-time sleep-timer rearming. The image already exists; earlier claims it was unpublished are superseded. The second deploy will combine sandbox and remote-flow fixes after landing; no successful production sandbox run is reported.
**Next step:** Land the reviewed repairs, complete the combined deploy after migration recovery, and retain production terminal, tool, sleep/wake and unpushed-commit restore E2E/GIF receipts.
**Open questions for Will:** None newly identified. Repository access, Neon and review routing are settled; Telegram setup is discretionary and must not be resurfaced.
Evidence: script-filtered human text and lead replies in session 6253ecf2, approximately 09:03–11:03 PDT; current rulings and queue answers take precedence over briefs, panel designs and older documentation. Product receipts are lead-reported; Codex curates documentation and validates only the maintainer-site build. Existing engineering ownership is retained.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 10:34 PDT
**What:** Make branch terminals, tools, sleep and wake work on production Cloudflare Containers.
**Why:** ARCH-14 and PROC-20 prioritize real hosted sandboxes.
**Current state:** The four-model panel recommends retaining the existing Containers implementation. At 10:32 the builder reports numeric command users, larger instances, re-armed sleep timers, preservation of unpushed commits, wake diagnostics and Node in the image. Mac mini tests report 100% coverage and a real-container terminal. Full local sleep/wake proof and production validation remain outstanding; the image was already published, correcting the earlier claim.
**Next step:** Finish the lifecycle run, land fixes, then deploy in sequence after the migration repair and prove production sleep/wake with a GIF.
**Open questions for Will:** None newly identified; retain unrelated unresolved questions in the live queue.
Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, latest approximately two hours through 10:33 PDT; current rulings and queue answers through 10:31 PDT, shared feature/host/panel briefs and designs, decisions, proposals, TODOs and rules. Product receipts are reported evidence; this tracker runs only the site build. Execution ownership is retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 10:24 PDT
**What:** Run durable branch terminals and agent tools on Cloudflare Containers.
**Why:** Production sandboxes are Will’s immediate priority.
**Current state:** The four-model plan is being implemented. The published pinned image exists. Numeric command IDs, instance sizing, sleep timer re-arming and unpushed-commit preservation remain repair scope. At 10:23 PDT the shared production Member session is available; production still waits on the remote-flow migration repair. Secrets remain disabled.
**Next step:** Land repairs, deploy after host recovery and prove terminal, tools and sleep/wake restoration in production with a GIF.
**Open questions for Will:** None new. Access, Neon and Telegram decisions are resolved; do not reopen them.
Evidence: script-extracted human messages and lead text replies, 08:23–10:23 PDT, session 6253ecf2. Automated records and continuation summaries excluded. Rulings and queue answers override older briefs, panels, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this tracker validates the site build only. Existing execution owners retained; Codex owns this documentation refresh.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 10:15 PDT
**What:** Run a branch terminal and agent tools in a durable Cloudflare Container with sleep/wake recovery.
**Why:** Production sandboxes are Will’s immediate priority under ARCH-14 and PROC-20.
**Current state:** All four reports are merged and implementation is running. The published pinned image exists, correcting the earlier unpublished-image claim. Repairs cover numeric command user IDs, instance sizing, re-arming sleep timers and preserving unpushed commits. Production still depends on remote-flow recovery and the shared Member session. Will sent the Write invitations; acceptance is pending. Secrets remain disabled.
**Next step:** Land and deploy tested repairs, then prove terminal commands, agent tools, busy keep-awake and sleep/wake restore against production with a GIF.
**Open questions for Will:** None. Cloudflare is preferred and Freestyle remains the fallback; test-account invitations are already authorized.
Evidence: user-typed messages and lead text replies extracted by script from session 6253ecf2, approximately 08:14–10:14 PDT on 2026-10-21; tool records, automated notifications, local-command output and continuation summaries excluded. Current rulings (ARCH-4, TEST-6, AUTH-4, ARCH-14, PROC-20) and queue answers take precedence over shared briefs, panel designs, decisions, proposals, TODOs and rules. Execution owners are retained; Codex curates tracker documentation only. Product validation is lead-reported; this refresh runs only the site build.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:54 PDT
**What:** Run durable branch terminals and tools on Cloudflare Containers.
**Why:** Production sandboxes are an immediate priority.
**Current state:** At 09:48 PDT the lead reports the merged sandbox plan is being implemented, confidence 80%. The published pinned image exists. Production execution still depends on remote-flow migration recovery and Member test access. Numeric command user IDs, instance sizing, timer re-arming and preservation of unpushed commits remain in the repair scope. Secrets remain disabled.
**Next step:** Complete and land the repair, then verify terminal, agent tools, busy keep-awake and sleep/wake recovery on production with the shared E2E harness and GIF.
**Open questions for Will:** None. Answered 10:13 on 2026-10-21 (option 1, granted), Will: "Both Write invitations are sent; codeplanesmithers still needs to accept them." The prod-e2e builder accepts both invitations as the test account (rulings.md, TEST-6 addendum).
Evidence: script-filtered user-typed messages and lead text replies, 07:53–09:53 PDT, session 6253ecf2; automated requests, summaries and agent-message wrappers excluded. Rulings and queue answers take precedence over briefs and older docs. Product checks are lead-reported; this refresh validates only the site build. Execution owners retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:45 PDT
**What:** Run a durable Cloudflare sandbox per branch for terminals and agent tools.
**Why:** Production sandboxes are Will’s immediate priority (ARCH-14, PROC-20).
**Current state:** At 09:43 PDT the lead reports all four sandbox reports complete and implementation underway. The panel recommends retaining our Cloudflare Containers implementation at 85–90% confidence. The image is already published and pinned; the earlier missing-image claim was corrected. No production container has started because sandbox flows hit the remote-host migration failure. Specific repairs include numeric command user IDs, a larger instance, re-arming sleep timers after deploy, and preserving unpushed commits during restore. No production acceptance receipt exists; secrets stay disabled.
**Next step:** Finish the Opus implementation alongside the remote-host repair, then prove terminal and agent tools share the branch box, busy work prevents sleep, and real idle sleep/wake preserves work. Record production receipts and a GIF. Cloudflare remains preferred; Freestyle is fallback only if necessary.
**Open questions for Will:** The lead’s existing request: grant codeplanesmithers write access to smithersai/smithers so it can exercise production Member flows. Reported recommendation confidence: 75%; no grant receipt or answer appears. This blocks live proof, not implementation.
Evidence: script-extracted human text and lead text replies from session 6253ecf2, approximately 07:43–09:43 PDT on 2026-10-21; compacted summaries, local-command output, automated notifications and tool blocks excluded. Rulings and queue answers override historical briefs, designs, decisions, proposals, TODOs and rules. Product results are reported evidence; this tracker runs only the maintainer-site build. Existing execution owners are retained; Codex curates documentation.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:34 PDT
**What:** Run one durable Cloudflare sandbox per branch for terminals and agent tools.
**Why:** Production sandboxes are a priority under ARCH-14 and PROC-20.
**Current state:** At 09:27 PDT the lead corrects the earlier image claim: the production image is already published and pinned. Sol and Astra reports recommend retaining the existing Cloudflare Containers implementation rather than adopting the Sandbox SDK. Opus and Fable reports are still awaited; no merged plan or passing production receipt is reported. Remaining gaps are remote-flow migrations, failure-safe sleep/wake and working-copy restoration, and production E2E. Secrets remain disabled.
**Next step:** Merge all four reports, have Opus implement the recovery and host fixes, then prove terminal and agent tools, keep-awake, idle sleep and restored work on production with a GIF. Cloudflare remains preferred; Freestyle is fallback only if Cloudflare cannot meet requirements.
**Open questions for Will:** None new. Provider preference and implementation direction are settled; builders resolve engineering choices.
Evidence: session 6253ecf2, script-filtered user-typed text and lead text replies in the latest approximately two hours through 09:33 PDT; synthetic notifications, tool results and compacted summaries excluded. Rulings and queue answers take precedence over shared briefs/designs, decisions, proposals, TODOs and rules. Product results are lead-reported; this refresh validates only the site build. Execution owners remain unchanged; Codex maintains this tracker entry.
## Earlier tracker history (retained)
## Tracker reconciliation — 2026-10-21 09:24 PDT

**What:** Run a durable sandbox per branch, shared by the terminal and agent tools.

**Why:** Will explicitly prioritizes production sandboxes and requires a four-model investigation followed by implementation.

**Current state:** Local terminal, keep-awake, 15-minute idle sleep and working-copy restore reportedly passed on 10-20. Production does not work: the image has not been published or verified, and the lead reports remote-flow MigrationError. Sol, Astra, Opus and Fable are investigating; no merged report or production success receipt exists. Cloudflare is preferred; Freestyle is the fallback. Secrets remain switched off.

**Next step:** Merge the four reports, compare the Cloudflare Sandbox SDK with the existing provider, and have Opus implement the agreed repair. Prove terminal commands, agent tools in the same branch box, no sleep during work, idle sleep and restored work after wake against production, with a GIF. Coordinate the separate remote-host repair; do not assume its fix alone publishes an image.

**Open questions for Will:** None. The provider preference and investigation/implementation direction are explicit; engineering validation remains with the builders.

Evidence: session 6253ecf2, script-filtered user text and lead replies in the last approximately two hours through 09:23:49 PDT; automated notifications, compacted summaries and tool results excluded. Rulings (including ARCH-14), Will’s queue answers, shared feature/host/panel briefs and designs, decisions, proposals, TODOs and rules were reconciled. Product results are lead-reported; this tracker verifies the site build only. Existing feature execution ownership is retained.

## Earlier tracker history (retained)


## Current specification — 2026-10-20, 16:35 PDT

**What:** Keep one durable restartable machine per branch, with durable tools and persisted working copy.

**Why:** Branch work must survive tabs closing and machines sleeping.

**Current state:** At 16:25 the lead reported machines stay awake while work runs, sleep after 15 idle minutes and save/restore the working copy across restarts. Real-model and closed-tab tool tests passed. Secrets remain disabled pending browser proof; broader sandbox work stays in progress.

**Next step:** Retain restart/lifetime evidence and finish egress proof and remaining sandbox acceptance checks.

**Open questions for Will:** None.

Evidence: lead text replies extracted by script from the session’s latest two hours through 23:34:16 UTC; current rulings and queue answers take precedence over older designs. Reported product-test receipts only; this tracker ran no product tests.

## Prior tracker record (retained)


## What

One sandbox per branch on Cloudflare Containers, one Durable Object each; main's follows main. The branch holds the truth: commits and checkpoints in Code Storage, live Yjs edits and the flow journal in Postgres, a container snapshot only as a warm cache. Every sandbox operation is a durable flow. Jobs on main run in throwaway sandboxes. Multiplayer branches work online only; a single-writer branch also works offline.

Since 22:42 (0005 Q2) a sandbox is only a tool provider: it exposes the machine and its tools (exec, files, jobs, previews) as durable flow steps and knows nothing about agents. The agent binds those tools from its own host ([connecting it all](connect-agents-sandboxes-forge.md)).

## Why

Will: "We need to be able to run most git repos in most sandboxes. I think freestyle supports this so our baseline is using freestyle but look at cloudflare. If cloudflare sandboxes support it natively we will jsut use cloudflare." "These sandboxes should be durable restartable."

## State

- Decision 0005 is proposed. Cloudflare and Freestyle tied at 405 of 500, and Will's "use Cloudflare if native" rule broke the tie. Freestyle stays the fallback behind `Sandbox.Provider`.
- Freestyle wins on Docker and persistent disk but costs about twice as much ($0.13 against $0.06 per awake hour).
- On shutdown Cloudflare allows up to 15 minutes to checkpoint; only an unannounced kill loses edits.
- 21:21 on 2026-10-19: the lead asked Will to accept the recommended answers below in one batch ([design questions](design-questions.md)). No answer yet.
- 22:31 on 2026-10-19: under decision 0011's `flows.local-first-placement`, sandboxes are remote because they need a machine to run code on.
- 22:35: design question 6 of 14 (0005 Q1) asked: is losing running processes on sleep acceptable, given files are always safe, so we can use Cloudflare sandboxes? Cloudflare costs about $14 per branch-month; Freestyle about twice that, and it keeps memory and disk. No answer at 22:36.
- 22:38: Will: "Why would it sleep if running process is happenintg?" The lead: it doesn't; our code renews the idle timer while any job runs. Processes are lost only to leftovers after idle, or a Cloudflare restart with up to 15 minutes' warning, after which the job resumes as a durable flow.
- 22:41: **0005 Q1 answered: Cloudflare.** Will: "So it's durable so sleeping shouldn't cause issues also couldn't we manually kick the container on the backend to stop it from sleeping or something?" Recorded in 0005: sleep is our own decision (`sandbox/Keep`), taken only after 15 minutes with no activity and no running job; Cloudflare's 30-minute inactivity timeout is a backstop we keep re-arming. 0005 stays proposed until Q2 and Q3 are answered.
- 22:41: Q2 asked: the agent's loop stays in the browser and only its tools run in the sandbox.

- 22:42: **0005 Q2 answered yes.** Will: "This is a great question! So we want the sandbox to only expose the sandbox and it's tool and the agent to be independent of that. We want as modular/durable an architecture as possible." Recorded in 0005: the sandbox is a tool provider, the agent runs on its own host (the browser, per 0011) and binds its tools, and either side can change without the other.
- 22:43: **Q3 asked** (question 8 of 14), with each limit as an admin setting changeable without a deploy, like the model roles ([model endpoint](model-endpoint.md)):

  | Limit | Recommended | At the limit |
  |---|---|---|
  | Awake sandboxes, whole deployment | 20 | a new one waits for a slot, shown as "Waiting for a sandbox" |
  | Awake sandboxes per person | 2 | same |
  | Sandbox spend alert | $100/month | alert to Will, beside the model-spend alert ([token-spend alerts](token-spend-alerts.md)) |
  | Snapshots kept | branches touched in the last 30 days | older branches restart from main's snapshot plus their commits |

  The lead's cost basis: about $14 per branch-month for a sandbox that stays busy; with zero users the risk is a runaway agent or a forgotten branch. No answer at 22:46. 0005 stays proposed until it is answered.

- 22:45: **Q3 deferred until we ship.** Will: "Add this as a TODO but we won't worry about this until we ship." Recorded in 0005 under Q3; `todo.md` has a new section, "Sandbox budgets, before we ship", tracked in [sandbox budgets](sandbox-budgets.md).
- **All three of 0005's questions are settled** (Q1 Cloudflare, Q2 the sandbox as a tool provider, Q3 deferred), so this item moves from designing to todo. 0005's status line in the file still reads "proposed". Nothing is built.
- 23:02 on 2026-10-19: the lead's board: features 5 to 7 (sandboxes, secrets, and Qwen in sandboxes) are not started; they "wait for disk space and the agent". The Mac had about 10 GB free at 23:01, and the agent's first slice depends on B1 and the [model endpoint](model-endpoint.md).
- **06:39 to 06:42 on 2026-10-20: the first sandbox has a driver.** Will put "ability to open terminal in an iframe" in his priorities and asked for branch sharing. Panel B's walking skeleton must reach a real shell in a real Cloudflare sandbox: a branch `SandboxObject`, a digest-pinned image, a PTY seam in `@smthrs/sandbox` and a terminal gateway Worker ([branch terminal](branch-terminal.md)). Sol estimates `standard-1` at about $0.047 to $0.074 an awake hour. Status stays `todo` until 0013 merges.
- 13:19:52 on 2026-10-20: the lead's list: "Branch sandboxes, secrets via an egress proxy, agent connected to sandboxes and the forge: not started".
- 13:21:12: the lead: "Branch sharing, branch sandboxes, and connecting the agent to sandboxes: these build on the branch and terminal slice that's still running." So they wait for the [branch terminal](branch-terminal.md) builder. Of the group, only [secrets through an egress proxy](secrets-proxy.md) started (13:22:52), at a seam outside the container and terminal code.
- 13:42:00 on 2026-10-20: the branch workspace slice finished with a real container per branch under `alchemy dev` ([branch terminal](branch-terminal.md)).
- **13:43:30: the lead started the agent-in-the-sandbox builder**, whose brief includes "the sandbox stays awake while something runs" ([connecting it all](connect-agents-sandboxes-forge.md)). Secrets through the egress proxy stay with [secrets proxy](secrets-proxy.md). **Status moved from todo to in-progress.**
- 14:30 on 2026-10-20, on disk, the builder: the machine wakes on the first call or terminal, saves the working copy (commit and binary patch, in the branch object's storage) after every `run` and `write`, when a terminal closes and before sleep, and puts it back on the next generation's first wake; `sandbox/Keep` asks every 5 minutes and puts a generation to sleep after 15 idle minutes, never while a person's process runs ([sandbox tools](../features/sandbox-tools.md#sleep-and-wake)).
- 14:26 on 2026-10-20: the shared dev stack got `0024_sandbox_calls` and an `alchemy dev` restart, so the sandbox tools e2e can run ([connecting it all](connect-agents-sandboxes-forge.md)). 14:30: the same builder wires the [secrets egress](secrets-proxy.md) into `SandboxObject`.

## Next

From 14:30 on 2026-10-20: the sandbox tools e2e, including sleep after 15 idle minutes and wake with the working copy restored. Sandbox limits stay deferred until we ship ([sandbox budgets](sandbox-budgets.md)).

Until 14:30 on 2026-10-20 the next step was, from 13:43 on 2026-10-20: the builder's report on keeping a sandbox awake while a step runs. Sandbox limits stay deferred until we ship ([sandbox budgets](sandbox-budgets.md)).

Until 13:46 on 2026-10-20 the next step was, from 13:21 on 2026-10-20: after the [branch terminal](branch-terminal.md) builder finishes its first slice (a real Cloudflare container per branch), extend that container into the branch sandbox of 0005, with secrets only through the [egress proxy](secrets-proxy.md).

Until 13:21 on 2026-10-20 the next step was: a one-day spike after features 1 to 3. Switch to Freestyle if restoring a 2 GB workspace takes over 30 s, more than 10% of a 20-repo set fails, or the shutdown checkpoint can't finish in time.

## Questions for Will

- Is a 15-minute recovery window acceptable instead of a persistent disk? If not, Freestyle wins. (Answered 22:41: Cloudflare, with our own durable keep-awake timer.)
- Budgets: 20 awake sandboxes per deployment, 2 per person, a $100 a month alert, snapshots kept 30 days? Asked 22:43 as question 8 of 14, each as an admin setting changeable without a deploy. Recommended: yes. (Answered 22:45: deferred until we ship; a TODO, [sandbox budgets](sandbox-budgets.md).)
- None open.
- May the agent's loop run on its own host with only its tools in the sandbox? (Answered 22:42: yes; the sandbox exposes only itself and its tools.)

