# MVP engineering

This is the implementation and verification contract for [PRODUCT.md](PRODUCT.md), with the interaction design in [DESIGN.md](DESIGN.md). Source observations below are a **2026-09-16 22:16 UTC working-copy snapshot**. Work is proceeding concurrently; the release owner must attach the final revisions and executed evidence before claiming a gate complete.

The deliverable is five independently usable repository jobs: Issues, PR review, CI, Features, and Chores. A settings card is one projection of a repository workflow. Saving settings, planning a flow, creating a test issue, or receiving a run ID does not establish that the job works.

## Implementation status

| Component | Observed status | Evidence and limit |
| --- | --- | --- |
| Five starting actions | Built; local unit and built-app browser checks pass | [FirstRunActions.tsx](../../apps/app/src/mainview/cards/FirstRunActions.tsx) selects five registered commands. [Browser tests](../../apps/app/e2e/playwright/repository-setup.spec.ts) exercise the actual bundle, keyboard and SQLite with explicit backend fixtures. New deployed behavior is unverified. |
| Shared setup schema, defaults, candidate identity and client activation checks | Built; focused unit tests reported passing | [RepositorySetup.ts](../../packages/rpc/src/RepositorySetup.ts), [unit tests](../../packages/rpc/test/RepositorySetup.test.ts). These validate typed state and evidence matching, not real execution or server authorization. |
| Setup commands, card, persistence and background controller | Built; browser/focused checks and typecheck pass; broad run had three search timeouts, all passing in the isolated recheck | [Setup flows](../../apps/app/src/mainview/flows/entries/setup.ts), [card](../../apps/app/src/mainview/cards/RepositorySetupCard.tsx), [controller](../../apps/app/src/mainview/state/controller/repositorySetup.ts), [lifecycle tests](../../apps/app/src/mainview/state/controller/repositorySetup.test.ts). Tested: held launch, observed-ID-only run/approval access, chat guidance, signed-out preview, active/draft separation, paused revision, fast prompt typing, persisted reload, explicit PR trials and 320px sizing. Manual Run consumes ordered durable edits; mobile selection closes the drawer and returns focus. [Final frontend verification](implementation/verification.md) records the broad run and isolated recheck separately. [Actual captures and six passing browser scenarios](implementation/README.md) use controlled backend responses and do not prove host execution. |
| Same-origin setup API | **Implemented; local service/type checks pass; deployment pending** | [Routes and validation](../../apps/server/src/repositorySetup.ts), [execution relay](../../apps/server/src/repositorySetupExecution.ts), [durable requests](../../apps/server/src/repositorySetupStore.ts), [tests](../../apps/server/src/repositorySetup.test.ts). The owner reports authenticated candidate-bound handling, compatible VM reuse/provisioning, pinned workspaces, stable Plan/Run keys and Durable Object alarm recovery after the browser closes. No deployed setup canary yet. |
| TypeScript setup executors, repository inspection, actual evals and scoped trials | **Implemented; local native integration and actual-model first run pass; cloud publication and deployed verification remain open** | [Setup executor](../../flows/repository/setup.ts) materializes immutable candidates and routes inspection, eval, trial, apply, pause and manual work. [Four native integration tests](../../.artifacts/repository-native-final-test.log) pass without skips in 95.5 seconds, covering all five jobs, exact public projection results, manual work, author replies and actual source mutation. [Two reproduction checks](../../.artifacts/repository-repro-review-test.log) pass without skips, requiring actual source invocation. The [actual Cerebras first-run test](../../.artifacts/mvp-native-live-20260916/defaults-result.log) passes from empty cases through source-authored evals, investigation, independent judgment, a second trial job and apply. These local host tests use an explicit backend fixture. Complete cloud publication/landing, broader model quality and production remain separate gates. |
| Plue repository-job registration and event delivery | **Implemented; real PostgreSQL integration, route compilation and migration parity pass; deployment pending** | [Service](../../../plue/internal/services/repository_jobs.go), [dispatcher](../../../plue/internal/services/repository_jobs_worker.go), [gateway transport](../../../plue/internal/services/repository_job_gateway.go), [migration](../../../plue/db/migrations/20260916195000_repository_jobs.sql), [routes](../../../plue/internal/routes/repository_jobs.go). The owner tested signed webhook delivery without legacy definitions, native transactional admission, scoped trials, replay, pause/revision fencing, permission revocation and scheduler recovery. No deployed new path yet. |
| Coding without generated knowledge or a compulsory POC | Source implemented; local native-host execution proof reported by its owner | [preparation.ts](../../flows/coding/preparation.ts), [request.ts](../../flows/coding/request.ts), [planning-memory.ts](../../flows/coding/planning-memory.ts), [host.ts](../../flows/coding/host.ts). Deployment and full product-path proof remain required. |
| Wiki, Mythical history and Plugin Library flags | Source defaults off; local flag-path coverage present | The actual first-run, setup and chat paths do not require generated knowledge. Verify every entry and implicit dependency against FLAG-01; complete deployed acceptance remains open. |
| AI-check reuse from Artsy | Compatibility audit completed; product integration pending | [Audit](research/artsy-checks-audit.md) includes current-framework declaration/plan and focused scripted-model checks. Live rubric quality and full application integration remain unverified. |
| Visual design artifacts | Complete review prototypes plus actual local UI captures; detailed AI-check editor pending | [Design](DESIGN.md) contains 23 prototype figures and [six application captures](implementation/README.md). [Prototype capture results](mockups/capture-results.json) record no page errors or external requests and narrow-width checks. Actual application responses are explicitly fixture-backed. Neither set proves production execution. |
| Complete deployed setup → trial → activation → event → useful result | **Not verified** | No new end-to-end setup receipt exists at this audit. Existing practice-run canaries do not establish this path. |

