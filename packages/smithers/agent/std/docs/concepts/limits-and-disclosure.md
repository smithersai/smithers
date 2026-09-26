---
title: "Limits are disclosed, never silent"
description: "Every cap in this package is a display budget the result declares, plus the truncation flags the harness reads to refuse writing a fragment back to a file."
sidebar:
  order: 3
---

Every limit here is a display budget, not a policy limit. Exceeding one is
always stated in the result, because a silent cut is how a caller comes to
believe it has seen a whole file, a whole listing, or a whole match set when it
has not.

Three disclosure shapes cover the library:

- `truncated` plus an optional `notice` string, on the paged and HTTP flows.
  The notice reads `Showing 3 of 40 lines; output was truncated.`, or
  `Showing 60000 of 1048576 bytes; output was truncated.` on the HTTP flows.
- `<stream>Truncated` plus `<stream>DroppedBytes`, on the flows that capture a
  process.
- A typed refusal, where handing back a fragment would be worse than answering
  nothing. `webfetch` and `fetch` refuse a response past 5 MiB with
  `response_too_large`; `NativeSearch` refuses an `rg` stream past its capture
  bound rather than risk disagreeing with the in-process peer.

## The caps

These values are fixed in the package and are not exported. They are what the
handlers apply:

| Cap                   | Value                       | Applies to                                                 |
| --------------------- | --------------------------- | ---------------------------------------------------------- |
| Default `read` page   | 2,000 lines                 | one `read` call with no `limit`                            |
| Displayed line        | 2,000 Unicode scalar values | one line of a `read` page                                  |
| Entries per page      | 1,000                       | one `ls` or `glob` page                                    |
| Matches per call      | 200                         | one `grep` call                                            |
| Match line preview    | 500 characters              | one `grep` match or context line                           |
| Rendered text payload | 60,000 bytes                | one `read` page, `fetch`/`http-post` body, `webfetch` page |
| Shell stream capture  | 30,000 bytes                | each captured `bash` stream                                |
| HTTP response body    | 5 MiB                       | `fetch`, `http-post`, and `webfetch`, refused past the cap |
| Redirects             | 10                          | one `webfetch` call                                        |
| Language-server frame | 8 MiB body, 8 KiB header    | one JSON-RPC frame                                         |

These are exported constants, so a host can read them and a caller can raise or
lower what it passes:

| Constant                                  | Value      | Applies to                                                  |
| ----------------------------------------- | ---------- | ----------------------------------------------------------- |
| `Bash.DEFAULT_TIMEOUT_MS`                 | 600,000    | one `bash` call with no `timeoutMs`                         |
| `TestRun.DEFAULT_TIMEOUT_MS`              | 600,000    | one `test` call with no `timeoutMs`                         |
| `TestRun.MAX_CAPTURE_BYTES`               | 8,000,000  | runner output one `test` call holds in memory               |
| `ShellCommand.DEFAULT_TIMEOUT_MS`         | 10,000     | one `shell_command` call with no `timeout_ms`               |
| `ShellCommand.MAX_CAPTURE_BYTES`          | 8,000,000  | command output one `shell_command` call holds in memory     |
| `ShellCommand.DEFAULT_MAX_OUTPUT_TOKENS`  | 10,000     | the Codex token budget the output is shaped to              |
| `ShellCommand.TIMEOUT_EXIT_CODE`          | 124        | the exit code a timed-out `shell_command` reports           |
| `NativeSearch.MAX_CAPTURE_BYTES`          | 67,108,864 | one `rg` invocation's captured output, refused past the cap |
| `NodeLanguageServer.MAX_QUEUED_FRAMES`    | 256        | frames buffered for one server's standard input             |
| `NodeLanguageServer.MAX_PENDING_REQUESTS` | 512        | concurrent in-flight requests to one server                 |

## A page ends on a whole line

A byte budget cuts mid-line, and a partial line reads like an anchor and is not
one. So a `read` page truncated by bytes ends at the last whole line it could
afford, and `endLine` counts only the lines it actually returned. A line clipped
by the 2,000-character display cap is called out in the notice by name, because
such a line cannot be used as an `edit` anchor either.

## A limit counts matches, not rows

`grep` returns match-centric results, which is how `rg --json` groups its own
output. `limit` counts matches, each match carries the context lines that belong
to it, and every context line belongs to exactly one match. A budget that
counted rows could spend itself on context and drop the hit, which is a result
that shows the lines around a match and not the match.

## A listing is ordered before it is paged

`ls` describes every entry before it cuts the page, because the order it
promises is directories first and a kind costs a stat. Ordering inside the page
instead would make `offset` address a different listing at every page size, so a
caller paging a large directory could see one entry twice and another never.

## Truncation flags are a wire contract

`stdoutTruncated`, `stderrTruncated`, and `tailTruncated` are not display
details. A truncated capture is a fragment of what the process printed, and
[`@smthrs/harness`](/api/harness) reads these flags to refuse a later write of
those exact bytes: writing a captured tail over a file replaces the file with
the end of a log. Read the flag before writing captured output anywhere, and set
it in your own handler whenever you cut a capture: a consumer that cannot tell a
fragment from the whole writes the fragment.

`stdoutDroppedBytes`, `stderrDroppedBytes`, and `tailDroppedBytes` count what
the process actually produced beyond the capture. Capture is bounded where the
stream is read rather than after it is read, so a command that prints gigabytes
costs the bound instead of the whole of what it printed. `bash` keeps the tail
of each stream, because a failing command prints its verdict last; `read`,
`fetch`, and `http-post` keep the head.

Every caller-supplied command (`bash`, `test`, `shell_command`) passes a capture
bound. The internal `git` plumbing behind `Checkpoints` and `TestRun`'s baseline
does not, because a listing read for its content is useless with its head
missing.
