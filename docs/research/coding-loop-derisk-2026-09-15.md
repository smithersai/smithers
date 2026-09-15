# Coding-loop derisk on production, 2026-09-15

One lane's log of driving `coding/request` against the production fixture
`codeplanesmithers/canary-sandbox`, issue #53 ("Add a Purpose section to the
README"), on plue `f9f9a24a` with the coding host hot-patched to smithers main
`4902c07589`. Written so the findings do not live only in a scratchpad.

## Result

The coding flow runs end to end on production. Two real jj Changes were created
by the flow on the fixture, checked by the repository's own configured checks,
and corrected once each:

| Change | Commit | Description |
| --- | --- | --- |
| `zmrusltzylln` | `a6a8808fd207` | Add Purpose section to README.md |
| `pqukkllnkkuy` | `04bd232ec7ac` | Edit README.md to replace the existing Purpose paragraph with one that includes the required keywords |

Both runs finished with `outcome.status = "blocked"`: the required `fast` check
(`assert 'disposable' in section and 'production' in section and 'test' in
section`) failed because the implementation model wrote weaker prose than the
issue asked for. Nothing landed. `main` on the fixture is unchanged at
`a15a30d462b7` ("Ignore the coding host state directory").

Workspace left running for follow-up: `f9705dc9-9635-4c1d-931c-c55ada7e094b`
(`kind=vm`, gateway `90a23b3f-94ff-4667-9cb2-98c5e2f3caeb`). Its
`/usr/local/bin/smithers-coding-host` is the hot-patched bundle and
`/usr/local/bin/smithers-jj-export` was installed by hand; the coding host
process is stopped, so the next `POST /api/workflow/provision` recreates it.

## What is proven to work on production

- A fresh `kind=vm` workspace reaches `running` in about 20 s and its gateway is
  `ready` about 5 s later.
- `Plan` then `Approval.Submit` then `Run` over `/api/workflow/rpc` starts
  `coding/request` on the workspace-bound gateway.
- `coding/RefreshWiki` and `smithers/Wiki` complete `verified`.
- The nested planner clarification is rolled up to the root run
  (`status: waiting-approval`, one `approvals` row with `waitRunId` and
  `requestId: coding-clarification#1`) and **`Approval.Submit` with an `answer`
  resumes it** — smithers `76fae281` works against a live host.
- `coding/implementation` creates native jj Changes; `checks/fast`,
  `checks/slow` and `checks/wiki` run against an exported immutable tree;
  `coding/CorrectPlan` opens a repair round and reports `blocked` with the
  failing check's message.
- smithers `2e49585f` works: host state lives at
  `/home/developer/.smithers-coding-state/workspace/.flows/`, nothing inside the
  working copy, so `stale_revision` from a moving tree digest is gone.
- Per-sandbox egress secret substitution works: the guest holds a 14-character
  placeholder for `GEMINI_API_KEY` / `CEREBRAS_API_KEY` / `OPENAI_API_KEY` and
  the proxy swaps the `authorization` header.

## Defects found

### plue — NixOS workspaces have no `smithers-jj-export` (blocks every run)

Every `kind=vm` NixOS workspace is missing `/usr/local/bin/smithers-jj-export`,
so `coding/request` dies in 13 s:

```
stale_revision: Prepared source could not be verified:
  [Errno 2] No such file or directory: '/usr/local/bin/smithers-jj-export'
```

The payload is staged correctly — `/tmp/smithers-workspace-jj-export.b64` is
present in the guest and the helper is in the API image at
`/usr/local/lib/smithers/smithers-jj-export`. The guest bootstrap log says:

```
smithers workspace bootstrap: installed smithers cli
smithers workspace bootstrap: jj export helper runtime smoke failed
smithers workspace bootstrap: global smithers pack init failed; continuing
```

