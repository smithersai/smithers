# Record, replay or pass through a Cloudflare Container

`ContainerRecording` records every call a Durable Object makes on its Cloudflare
Container and replays those calls behind the same object, so a test of a
container object runs on a real Container's answers without starting one. It
is the Container counterpart of [`HttpRecording`](./record-http.md), with the
same three modes and the same scrubbing.

```text
deployed object ── ContainerRecording.record(live) ──▶ real Container
     │ onCall: each call, in the order calls began, into the object's storage
     ▼
encode (scrub, scan) ──▶ committed recording ──▶ ContainerRecording.replay ──▶ the object, in a test host
```

## Wrap the container

The module takes any value with the container's shape: Alchemy's Durable Object
container handle, or a test's own. The object under test is unchanged; it
receives the wrapped container where it received the live one.

```ts
import * as ContainerRecording from "@smthrs/testing/ContainerRecording"

const box = ContainerRecording.make({
  mode, // "passthrough" | "record" | "replay"
  live: container,
  onCall: (call, index) => Effect.promise(() => storage.put(`call/${index}`, call)),
  normalize: (operation, input) => operation === "setInactivityTimeout" ? "<duration>" : input
})
```

- `passthrough`: the live container, unchanged.
- `record`: the live container. Every call's operation, input and answer goes
  to `onCall` with its index, and `calls()` (from `record`) answers them so far.
  A command's standard output and error are kept as they stream; its call is
  complete when the command's scope closes. A failed call is recorded by its
  error's `_tag` (or name), never its message.
- `replay`: answers from the recording only, in recorded order. Each call must
  be the recording's next call with the same operation and normalized input;
  any other call dies with `UnrecordedCallError`, which names the index and the
  operations, never an input. `remaining()` (from `replay`) counts the calls
  nothing claimed; a test checks it is 0.

A replayed failure is a `ReplayedFailure` whose `_tag` is the tag the live call
failed with, so code that branches on a failure's tag behaves as it did live.

The module imports no Node module: a deployed Worker records and a workerd test
host replays. It reads no environment variable; the suite chooses the mode.

## What a recording holds

```json
{"label":"direct","calls":[
{"operation":"running","input":null,"output":false},
{"operation":"start","input":{"enableInternet":false,"entrypoint":["sleep","infinity"]},"output":null},
{"operation":"exec","input":{"argv":["sh","-c","cat keep.txt"],"options":{"stdout":"pipe","stderr":"pipe"}},"output":{"stdout":"saved","stderr":"","exitCode":0}}
]}
```

An intercept's fetcher binding is not data and is never recorded; an intercept
records its address only. A command's stdin bytes are not recorded; a replay
gives a command that asks for stdin a sink that drains it. A replayed process
has `stdin`, `stdout`, `stderr` and `exitCode`; a recorded one passes the live
process's other members (`kill`, `resize`, `pid`) through.

## Erase what the clock decides

A value the clock decides (an inactivity timeout computed from a lease's time
left, a timeout argument in a command line) differs between the recording run
and every replay. `normalize` rewrites a call's input before it is recorded and
before a replayed call is compared; the live container still receives the
original. Erase only what changes from run to run, so every other input still
compares exactly.

## Scrub before you commit

`encode(recording, secrets)` returns the file's text, one call per line. Each
named secret (eight characters or longer) is replaced wherever it appears, and
every call goes through `@smthrs/journal/Redaction`'s `redact` (credential-named
fields, token-shaped strings). The text is then scanned with the same rules as
`HttpRecording.scan`; a match, or a named secret that survived, fails
`CredentialInRecordingError`, which names the rule and never the value. The
`label` is not scrubbed: it is the run's identity. `decode(text)` reads a file
back and throws on a malformed one.

Run `HttpRecording.scan` over every committed recording in CI, so a hand edit
fails the build.