The source inventory in PRODUCT.md distinguishes retained capabilities from planned additions. Do not use the table above to remove an incomplete required behavior from the release.

## Architecture and ownership

```mermaid
flowchart TB
    UI[Chat · command · button] --> CMD[Typed app flow]
    CMD --> DRAFT[Persisted setup draft and request]
    DRAFT --> API[Worker setup API]
    API --> ID[Validated identity and repository access]
    API --> HOST[Current workspace Control host]
    HOST --> FILES[Versioned .smithers flows, prompts and evals]
    HOST --> RUN[Durable execution, approvals and evidence]
    RUN --> API
    API --> CARD[Run and setup projections]
    HOST --> REG[Plue job registration]
    EVENT[Verified forge event or due schedule] --> INBOX[Plue durable admission and dispatch]
    REG --> INBOX
    INBOX --> HOST
```

| Boundary | Responsibility | Primary implementation owner |
| --- | --- | --- |
| `apps/app` | Typed entry points, one editable draft, local persistence, actor attribution, immediate acknowledgment, background observation, evidence and approval UI | App/setup owner; OpenCode owns the pending detailed AI-check prototype |
| `packages/rpc` | Shared serializable schemas and pure matching rules used by UI and service | App/setup owner |
| `apps/server` | Same-origin authentication, validation, repository/workspace resolution, durable request routing and response projection; no browser gateway credential | Worker/setup owner |
| Current TypeScript workflow host | Repository inspection, canonical file generation, eval execution, live trials, immutable receipts, activation proof and actual job execution | Workflow/setup owner |
| `~/plue` | Repository access, trusted event admission, persistent registration/dispatch, schedule delivery and modern Control transport | Execution/registry owner |
| Release | Integrate on `main`, build compatible host/backend/app artifacts, deploy, verify the actual user path, collect evidence | One release owner |

Use the current `Flow.make`, `Action.make`, Effect and Control runtime. The [coding host](../../flows/coding/host.ts) already composes native Control/Equipment, a registry, an executable catalog, persistent engine/control stores and explicit approval authority. Extend that infrastructure. Do not send current flows through a legacy JSX executor or introduce another workflow language.

The existing Worker [workflow service](../../apps/server/src/workflows.ts) validates an allowlisted signed-in session and resolves the repository/workspace gateway using that identity. [gatewayRpc.ts](../../apps/server/src/gatewayRpc.ts) permits a bounded procedure set: `Plan`, `Run`, `Cancel`, `Resume`, `Steer`, `Signal`, `List`, `Projection.Snapshot`, and `Approval.Submit` at their correct mounts. It interprets framed success/failure responses; HTTP 200 alone is not success. Raw `/rpc`, `/sync` and `/projections` proxy retirement remains intact. The new setup API must use the owned authenticated path.

The current trigger read path uses `List({_tag: "triggers"})` without provisioning a workspace on a read. Its empty webhook list does not establish that no channels exist: that API has no channel-list operation. The new repository-job registry must expose its own actual registrations and delivery evidence.

New setup uses the existing workspace API with `required_capability: "repository-jobs/v1"`; the Worker selects or provisions a compatible VM without disrupting an older primary host's jobs. A new frontend card does not inherit its ambient computer. Once the server returns the selected workspace, every retry, revision and manual run stays bound to it. The Worker still preflights an explicit established binding; it cannot silently move it to another host.

Plue binds supported provider credentials through its fixed-host/header egress proxy; raw platform credentials must not enter guest configuration. Repository settings retain precedence over authorized subscriptions, which retain precedence over platform defaults. Existing incompatible provider state fails explicitly instead of silently switching providers. [Bootstrap implementation](../../../plue/internal/services/workspace_provider_connections.go) has local tests reported passing; a fresh ordinary-user live completion remains an open gate.

## One setup state through three doors

The five public commands are `issues.setup`, `review.setup`, `ci.setup`, `feature.setup` and `chores.setup`. Buttons, slash commands and agent calls resolve those same typed entries. `setup.guide`, `setup.configure`, `setup.view`, `setup.work`, `setup.run` and `setup.retry` operate on their shared card state; they are not separate implementations.

Persist the draft and request through the actor-tagged dispatcher into the existing TanStack DB/SQLite state. Component-local state cannot become an alternative source of truth. Use event/controller lifetimes, not React effects. Late results must be discarded when the request, account or candidate is no longer current. Account switching must not resume another account's work.