`internal/services/workspace_scripts/bootstrap-nixos.sh.tmpl:75-78` smoke-tests
the helper with `runuser -u developer -- env -i ... --version` and **deletes it**
when that fails. Running the identical command minutes later succeeds, so the
smoke races NixOS activation: the helper is a Debian glibc dynamic PIE whose
interpreter is `/lib64/ld-linux-x86-64.so.2`, which on this guest is a symlink
into nix-ld created during activation. Fix by retrying the smoke, by not
deleting the helper on a failed smoke, by installing after activation, or by
linking the helper statically.

### plue — the landing API `coding/vibe` needs does not exist

`flows/coding/landing.ts` calls four endpoints. Three are absent from prod and
from plue `main` (`81c3ee30`):

- `POST /api/repos/{o}/{r}/landings/append/prepare` — missing
- `PUT  /api/repos/{o}/{r}/landings/requests/{requestId}` — missing
- `GET  /api/repos/{o}/{r}/landings/{number}/land/append` — missing

Only `PUT /landings/{number}/land/append` exists (`cmd/server/router.go:1255`).
An uncommitted lane at `~/plue-coding-landing` (jj `567e6bc4aec8`) implements all
three plus migration `db/migrations/20260910044000_landing_create_identity.sql`.

Separately, `internal/services/repo_gateway_workspace.go:222` builds the
workspace gateway service environment without `SMITHERS_JJHUB_TOKEN` or
`SMITHERS_JJHUB_API_URL`, so `flows/coding/landing-config.ts` returns
`undefined` and `coding/vibe` is never registered. A live workspace advertises
only `checks/fast`, `checks/slow`, `checks/wiki`, `coding`,
`coding/implementation`, `coding/request`. Landing from a workspace is
impossible until both are fixed and deployed.

### smithers — every projection over a real run refuses past 4 MiB

`packages/smithers/gateway/src/Projections.ts:287` fails the whole projection
once a run's event history exceeds `maxProjectionBytes`:

```
GatewayError resource_limit: Run event history exceeds 4194304 encoded bytes
```

The first eight-minute production run tripped it, so the app could not render
that run's outcome at all — `run-summary`, `trace` and `turns` all refuse
together. It is a hard refusal, not truncation.

### smithers — a non-retryable provider refusal is still retried by the flow

`ModelError.retryable` is already `false` for `quota_exceeded`
(`packages/smithers/agent/model/src/ModelError.ts:149`), but the flow-level cell
retry retried the same dead key nine times with 60 s backoff, burning eight
minutes before the run failed. The retry above the model layer should honour the
classification.

## Model seats

Neither key available to this machine can drive a coding run:

- `openai:gpt-6-astra` — `ModelError quota_exceeded`, providerCode
  `credit_balance_exhausted`: "You have no credits remaining."
- `gemini:gemini-3.5-flash` — completed the wiki refresh, then `HTTP 503` on the
  planner request; the key is now 429 free-tier exhausted, and
  `gemini-3.1-pro` / `gemini-2.5-pro` are quota 0 on it.
- `cerebras:gpt-oss-120b` — completes the whole flow but writes prose that fails
  the fixture's own `fast` check, twice, even when the prompt quotes the exact
  words the check asserts. `cerebras` offers only `gpt-oss-120b` and
  `qwen-3.8-27b`.

A funded model seat is the remaining blocker for a green `coding/request` on the
fixture; the landing endpoints are the blocker for `coding/vibe` after that.

## Reproducing

Drive the gateway directly rather than through the UI:

```
POST /api/workflow/provision  {repo, workspaceId}
POST /api/workflow/rpc        {repo, workspaceId, procedure: "Plan",
                               payload: {flowId: "coding/request",
                                         input: {prompt, maxRounds}}}
POST /api/workflow/rpc        ... "Approval.Submit"
                               {target: {_tag: "Plan", planId, digest, envelope},
                                scope: "run", idempotencyKey, decision: "approve"}
POST /api/workflow/rpc        ... "Run"
                               {_tag: "Plan", planId, digest, envelope, idempotencyKey}
```

Answer a parked planner question by taking the `approvals` projection row and
posting `{...row.payload, decision: "approve", answer}` to `Approval.Submit`.
