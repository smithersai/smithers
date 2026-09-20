---
title: "Quickstart"
description: "Serve a repository to the hosted OpenCode app with smithers opencode, allow the local network prompt, and read the health dot."
---

## Start the server

```sh
cd my-repository
export CEREBRAS_API_KEY=...       # the model seat
export AI_GATEWAY_API_KEY=...     # Jev, which judges every completion
smithers opencode --seat cerebras:qwen-3.8-27b
```

The server binds `http://127.0.0.1:4096` and prints the directory it serves.
Pass `--port` for another port and `--seat provider:model` for a model other
than the first provider whose key is set.

Running a model needs both keys. Without `AI_GATEWAY_API_KEY` the verb
refuses to start and exits 2:

```
smithers opencode needs AI_GATEWAY_API_KEY, because the harness asks Jev to
judge every completion and fails a run it cannot judge. Export
AI_GATEWAY_API_KEY (Vercel AI Gateway) and start again, or pass --scripted to
replay the recorded turn without a model.
```

The harness asks Jev whether the sentence a turn wrote describes what the
turn did, and a completion nothing judged ends the run. The verb therefore refuses to start without a judge. `--scripted` replays the recorded turn,
runs no model, and needs neither key.

## Open the app

Open `https://app.opencode.ai` in Chrome. The page asks to reach a device on
your local network the first time it connects to `127.0.0.1:4096`: allow it.
Add the repository as a project and send a prompt. The terminal client can attach with
`opencode attach http://127.0.0.1:4096 --dir "$PWD"`. An idle session starts a Smithers turn; a prompt sent while it is busy steers
the current turn. The timeline shows its frames, calls, and prints.

## Who can reach the server

The default bind is `127.0.0.1` and asks for no password, so the boundary is
the browser's: a page is allowed to talk to the server only when its origin is
one the server was told about. The hosted app (`https://*.opencode.ai`) is the
only origin allowed out of the box. Every other origin is answered `403`
before the route runs, including a page served on a loopback port, because a
page on `http://localhost:1234` is a page any dev server or preview tool put
there, and the operator never chose it.

A local build of the app names itself:

```sh
smithers opencode --cors http://localhost:5173
```

A pattern that is not an origin is refused at the bind rather than accepted
and ignored, so `--cors '*'` exits with the shape that would have worked.

Clients that send no `Origin` are not browser pages acting across origins and
are unaffected: `opencode attach`, `curl`, and anything else on the machine
reach the server as before. What bounds those is the machine, so set
`OPENCODE_SERVER_PASSWORD` when the machine is shared, and `--listen` on a
non-loopback host requires it.

## Keys

| Variable                                                  | What it does                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CEREBRAS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | The model seat. The first key set picks the seat unless `--seat` or `SMITHERS_SEAT` names one.                                                   |
| `AI_GATEWAY_API_KEY`                                      | Jev through the Vercel AI Gateway. Required to run a model: it judges every completion, and it also answers `classify` calls and the health dot. |
| `OPENCODE_SERVER_PASSWORD`                                | Basic authentication. Required with `--listen` on a non-loopback host.                                                                           |

## The health dot

After every frame the server asks Jev where the run is, whether it is
repeating itself, and whether it needs a person, and puts the answer in
front of the session title.

| Dot | Meaning                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟢  | Progressing, verifying, or done. A completed turn with no health reading falls back to green, reading `answered`. A low-confidence reading remains gray.                                                                                      |
| 🟡  | Repeating itself, exploring without an edit for four frames, or a discipline demand was just issued.                                                                                                                                          |
| 🔴  | Parked on a permission or quota; needs a person; or the turn failed or exhausted its frame budget. Such a turn reads `stopped: ...` and names what ended it: the seat's usage limit, the rule the harness stopped it on, or its frame budget. |
| ⚪  | Jev unreachable, every answer under 0.5 confidence, or you stopped the turn.                                                                                                                                                                  |

Gray means health is unavailable, or you pressed Stop. A failed turn or an
exhausted frame budget is red and names the reason. One missed 1.5 s deadline keeps the color
the run already had rather than repainting it gray; three missed in a row go
gray and say so.

A `health` card appears in the timeline on every color change, titled with
the reason and carrying the available answers or transport failure. A gray
card explains why health is unavailable. Renaming the session keeps the dot
in front of your title; archiving removes it.

## When the gateway is down

Jev judges every completion, and a completion nothing judged fails the turn.
A blip does not: the server asks the gateway again, up to three times, 250 ms
apart, with 2500 ms over each request and 8 s over all of them. It asks again
only for a failure that a second request can mend, which is a connection that
never opened, a request that ran out of time, and a `429` or a `5xx` from the
gateway. A `401` or a `403`, a question the gateway rejected, and a body it
could not read are answered once, because the second answer is the first one.

A gateway that is down for all three requests fails the turn with the last
request's own reason, so the error names what happened:
`A completion no evaluator could judge (refused): The gateway answered 503`.
The health dot has its own 1.5 s deadline. A timeout retains the previous
color until three consecutive health evaluations time out; other transport
failures turn it gray immediately.

## Frames

Every turn has a budget of forty frames (`--max-frames`); steering does not
reset it. A turn that
only reads or only prints for six frames is told to act, and stopped at
twelve. Raise `--max-frames` for a long task.

## When the run says it is done

Jev reads every completion against the record the run produced: the task, the
sentence the run wrote, whether the workspace changed, the checks it ran,
the most recent check output in the completing frame, and bounded receipts
for recent settled calls such as file reads and classifications. A
completion it reads as thin is handed back with a `demand` card titled
`claim`, and the run gets a frame to answer. That happens at most three times,
and whatever comes back then stands.

One kind of claim does not stand: a sentence reporting a command the run never
ran, or a result it never got. That ends the turn with
`A completion reporting work this run never recorded`, and there is no answer
to read. That is the point, and it is also the whole of it. A run that answers
a question, reports what a command printed, or says plainly that it could not
check something is handed back at most once and then stands; refusing those too
killed about one honest run in four before 2026-09-19.

## Cost

The session totals accumulate each turn's tokens; an assistant message's
context indicator describes its most recent model request. The dollar figure is
the seat's estimated cost at its configured price, and zero for an unknown
price. The CLI includes prices for its supported starter seats. The last
line of every turn is a summary: frames, calls, classify calls, and the
Jev evaluations with their latency and spend from reported token usage. A
batch counts each state. Provider retries are not separate evaluations, and
requests that report no usage contribute no estimated spend.

## Clarifications and recovery

The agent asks clarifying questions as ordinary messages; reply in the composer.
This host does not offer separate question cards.

Restarting the server restores sessions and resumes open runs. Calls whose
results were journaled replay without repeating their side effects. A command
interrupted before its result was saved may run again; check its external
outcome before relying on recovery for a non-idempotent operation.