The initial human setup queues one existing agent turn after real inspection; `setup.guide` supplies a fresh candidate/evidence read and asks one short question at a time. Manual settings remain editable. Issues and Feature setup offer an optional `ci.setup` link while the same owner has no enabled CI job; successful issue creation offers the same link in the deduplicated shared toast stack. Feature setup keeps an optional approved-issue connection. These links never create a global prerequisite.

New output embeds in chat. Maximize uses the same component and state after an explicit human action. Missing inputs use the existing form machinery, with keyboard focus handed to the form only for the human's own invocation. An agent may propose or render a confirmation; it cannot silently answer a human approval.

The default candidate has automatic investigation steps **after activation**, draft-first replies, manual POC/fix/split, and human approval to land. All five jobs start inactive. A default step marked `automatic` is configuration, not a registration or permission to run. Use PRODUCT O-01–09 for the remaining owner-selected defaults.

The actual setup UI currently exposes draft replies only. An older automatic candidate stays visibly unavailable until the maintainer explicitly changes it; no policy is silently rewritten. Native activation validates authoritative repository source and rejects unsupported GitHub publication. Automatic external replies are not delivered by this MVP implementation yet.

After activation each enabled step has a manual work door. `setup.work` edits a separate persisted `manualDraft`; changing the requested issue or task does not change the policy digest or invalidate its evals. `setup.run` with operation `run` carries `{stepId,prompt,subject?}`, requires an active revision/digest match, and reuses the same durable request after a lost response. Policy, view, work edits and request admission share an ordered persistence queue so immediate Run uses the newest prompt and subject. Network execution stays outside that queue. The UI uses the observed job ID for its run and approval links, preserving the wrapper separately. Local unit and actual bundled-browser checks pass; deployed host dispatch remains a separate gate.

## Request state is separate from execution state

The current shared model has a persisted `SetupRequest` with `requested`, `running`, `completed` or `failed`. A host `SetupReceipt` separately records `queued`, `running`, `waiting`, `completed`, `failed` or `stopped`. Preserve both facts.

```mermaid
sequenceDiagram
    participant U as User
    participant A as App controller
    participant W as Worker and host
    participant E as Durable execution
    U->>A: Run trial
    A->>A: Persist request ID and candidate
    A-->>U: Requested
    A->>W: Submit same durable request ID
    W->>W: Persist/deduplicate intent
    W-->>A: Queued receipt
    W->>E: Launch or recover execution
    A->>W: Observe request
    W-->>A: Running or waiting receipt
    E-->>W: Authoritative completion/failure
    A->>W: Observe request
    W-->>A: Terminal receipt and evidence
    A-->>U: Settle toast and update card
```

| Event | Required behavior |
| --- | --- |
| Launch still unresolved | Return after local persistence; keep chat/navigation usable. Start the shared toast after its existing 300 ms debounce. |
| Launch acknowledges a queued/running job | Keep the toast running through execution. A request ID or run ID cannot settle it. |
| Repeated click or command | Reuse the pending request. Server-side deduplication must also hold after reload or another client submits it. |
| Lost POST response or observation failure | Retain the last authoritative execution phase and evidence. Show connection/request failure separately and reconnect using the same request ID. Do not assert that the remote job stopped. |
| Recorded terminal execution failure | Keep its receipt; an explicit retry creates a new attempt ID. |
| Draft edited while work runs | Preserve the old run and active policy, but do not apply its result to the new draft. A discarded UI projection does not cancel the remote run. |
| Reload | Reattach to the stored request and original run. Do not replay an outward action from an empty component state. |
| Account, repository or workspace changes | Bind all observation and mutations to the original authorized scope; do not accept a stale response into the new scope. |

The setup controller already tests unresolved launch, running remote response, duplicate command, lost response, terminal failure retry, stale edit, reload and account mismatch using controlled responses. Server crash/retry tests and deployed browser tests must establish the corresponding real guarantees. The existing practice canary found a separate observation-loss/STOPPED defect; its repair must not be confused with proof of the new setup lifecycle.

## Immutable candidates and evidence

The current `setupCandidate` is SHA-256 over schema-parsed `{ repo, job, revision, draft }`. Editing a meaningful draft field increments the revision, moves old eval/trial receipts into retained history, and leaves the last active policy unchanged. View and selection changes do not alter the candidate.

A digest is a matching key, **not authorization or proof of execution**. The server must canonicalize the repository and workspace, recompute the candidate, and obtain evidence from its own trusted store. It must never accept a browser-supplied `passed`, registration ID or receipt as activation authority.

The implementation needs these distinct identities:

| Identity | Purpose |
| --- | --- |
| Account + repository + workspace + job | Authorization and storage scope. Validate ownership/access on every operation. |
| Request ID + immutable request fingerprint | Deduplicate a single operation. Reusing an ID with different scope/operation/candidate must fail. |
| Candidate revision + configuration digest | Match the exact editable settings/prompts/expectations under review. |
| Immutable source revision | Identify the committed `.smithers` definitions actually loaded and tested. Preserve case-specific source revisions for historical eval inputs. |
| Control execution digest + reviewed envelope | Identify the executable and its permitted flows/capabilities/budget. Do not confuse this with the configuration digest. |
| Run/execution/artifact IDs | Resolve actual observations and outward effects. A model-generated string is not an execution record. |
| Registration ID + policy revision | Identify the activated version independently of an editable draft. |

