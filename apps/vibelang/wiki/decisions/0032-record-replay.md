# 0032 — External services in tests: record, replay or pass through

Date: 2026-11-10. Lane vl-record-replay. Ruling [VL-36](../rulings.md).

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
  hypermedia links and fields no reader decodes (two thirds of an issue list). The code sees the pruned answer while
  recording too, so a field it needs fails the recording run. Cleanup closes what the run made and blanks the bodies
  of closed issues, because every read verifies each VIP marker in the repository. jj refuses a new file over 1 MiB;
  the scan test holds every recording below it.

## What runs on recordings now

| Test | Recording | Exchanges | Size |
| --- | --- | --- | --- |
| `test/issues.github.test.vibe`: new, split (with its sub-issue link), comment, commit, uncommit, read, through smithers.sh's real delegation host | `issues.json` | 92 | 637 KB |
| `test/issues.github.test.vibe`: VIP proposal (branch, commit, review, issue), through the delegation | `issues-proposal.json` | 48 | 222 KB |
| `test/wikiEdit.github.test.vibe`: a contributor's proposal and a maintainer's save on a disposable base branch, through the delegation | `wiki.json` | 62 | 117 KB |
| `test/mainLog.github.test.vibe`: main's first-parent log | `main-log.json` | 1 | 200 KB |

All four ran skipped in CI before (the issues and wiki tests could not write at all since decision 0165, because they
put a token on the principal). They now run on every `pnpm test`, without a token, in about 3 s.

## Bug found by real GitHub

**A new issue or a split answered without the issue it selected.** GitHub's issue list trails a write by seconds;
`GET /issues/{n}` does not. After `new`, the flow read the list and returned `selected: 11` over items `10, 8, 6, 5,
3, 1`. A commit could likewise refuse a valid assignee when the list still showed none. The in-memory GitHub always
listed its own writes, so no test saw it. `read(number)` in `worker/Issues.vibe` now reads the selected issue by
itself and puts it in place of its listed copy. Red first: replaying `issues.json` with the fix removed fails with the
original `TypeError` at the selected issue. The fake now hides a VIP marker from single-issue reads as well as lists,
so `issues/steered-host`'s "GitHub never showed the VIP" case still means what it says.

## Remaining

- `test/issuesDelegated.coverage.test.vibe` and `test/wikiDelegated.coverage.test.vibe` still run their happy-path
  cases on the in-memory GitHub; their fault cases (wrapped client services) stay as they are. Each happy case moves
  to a recording when its state can be built on the test repository. `bench/issues-delegated.bench.vibe` and
  `bench/wiki-delegated.bench.vibe` (another lane, 2026-11-10) also run on the in-memory GitHub.
- Fuzz targets generate requests a recording cannot hold. They keep the in-memory GitHub for generated happy paths
  (VL-38). Not built yet: the test that replays every committed recording through the in-memory GitHub and fails when
  it answers differently, so the fake can't drift from GitHub.
- The doubles `~/vl/review-tests.REPORT.md` finding 3 lists for device sign-in, accounts, the model provider and
  sandbox machines.
- The test repository grows by three closed issues and one closed pull request per recording run (the App cannot
  delete issues), which adds about 4 KB to each list read in later recordings.
