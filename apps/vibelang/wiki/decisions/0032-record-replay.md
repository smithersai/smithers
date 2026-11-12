# 0032 — External services in tests: record, replay or pass through

Date: 2026-11-10. Lane vl-record-replay. Rulings [VL-36 and VL-38](../rulings.md).

## Why

Will, 2026-11-10 13:44 PST: "The tests should have a record replay pattern for things like that where we can run vs a
real github in passthroug, run vs real github recording responses, and replay those responses. Make sure recorded
responses don't have important secrets in them though". Until then a happy path that reached GitHub ran on an
in-memory GitHub (`fuzz/issues-node-fake.vibe`) or was skipped without `GITHUB_TEST_TOKEN`. The fake answered what its
author believed GitHub answers, and it was wrong in a way that hid a product bug (below).

## Decision

One `HttpClient` layer in the SDK, `@smthrs/testing`'s `HttpRecording`
([guide](../../../../packages/testing/docs/guides/record-http.md)), with three modes. The code under test is unchanged:
it reads `HttpClient` from context.

```
 VIBE_GITHUB        reaches GitHub   writes test/recordings/<name>.json   needs GITHUB_TEST_TOKEN
 replay (default)   never            no                                   no
 record             yes              yes, when the test passes            yes
 passthrough        yes              no                                   yes
```

- **Where.** In the SDK because it is general (SDK-1): any service reached over HTTP. It builds on VIP-71's
  `Experimental.Test.record`/`replay` rules (replay never spends; a missing recording is a failed test; an interrupted
  or failed run is not recorded; the library reads no environment variable). VIP-71 keys a model recording on the
  model request; `CachedModel` and `RecordedModel` stay the model's pair. HTTP recording is for services whose wire
  format is the contract.
- **Selection.** `test/support/github.vibe` reads `VIBE_GITHUB` through `Config`; the SDK reads nothing.
- **Secrets.** Before a recording is written: request headers are dropped; response headers are cut to
  `content-type`, `link`, `location` and `retry-after`; URL user information and credential-named query parameters
  are replaced; the run's token is replaced wherever it appears; bodies go through `@smthrs/journal/Redaction`'s
  `redact` (credential-named fields, token-shaped strings); then the whole file is scanned and a match refuses the
  write (`CredentialInRecordingError`, naming the rule, never the value). `test/recordings.test.vibe` scans every
  committed recording in CI with the same rules and fails on a planted `ghp_` token (checked red, 2026-11-10).