Before applying a candidate, the trusted service must verify all of the following atomically or through a fenced transition:

1. The authenticated actor still has write access to the exact repository/workspace. The candidate is current and is not paused or superseded by a conflicting revision.
2. Definitions, prompts, checks and eval cases correspond to the immutable source revision and configuration digest. Loading the executable yields the expected Control digest and reviewed envelope.
3. A completed eval execution exists for that candidate. Every required case has exactly one passing result and resolvable evidence. Failed, error, review, absent, duplicate or stale required results hold activation.
4. A completed scoped live trial exists for the same candidate. Its event, run, source and artifact receipts establish the actual capability. Issues need a real issue identity; PR review needs a real PR identity.
5. The user explicitly requests activation with the reviewed scope and outward-effect policy. Recording configuration alone cannot do this.
6. The registry acknowledges the exact active revision. Only that acknowledgment permits the app to project it as enabled.

The client currently performs a subset of these checks for useful feedback. Its `sourceRevision` is an optional receipt field and its arrays do not enforce globally unique step/check/case IDs. The server implementation must strengthen those constraints and evidence provenance; copying the client predicate is insufficient.

## Repository-owned files and runtime storage

Flows, prompts and eval definitions belong under `.smithers/` and must remain usable through the open-source framework. Generated settings need a documented round-trip: reading a reviewed file version produces the same candidate, and editing a prompt invalidates affected results. Do not maintain a second hidden configuration that overrides repository files.

The current [materializer](../../flows/repository/setup.ts) writes `.smithers/repository-jobs/<job>/<digest>/candidate.json`, `evals.json` and `prompt-<step>.md`, plus `.smithers/flows/repository-jobs/<job>/<digest>/flow.mdx`. The host entry is `repository/setup`; job dispatch uses `repository-jobs/<job>` and the current `repository/RunJob` interpreter. Existing differing candidate bytes are rejected, paths must remain inside the repository, and the candidate is snapshotted through JJ. The generated declaration presently uses a finite 200,000-token ceiling and the chosen minutes converted to milliseconds. Preservation, declaration loading and exact candidate round-trip remain part of native integration acceptance, not a claim based on file existence.

Run databases, request records, eval results and secrets are not ordinary generated source. Keep durable execution/control state outside the working checkout, as the coding host already requires. Store evidence with its request/run identity and immutable references, and project it back into the card. The browser's last 50 receipt summaries are a convenience, not the sole audit record.

Loading a new candidate must not mutate an already active flow in place. Either load the exact committed definition per dispatch or retain a versioned executable bound to that revision. If a source file changes without a reviewed activation, hold or continue the prior pinned policy according to the recorded version; never silently execute the edited bytes under an old digest.

## Setup API and executors

The app currently submits `POST /api/repository-setup/{inspect,evaluate,trial,apply,pause,run}` with `requestId`, `repo`, `job`, `draft`, `revision`, `digest` and optional `workspaceId`. It observes `GET /api/repository-setup/request?requestId=…&repo=…&job=…`. The response includes matching request/candidate identity and either an inspection result or a host receipt. Keep the shared contract synchronized when adding necessary typed fields.

| Operation | Actual work required | Completion evidence |
| --- | --- | --- |
| Inspect | Read bounded current source, CI, issues/PR history and existing automation; distinguish missing source from failed access; propose an editable repository-specific candidate. | Read paths/URLs and revisions, disclosed missing/failed inputs, suggested draft. An empty history produces an honest default. |
| Evaluate | Materialize reviewed definitions, run executable cases on their actual inputs, compare observations with human-reviewed expectations, and preserve human-review cases. | Case execution IDs, expected/observed results, source/prompt identity, commands or artifacts, semantic judgment where appropriate. |
| Trial | Run the real capability on a bounded, explicitly previewed target through its real transport and effect path. | Scoped target, event/delivery identity where relevant, completed run, outputs/checks, permission decisions and exact source. |
| Apply | Revalidate trusted evidence and authority, bind the immutable executable and reviewed envelope, then register future work. | Actual registration ID/version and source revision. Never infer success from file creation. |
| Pause | Disable future admission for the owned active registration and record the outcome. | Registry acknowledgment. Already running work remains visible and follows its separate stop/approval controls. |
| Run | Dispatch exactly one requested enabled step against the matching active candidate. Resolve the supplied issue/PR source and number through the trusted host; feature/chore requests include their actual work prompt. | The setup wrapper run and the dispatched `jobRunId`, current job phase, real evidence and approvals. A completed wrapper with no job execution is not success. |

Persist server intent before acknowledging acceptance. A durable inbox/outbox or equivalent transactional handoff must survive a crash between persistence, launch and response. A worker promise kept alive by the HTTP request alone is not sufficient. One request ID must resolve to the same execution across retries; a genuine new attempt gets a new ID.

