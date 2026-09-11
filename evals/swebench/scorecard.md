# SWE-bench Verified scorecard

Instances: 5 · flows resolved **4/5** · codex resolved **5/5** · flows wins **0** · codex wins 1 · both pass 4 · both fail 0

## Preconditions: the subject this wave measured

| | |
| --- | --- |
| subject | `sha256:6eef1d25481a934c82a3cb24ad016fe1e6e215ff9e737ac5688979e6f9486d88` |
| agreement | one subject, pinned and stamped by every instance |
| git HEAD | 967081eca20b0ec96bceadc0411678bf2d26d891 🐛 fix(harness): bound the ledger's flow name, hold the sufficiency signal on a red frame, and pin the batched replies |
| `packages/harness/src/CellTurn.ts` | `sha256:e149830e905c07fc1aac6062a827efc852c85311fb211e6f906c363eaedc6026` |
| loaded from | packages/harness/src/CellTurn.ts |
| `packages/cli/dist/esm` | `sha256:1d53b7de47aab2ec5b66d57e0210f4afe723936e60f5d31b44531892781a0e40` (11 modules) |
| `packages/cli/src` | `sha256:f6745ec4af0efc5f13a5ae3e9c6c21aa1f36fa469d45a59920f3adaa3e7a8e8f` (11 files, built above) |
| node | v24.18.0 darwin-arm64 |

Every `@smthrs/*` package except `@smthrs/cli` is loaded from its `src` directory, because that is where its workspace `exports` map points; the harness under test is the working tree, not a build. `packages/smithers/agent/harness/dist` is not in the loaded graph and its state means nothing here.

## Quality

| Instance | flows | codex | Bucket | Patch bytes | Edits ok/tried |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | resolved | resolved | both pass | 1,039 | 5/6 |
| django__django-16612 | resolved | resolved | both pass | 595 | 1/1 |
| pydata__xarray-7393 | empty patch | resolved | codex win | 0 | 0/0 |
| pytest-dev__pytest-6197 | resolved | resolved | both pass | 735 | 1/1 |
| sphinx-doc__sphinx-11445 | resolved | resolved | both pass | 414 | 1/1 |

## Speed

| Instance | flows wall clock | codex wall clock | Turns | Model calls | Mean call latency |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 495s | 101s | 18 | 18 | 21873 ms |
| django__django-16612 | 143s | 82s | 3 | 3 | 35365 ms |
| pydata__xarray-7393 | 739s | 81s | 24 | 24 | 27906 ms |
| pytest-dev__pytest-6197 | 225s | 183s | 6 | 6 | 31928 ms |
| sphinx-doc__sphinx-11445 | 377s | 82s | 9 | 9 | 37992 ms |

Totals: flows 1979s · codex 529s.
Per-call latency is journaled for this wave.

## Cost

| Instance | Input | Cached | Output | flows USD | codex tokens | codex USD (floor) |
| --- | --- | --- | --- | --- | --- | --- |
| astropy__astropy-8707 | 150,671 | 90,508 | 28,099 | $1.1890 | 37,867 | $0.1893 |
| django__django-16612 | 21,692 | 10,676 | 7,450 | $0.2839 | 30,840 | $0.1542 |
| pydata__xarray-7393 | 209,605 | 135,677 | 44,280 | $1.7659 | 34,894 | $0.1745 |
| pytest-dev__pytest-6197 | 45,052 | 29,940 | 11,721 | $0.4422 | 64,398 | $0.3220 |
| sphinx-doc__sphinx-11445 | 91,350 | 45,296 | 23,408 | $0.9552 | 27,988 | $0.1399 |

Totals: flows $4.6362 · codex $0.9799 (floor).

Prices come from the committed table in `prices.ts`. The codex figure is a floor: the committed baseline records one total token count per instance, with no input/output split, so it is priced entirely at the input rate.