- **Replay is strict.** Each exchange is claimed once, in recorded order per method, URL and body. A request the
  recording does not hold dies with `UnrecordedRequestError`. `since=` (a flow's admission time) is keyed out.
- **Identity.** Recording runs write to `codeplanesmithers/smithers-vibelang-e2e` (repository id 1443081815) only, as
  the smithers.sh GitHub App's installation on `codeplanesmithers` (installation 146401045). GitHub records that
  installation as `smitherspreviewrelease[bot]` (user id 297525718), which is the person's id in the tests because
  the wiki host checks a review's author id; the person's delegation names `codeplanesmithers`, the repository's
  owner, so the delegation writes upstream without a fork. The token is minted at record time and only read from the
  environment.
- **Size.** A run's label (the names it creates) is fixed at record time and stored in the recording, so a replay asks
  for exactly what was recorded and a real run never meets an earlier run's issues. `prune` removes GitHub's
  hypermedia links, fields no reader decodes (the App's `performed_via_github_app` was half of each issue it wrote),
  and a pull request's repository records but for the six fields a reader uses. The code sees the pruned answer while
  recording too, so a field it needs fails the recording run. The App cannot delete an issue, so every run leaves its
  issues closed in the test repository; an issue list answer is recorded without closed issues and pull requests
  whose title lacks this run's label (`keptInIssueList`). Without that cut each run grew every
  later recording's lists by about 4 KB per list read: the first journey recording was 1.69 MB, and 532 KB with it.
  Cleanup closes what the run made, blanks closed issues' bodies, removes the labels it brought, and closes and
  deletes its reviews and branches. jj refuses a new file over 1 MiB; the scan test holds every recording below it.
- **State.** A case writes the state it reads (issues with labels, assignees, sub-issues, comments, VIP claims, a
  review comment) through the test's own client on the same recording, so a replay replays the seeding too. The
  person's write count comes from smithers.sh's delegation (`fuzz/delegated.vibe`'s `reach`), which the seeding and
  cleanup bypass. GitHub's issue list trails a write by seconds, so a case waits, 30 tries at most, until the list
  shows what it seeded; a replay asks as often as the recording run did, without waiting.
- **Benches.** A bench passes `"replay"` to `test/support/github.vibe`'s `github`: it repeats a test's recorded
  journey on every callback and never reaches GitHub, whatever `VIBE_GITHUB` says. The journey is one function
  (`test/support/issuesWorld.vibe`, `test/support/wikiWorld.vibe`) that the test runs first, so the bench claims a
  prefix of the test's recording.

## What runs on recordings now

| Test or bench | Recording | Exchanges | Size |
| --- | --- | --- | --- |
| `test/issues.github.test.vibe` and `bench/issues-delegated.bench.vibe`: a maintainer's new issue, split with its link, comment, VIP proposal (branch, commit, review, issue), link, commit to the agent, uncommit, accept, decline of a second claim; then accept and decline again with no write, and a read | `issues.json` | 290 | 558 KB |
| `test/issues.github.test.vibe`: a read of seeded tasks (queued, running, done), a verified VIP in review with its reviewer, four claims that each fail one check, a sub-issue, comments and timeline notes; every refusal before a write (title, missing, empty, tree, closed, assignee, review, agent, unnamed maintainer, reused key); an authority with no live check; the stored revision and older gate state | `issues-read.json` | 318 | 806 KB |
| `test/wikiEdit.github.test.vibe` and `bench/wiki-delegated.bench.vibe`: read, drafted edit kept and cleared, a maintainer's save and proposal on a disposable base branch; then stored and kept-text reads, a visitor's read, refusals before a write (moved base, empty, unchanged, agent save, empty draft, no key), and a contributor's proposal through an authority with no live check | `wiki.json` | 100 | 134 KB |
| `test/mainLog.github.test.vibe`: main's first-parent log | `main-log.json` | 1 | 200 KB |
| `test/export.github.test.vibe`: the mythical history's git export (0020): publish, republish nothing, extend, delete its refs | `history-export.json` | 78 | 120 KB |

All of them ran skipped in CI before (the issues and wiki tests could not write at all since decision 0165, because
they put a token on the principal). They now run on every `pnpm test`, without a token, in about 12 s. Checked red: with
`verifiedVip`'s check for a padded review number removed, the `issues-read.json` replay fails with
`[ '', 'In review', '', '' ]` where every claim must read as a plain issue.

`test/issuesDelegated.coverage.test.vibe` (14 cases) and `test/wikiDelegated.coverage.test.vibe` (10 cases) keep only
what real GitHub cannot be made to answer: deleted accounts and null fields, foreign parent links, a second assignable
account, short pages, undecodable issues, outages, lag, refusals, lost roles and credentials, and failing journals.
Each is the in-memory GitHub told to fail or a wrapped client service.

## The model

The same layer records the model: `test/support/model.vibe` hands `HostModel` a `fetch` (`HostModelOptions.fetch`,
`test/support/fetchOver.ts`) over `HttpRecording`, for the deployment's default model (`DEFAULT_CHAT_MODEL`,
Cerebras). It is the smaller fit than VIP-71's `CachedModel`/`RecordedModel`: those replay `ModelLike` calls, and the
app's agents reach the provider through `HostModel`'s HTTP and SSE, so the wire is the contract here as for GitHub.

```
 VIBE_MODEL         reaches the provider   writes test/recordings/model-<case>.json   needs CEREBRAS_API_KEY
 replay (default)   never                  no                                         no
 record             yes, 40 calls at most  yes, when the case passes                  yes
 passthrough        yes, 40 calls at most  no                                         yes
```

- **Secrets.** The key comes only from the environment. Request headers (the key's) are dropped, the key is scrubbed
  wherever else it appears, and the file is scanned and refused on a credential shape, as for GitHub.
- **Keying.** The agent's system context carries the project wiki and changes with every edit, so a model call is
  keyed and recorded with it replaced by a fixed text; a replay claims the calls in order by the person's and the
  agent's turns.
- **Cap.** One recording run stops at the 41st model call, whatever the model answers.
- **Cases** (`test/model.recorded.test.vibe`): the VIP agent's draft, the wiki agent's draft, a specification
  reviewer's verdict (its model built from configuration; its calls go through the injected `FetchHttpClient.Fetch`)
  and a reply. A real answer differs from run to run, so each checks what the product promises of any answer: every
  field present, the asked page, a verdict and grade at the asked revision, a finished reply, one charge within the
  ceiling. They skip until the four recordings are committed. Failures stay on the scripted model as injected faults.
- **Wiring checked in every run** (`test/modelRecording.test.vibe`): a reply recorded from the scripted provider on a
  local socket replays with the socket closed and the same answer, events and ledger; the file holds no key and no
  system context; a reviewer's calls reach the recording (red without the `Fetch` injection: 0 exchanges); the cap
  refuses the call after its limit before it reaches the provider.
- **Recorded by the lead** on the Mac, where the key lives: `CEREBRAS_API_KEY=… pnpm record:model` in `apps/vibelang`.

## Bug found by real GitHub

**A new issue or a split answered without the issue it selected.** GitHub's issue list trails a write by seconds;
`GET /issues/{n}` does not. After `new`, the flow read the list and returned `selected: 11` over items `10, 8, 6, 5,
3, 1`. A commit could likewise refuse a valid assignee when the list still showed none. The in-memory GitHub always
listed its own writes, so no test saw it. `read(number)` in `worker/Issues.vibe` now reads the selected issue by
itself and puts it in place of its listed copy. Red first: replaying `issues.json` with the fix removed fails with the
original `TypeError` at the selected issue. The fake now hides a VIP marker from single-issue reads as well as lists,
so `issues/steered-host`'s "GitHub never showed the VIP" case still means what it says.

## Remaining

- Fuzz targets generate requests a recording cannot hold. By VL-38 they keep the in-memory GitHub, checked against
  every committed recording by `test/fakeConformance.test.vibe` on every `pnpm test` (built, lane vl-fake-conformance).
- The model's four recordings: `pnpm record:model` with the key, on the Mac. Until then the cases skip and the
  scripted model's happy cases stay.
- Sandbox machines are recorded: `d7d3245c` (lane vl-containers-live, VL-35) committed
  `test/recordings/sandboxes-live.json`, the product's `Factory` client starting, commanding, checkpointing, restoring,
  metering and sweeping a real Container on the `vl-test` stage, and `test/sandboxesReplay.test.vibe` replays it in
  every `pnpm test`. The in-memory `memoryMachines` (`src/core/sandboxMock.vibe`) still serves
  `test/sandboxFlow.test.vibe` and `test/sandboxKernelEdges.coverage.test.vibe`, and stays the UI's mock mode (VL-13).
  Below HTTP, the Container binding itself records and replays (`@smthrs/testing`'s `ContainerRecording`, lane
  vl-coverage-workerd, 2026-11-11): the probe records each machine's real Container calls, and the workerd suite
  replays them behind the real machine object. The recordings wait on the lead's record run (decision 0016's LEAD RUNS).
- Device sign-in and accounts wait for the GitHub App's Device Flow setting.
- The test repository keeps every closed issue a run made. The list cut keeps them out of recordings; a passthrough
  run still reads them.

## Fake conformance (VL-38, lane vl-fake-conformance)

`test/fakeConformance.test.vibe` discovers all JSON recordings, seeds the fake from the recording's first resource
reads, sends every recorded request in order, and compares status and the production decoders' complete results.
An unknown endpoint or a failed decoder fails the test. Failures name the recording, zero-based exchange, method,
path and differing field. It does not reach the network. Logs, span and exchange counter carry counts and file names.

`NON_SEMANTIC_DIFFERENCES` is the single named list of normalization rules, with one-line reasons. It preserves
missing and null, types, numbers, text, roles, labels, assignments, event kinds, file names and states. Generated
database identities are bound back into sub-issue requests; opaque SHA allocations are replayed, so branch parents
and expected-head checks still use the same identities. Commit/parent/merge hashes and stable account/repository ids
compare exactly; only content blob hashes normalize after their decoded bytes agree.

`OTHER_CONTRACTS` names the real-GitHub recordings of APIs no fuzz target sends the fake, each with its reason, and
fails when a named file is gone: `history-export.json` (0020), GitHub's Git database API and GraphQL `updateRefs`. The
export fuzzes `@smthrs/jj`'s memory `Repository`; `GitHub.GitDatabase` checks every object id GitHub answers against the
hash that repository uses. This is the lead's reading of VL-38 (2026-11-11): VL-38 exists so the
fuzz fake cannot drift on what fuzz targets use; the fake never serves the export's git endpoints and no target sends
them, so the fake need not model them.

GitHub's asynchronous inputs are explicit, separate from normalization: the recordings omit request times, so the
first observed index visibility and timeline visibility supply the fake's logical-clock publication schedule.
Mergeability is an external GitHub computation with its own observed schedule. Those controls delay fake-generated
state or supply the external check result; they never supply an HTTP status, issue body, label, assignment or file
content. Resource creation and mutations must still produce the recorded responses. The initial label-create 422
also establishes that the repository already held that label (the recordings contain no repository-label listing).

The regression exposed incorrect sub-issue status, duplicate-label success, absent-label success, hardcoded
repository/author coordinates, ignored list query order/filtering, canned timelines/reviews, missing patch/delete
cleanup and contents that ignored branch commits. The fake now models those operations and per-commit file text.
A deliberate duplicate-label change from 422 to 200 is checked red and restored; the private lane report holds
the exact output and check receipts. No dependency or coverage exclusion was added.

**Held to the recordings of 0032's happy paths (lane vl-record-replay, 2026-11-11).** The issue and wiki recordings
above go through the same check. The test repository passed GitHub's 100 entries a page, and the recordings cut
earlier runs' closed issues (the App cannot delete one; `deleteIssue` answers "Viewer not authorized"), so the
harness seeds every number below the run's first that no list showed as a hidden closed issue, applies the same cut
to the fake's lists, and compares a next-page link without GitHub's opaque cursor (`page-cursor`). A parent's child
count joins the schedules: GitHub's list showed a new count at once in one recording and one read late in the other.
The fake now models what the recordings exercise and it did not: a review created on a pull request, labels and
assignees named when an issue is created or patched, a repository label read and deleted, `closed` and `reopened`
events, `sub_issue_added` on the parent, an empty body answered as `null`, labels by name in one issue's answer and
in the order added in a list, newest first by default, a page link when a list passes one page, and `since` lists
that include issues the run made. Seeding skips an issue the recording creates even when its first list read comes
after the creation. Red: without the `closed` event the check fails at `issues-read.json` exchange 60.