The implemented [request store](../../apps/server/src/repositorySetupStore.ts) reuses the existing `GatewaySessionRegistry` Durable Object, keyed by validated login, rather than creating a new Worker identity. It records input, Plan, run, receipt and observation error; rejects conflicting request identity; uses a per-object lock and version comparison; and bounds a record to 120,000 bytes so large outputs use artifact references. Its Plan contract names `repository/setup`. Routing, modern workspace reuse/provisioning and alarm-based recovery are wired and locally tested. Full integration with native trusted receipts, compatible deployed hosts and closed-browser execution remains required.

The host should expose these as ordinary registered flows/actions with typed outputs, bounded concurrency, time/token limits and explicit approval nodes. The Worker authenticates and projects them; it should not become a second model orchestration engine. Implement real inspection and eval cases before treating the generated prompts as a finished setup.

**Trial targets:** the current host uses Plue's idempotent reserved native test issue for each job. The trial registration is restricted to that exact native source/number and `issues/opened`; it provides the isolated invocation stimulus. CI and review select a real PR through the Test view's Source and PR number controls. Those controls preserve the existing host input, serializing `{source,number}` into `trialBody`; a repository-matching GitHub PR URL from inspection is also supported. The host fetches the actual selected PR and captures immutable head/base; missing or mismatched real input fails. Feature and chore trials execute their configured non-off step and return an actual checked immutable proposal without landing. The host observes the real dispatched native job and requires successful nonempty results. An isolated issue stimulus does not prove the later PR webhook or schedule path, which retains its own release checks.

## Plue registration and event delivery

The following contract is implemented in the shared Plue working copy. Its owner reports twelve real PostgreSQL integration tests passing without skips, route/server regression checks passing and migration-to-schema dump parity. Deployed execution remains unverified.

| Route | Authority and purpose |
| --- | --- |
| `GET /api/repos/{owner}/{repo}/repository-source` | Repository-read-authorized forge identity from current mirror mapping or ready import provenance; conflicting mappings fail. |
| `PUT /api/gateways/{gatewayID}/repository-jobs/{job}/manual/{requestId}` | Host-only single-step work on an active exact revision. The service fetches the supplied issue/PR source itself, deduplicates the request across revisions, and preserves human gates. |
| `PUT /api/gateways/{gatewayID}/repository-jobs/{job}/trials/{requestId}` | Host-only scoped native test-issue creation. Trial request, issue and outbox commit atomically; exact retries return the same identity. The result has a real source/number/API path, with no invented browser URL. |
| `PUT /api/gateways/{gatewayID}/repository-jobs/{job}/comments/{step}` | Host-only native issue reply, bound to candidate/delivery/source/step. Comment, receipt and outbox commit atomically. Exact concurrent retries return the original comment, including after deletion; another step after pause is refused. |
| `PUT /api/gateways/{gatewayID}/repository-jobs/{job}` | Host-only gateway bearer; binds repo, workspace and activator, then rechecks current write permission. Register a tested trial or active job. |
| `GET /api/repos/{owner}/{repo}/repository-jobs` | Repository-read-authorized registration projection. |
| `GET /api/repos/{owner}/{repo}/repository-jobs/{job}/dispatches` | Repository-read-authorized delivery/run evidence. |
| `POST /api/repos/{owner}/{repo}/repository-jobs/{job}/pause` | Repository-write-authorized pause of that repository job's registrations; authority comes from the validated maintainer, not a claimed browser owner. |

Registration carries `repo`, `workspace_id`, `flow_id`, `revision`, SHA-256 `digest`, immutable Git `source_revision`, `execution_digest`, reviewed `envelope`, `mode`, event rules, optional label/schedule, and `input` containing the reviewed draft. A trial also carries one real `trial_issue_number` and `trial_source` (`github` or `smithers-cloud`). The browser cannot manufacture the host's activation proof.

The service requires finite positive token/time limits and a bounded envelope. Only a newer revision or exact enabled idempotent retry can update the registration. A paused revision cannot be resurrected by a delayed retry. Enabling a job retires its matching trial. Future-event scope must not accidentally process the historical backlog.

The first migration has four tables for registrations, admitted events, dispatches and trial requests, with transactional native issue/comment/label triggers. A following [comment-receipt migration](../../../plue/db/migrations/20260916205500_repository_job_comments.sql) adds durable publication identity. The [workspace-capability binding migration](../../../plue/db/migrations/20260916233000_workspace_capability_bindings.sql) pins one supported VM per repository, actor and capability; concurrent creation reuses the same identity and preserves the older primary workspace. Existing registered bindings stay exact. GitHub automatic publication through this new bridge is currently unsupported and returns HTTP 400; it must not be presented as enabled without another implemented, tested publication path.

- Admission is persisted before acknowledging the trusted upstream job. GitHub delivery identity comes from the HMAC-verified job and signed body, not an untrusted `X-GitHub-Delivery` header. Native events use a stable persisted UUID identity. Their outbox rows commit in the same transaction as the actual source mutation; rolled-back mutations admit nothing.
- Retaining admitted events closes the race where the real test issue's event arrives before its trial registration. Trial matching must remain restricted to that exact source and number.
- Dispatch uniqueness is `(registration, revision, delivery key)`. A fenced lease prevents a crashed or slow dispatcher from settling another worker's claim.
- Persist Plan bytes before Run. Resolve the modern host using the stored repository/workspace/activator, then compare the returned execution digest and envelope with the registered ones.
- Automatic dispatch may approve the reviewed **Plan target only**. Human approval nodes inside execution remain human decisions. Recheck that the registration is enabled/current immediately before Run.
- Control idempotency keys remain stable across lost responses. No generic HTTP retry may create another public action. `submitted` means accepted by Control, not that the job completed.
- An author reply signals `repository-job.author-reply` to the related live run, including a nested wait. Ambiguous transport retries retain the same Signal key. An explicit `NoMatchingWait` permanently refused that command, so only that response advances the persisted signal attempt before bounded retry. The registry owner reports this behavior tested. Reporter text remains data, never authority to change the policy.

Chore schedules accept a five-field cron string. The app now labels it UTC, matching the registry scheduler; the draft has no separate timezone field. **Remaining UI contract:** expose the service's computed `next_fire_at` in the setup receipt and projection. Registry recovery/dedup tests pass; complete product proof must still cover the displayed next execution, clock boundaries and pause. A raw cron field does not satisfy CHORE-02/03.

## Job behavior and shared composition

| Job | Executor obligations | Product requirements |
| --- | --- | --- |
| Issues | Run independent research, duplicates and applicable reproduction in parallel; aggregate useful findings; ask a precise author question when needed; signal resumption; keep internal failure with the maintainer. POC and real fix are independent bounded invocations. Decomposition proposes children before creating them. | ISS-01–15 |
| PR review | Capture actual base/candidate revisions and context, detect existing review responsibility, produce actionable or clean results, update the same review after commits, obey configured feedback/approval permission. | PR-01–04 |
| CI | Discover existing GitHub workflows and environments; reuse current checks; execute command and optional AI checks on the proposed source; bind required results to the exact candidate and policy. | CI-01–08 |
| Feature | Accept direct work without mined history; optionally suggest a specific reusable pattern with real merged-PR evidence; author an ordinary flow and execute a real example with current checks. | FEAT-01–04 |
| Chores | Accept a direct maintenance task or history-supported pattern; support selected manual/event/scheduled invocation, bounded correction, no-op completion, independent landing permission and pause. | CHORE-01–03 |

Checks are composable flows, shared by issue fixes, PR review, features and chores. Existing external CI may already satisfy policy; its absence from Smithers setup must not force re-creation. Offer the contextual CI setup action when useful and dismissible, without blocking investigation or direct work.

The current [preparation selector](../../flows/coding/preparation.ts) enables Wiki only from host configuration; a request cannot turn it on. The default [planning memory](../../flows/coding/planning-memory.ts) gathers bounded source and resolved native history, validates freshness, and omits Wiki checks when disabled. [Source collection](../../flows/coding/planning-sources.ts) bounds reads, rejects paths escaping the repository and checks whole-file digests. It does not silently generate knowledge.

[RunRequest](../../flows/coding/request.ts) now prepares/adopts a plan and coordinates implementation without an intervening POC. The separate prototype flow remains available. Release proof must exercise both paths with Wiki/Mythical artifacts absent, including fresh checks and the selected landing approval. A feature flag must not disable ordinary native history, source access or the retained desktop/terminal/build tools.

## AI checks and evals

Reuse the tested current `S.Agent.Lint`/Action-backed examples identified in the [Artsy audit](research/artsy-checks-audit.md). The older `createSmithers`/JSX wrapper is not source-compatible. The audit supports local declaration/planning and focused enforcement behavior; it does not prove a live observability rubric makes good decisions.

An AI check consumes the correct proposed diff, affected application call sites and supporting conventions/helpers. Supply explicit source context to a reviewer that cannot fetch more. A clean committed PR must still be reviewed against its actual base. Store the checked source revision and readable prompt/rule. Return actionable findings, a pass, or an execution/context error; never collapse the last case into pass.

Start new rules report-only. Required status is a reviewed policy change after representative evals and a real trial. Repair runs separately from final judgment and must recheck the resulting source independently. Do not let the implementing agent modify the rubric or expectations to pass its own work.

The setup agent must author actual repository-specific eval inputs and expected outcomes with the human. New drafts start with no eval cases. Repository inspection authors executable cases for the maintainer to review; it must not invent default prose cases for infrastructure behavior that a single job cannot exercise. Delivery deduplication, crash recovery and author-reply continuation have separate real integration tests. Model-assisted semantic judgments are useful for duplicate quality or review usefulness; deterministic facts such as command execution, permission, version identity, deduplication and public effects need direct assertions.

Required coverage includes true/false duplicate, known repro, author reply/resumption, internal failure, repeated event, POC cannot land, direct fix without POC, clean committed PR, missing telemetry and compliant/exception changes, stale candidate, unauthorized scope, schedule/pause, and no generated knowledge. Trace the full matrix in PRODUCT EVAL-05. Expected, observed, case source, execution/artifact identity and unresolved human judgment stay inspectable; old evidence remains visibly stale after edits.

## Verification plan and release ledger

Each release result must name the requirement, tested app/backend/host revisions, candidate/source identity, actual command or browser path, outcome, and an evidence artifact. Unit tests with scripted responses, prototype screenshots, local host execution, and production canaries are different evidence classes. Keep that distinction in the ledger.

The [frontend verification record](implementation/verification.md) retains the final local outcome: 4,301 passing tests, seven opt-in host skips and three SearchSeam timeouts during concurrent checks; the unchanged 21-test SearchSeam file then passed in 2.55 seconds without changing timeouts. App typecheck and all six bundled-browser scenarios passed. This is transparent combined evidence, not a claim that one broad suite passed cleanly.

| Gate | Required engineering proof | Status at audit |
| --- | --- | --- |
| REL-01 | Product/design/engineering agree; exact file layout and host flow contracts recorded; visual gaps resolved or explicitly reviewed | Documents and current file/host contracts recorded; detailed AI-check visual follow-through pending |
| REL-02 | Five real first actions for signed-out practice and signed-in alpha; shared typed doors; keyboard and missing-input focus on the actual site mount | Local unit and built-app keyboard/320px checks pass; actual deployed mount pending |
| REL-03 | Unresolved launch, running job, duplicate, reload, lost response, stale edit and failed execution across app/API/host; toast follows execution | App controlled-response and Worker durable/restart coverage pass; full host/deployed proof pending |
| REL-04 | Real issue event → parallel work → repro/clarification → author reply → matching eval/trial → activation → future event; unrelated work untouched; direct fix with approval | Not verified |
| REL-05 | Existing CI discovery; actual command results; live AI violation/clean/error cases; clean committed PR; exact-source required gate | Artsy compatibility and three native CI tests reported passing; live model and full product path pending |
| REL-06 | Real scoped PR, changed-commit review, no duplicate feedback, clean/defect evals and permissions | Not verified |
| REL-07 | Direct feature, repository-authored reusable flow, real chore; chosen schedule/event path, bounds, pause and restart | Not verified |
| REL-08 | Server rejects forged/stale evidence, edits preserve active version, full old results remain inspectable, required cases and reviewed replacement pass | Client, Worker request binding and Plue replay/authority tests pass; full native/deployed proof pending |
| REL-09 | Retained inventory source audit plus relevant web/native regression evidence, including real workspace terminal and desktop | Inventory documented; release smoke pending |
| REL-10 | Removed features absent across entry/deep-link/agent/docs; default-off flags enforced; no-Wiki/no-forced-POC execution; protected tools retained | Local coding proof reported; complete release audit pending |
| REL-11 | Ordinary authorized non-admin account, repository access, exact trial scope, outward-effect/landing approvals, external input, duplicate delivery and revoked access | Saved canary account is admin; ordinary non-admin proof pending |
| REL-12 | Compatible deployment receipts, actual complete user paths, copy/responsive/keyboard polish, failures repaired and retested | New release not deployed/verified |

Add focused tests at the boundary where a failure can occur:

- **Pure contract:** candidate changes, unique IDs, exact receipt operation/revision/digest, required-case states, all-off/label constraints, explicit scope and immutable source validation.
- **App:** all three doors, actor ownership, persisted acknowledgment, lifecycle/reconnect, edits and stale results, embedded/maximized identity, keyboard-only setup, narrow screens and explicit active/draft/pause state.
- **Worker/host:** signed session/access, malformed or conflicting request IDs, server-held receipts, crash after persistence/launch, lost response, materialization round-trip, real eval outputs, source drift, exact apply/pause acknowledgments.
- **Registry:** verified-body admission, trial creation race, unrelated event exclusion, future-only scope, pause/revision fencing, permission revocation, lease recovery, Plan/Run/Signal retries, digest/envelope mismatch, human-node preservation, schedule recovery.
- **End to end:** disposable scoped repository targets through the deployed site, real model/tools, actual issue/PR delivery, useful output, evals, active policy, repeat event and failure recovery. A signed-in admin path cannot stand in for an ordinary alpha user.

Relevant local commands are `bun test packages/rpc/test/RepositorySetup.test.ts`, focused setup/app tests, `pnpm --filter smithers-app run check`, and `pnpm --filter smithers-server run check` plus its relevant tests. Package names and check scripts were verified from the current manifests. Plue uses focused `go test` packages, `zig build sqlc` after query changes, and schema/migration checks. The release owner should run required suites once against the integrated revision and expand coverage only for changed boundaries or unresolved failures.

## Integration and deployment

All work lands on and is pushed to `main` using the repository's `jj` workflow. Reconcile concurrent changes before release. Temporary workspaces are for isolated changes and are removed after landing. One release owner coordinates the Worker, Plue API/migration and workspace host artifacts so that incompatible versions cannot be advertised as ready.

For the app/Worker, follow the current [Worker runbook](../../apps/server/DEPLOY.md) and [deploy script](../../apps/server/scripts/deploy.ts). The deployment serves the Astro site build containing the app at repository URLs. Preserve Worker identity, domains, Durable Object names/bindings/storage and kept secrets. The live identity preflight is the identity verdict; a bundle dry-run cannot establish it. Record the resulting version/build receipt and verify apex and canary against that revision.

For Plue, use its [deploy script](../../../plue/scripts/deploy.ts) and current live configuration, including the repository-job migration and compatible product-gateway/coding-host artifacts. Its older narrative deployment guide contains historical topology; resolve target identity from the current script/preflight and live state. Use the script's coordinated phases and deployment lock. Do not assume an API-only image update also refreshes already provisioned workspace executables.

Deploy the compatible service and host capability before exposing a successful setup path. Missing capability, unregistered flow, unavailable workspace or version mismatch must yield an honest retryable error, not a success-shaped stub. Verify one newly provisioned and one existing/resumed workspace. Record a rollback that preserves durable request/registration data and leaves unsupported automation paused rather than silently dropping it.

The user explicitly authorized implementation and deployment in this session; the release owner holds that responsibility. This document does not request a new permission gate. Its verification requirements still apply before declaring the MVP ready.

## Remaining decisions and risks

| Item | Required resolution before the related gate passes |
| --- | --- |
| Exact `.smithers` paths and exported setup/job flow IDs | Current materializer paths and host entry IDs are recorded above. Complete native round-trip and immutable declaration-loading proof. |
| Durable setup request/evidence store | Existing-gateway-DO request/identity/restart behavior is implemented and tested. Finish native authoritative receipt/apply and full closed-browser product integration proof. Browser storage alone is insufficient. |
| CI/Feature/Chore trial target | The isolated native issue stimulus is implemented. Finish actual PR comparison, checked feature/chore output, and each selected live PR/event/schedule-path proof. |
| Schedule timezone and next run | Add typed timezone or explicit UTC behavior and display the computed next execution; test recovery and pause. |
| Full reviewed budget | Derive finite token as well as time limits in the actual Control envelope; a UI minutes field alone is insufficient. |
| Case/source materialization | The inspector authors executable repository-specific cases; defaults contain none. Bind reviewed case inputs to tested definitions and prove unique IDs and actual observations. |
| Active revision replacement | Prevent concurrent/out-of-order apply, paused-policy resurrection and edited-file execution under old evidence; show old active and new draft clearly. |
| Event and public-action replay | Verify stored Plan/Run/Signal identity plus effect-level deduplication. One submitted dispatch does not itself prove one comment or one landed change. |
| Workspace version compatibility | Existing or resumed gateways must actually expose the reviewed flow/digest; deploy artifacts and prove both old-workspace recovery and fresh provision. |
| Compatible workspace within the free quota | Reuse an already compatible primary workspace before provisioning another VM; prove the one-sandbox account path without moving an established setup or disturbing old jobs. |
| Visual and access proof | Finish detailed AI-check design and state polish; verify keyboard/focus on the deployed Astro mount and ordinary non-admin setup. |
| Repository Markdown links and images | CT034 confirmed relative links/images use the website URL after file identity is dropped at the Markdown editor boundary. Preserve explicit repository/path/read revision through typed file navigation; use authenticated bounded bytes for cloud/local assets. The read-only assessment is complete; implementation is not included in this frontend baseline. |
| Release claims | Replace this snapshot with linked final evidence. Configuration-only, scripted-model and prototype results remain labeled until real integration passes. |

CT034 is an existing alpha defect, not a repair in this baseline. Direct file access works; repository-relative Markdown links and images do not. [FileCards.tsx](../../apps/app/src/mainview/cards/FileCards.tsx) passes content into [MarkdownEditorSurface](../../apps/app/src/mainview/MarkdownEditorSurface.tsx) without repository/path/read identity. The generic [Markdown adapter](../../packages/smithers/ui/src/adapters/markdown-editor/MarkdownEditor.tsx) has no link or image resolution callback. The follow-up should keep the adapter generic and resolve repository targets in the app before invoking the typed file door, including keyboard activation and bounded `../` normalization.

Asset support also needs a truthful byte/revision boundary. [FilesSeam](../../apps/app/src/mainview/state/seams/FilesSeam.ts) currently reads the default head without `?ref`; its `readAt` is inventory metadata. [DiffFilesSeam](../../apps/app/src/mainview/state/seams/DiffFilesSeam.ts) already demonstrates explicit immutable reads. The local [RepoFiles handler](../../apps/app/src/bun/RepoFiles.ts) intentionally omits binary content. Plue's [repo-host client](../../../plue/internal/repohost/client.go) carries base64 encoding and a `TooLarge` marker, but [GetRepoContents](../../../plue/internal/services/repo.go) drops those fields and labels the result UTF-8. Preserve limits and real source identity before rendering authenticated image bytes; public GitHub raw URLs cannot stand in for private or local access. Ownership should split app/adapter navigation from the bounded backend asset contract, with a real nested-document/image canary after integration.
