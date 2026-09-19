---
title: "Quickstart"
description: "Serve a repository to the hosted OpenCode app with smithers opencode, allow the local network prompt, and read the health dot."
---

## Start the server

```sh
cd my-repository
export CEREBRAS_API_KEY=...       # the model seat
export AI_GATEWAY_API_KEY=...     # Jev, which judges every completion
smithers opencode
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
turn did, and a completion nothing judged ends the run. A server started
without a judge answers a conversation and fails at the first real task, so
the verb refuses at startup instead. `--scripted` replays the recorded turn,
runs no model, and needs neither key.

## Open the app

Open `https://app.opencode.ai` in Chrome. The page asks to reach a device on
your local network the first time it connects to `127.0.0.1:4096`: allow it.
Add the repository as a project, or open the project route the banner names,
and send a prompt. Every prompt runs one Smithers turn; the cards in the
timeline are the frames, calls, and prints of that turn.

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

| Dot | Meaning                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------- |
| 🟢  | Progressing, verifying, or done.                                                                            |
| 🟡  | Repeating itself, exploring without an edit for four frames, or a discipline demand was just issued.        |
| 🔴  | Parked on a permission, a question, or quota; needs a person; or a usage limit ended the run.               |
| ⚪  | Jev unreachable or over its 1.5 s deadline, every answer under 0.5 confidence, or the turn was interrupted. |

A `health` card appears in the timeline on every color change, titled with
the reason and carrying the three answers. A gray card titled
`health unavailable: set AI_GATEWAY_API_KEY to turn on health and classify`
means the gateway refused this evaluation, not that the key is missing: the
server does not start without one. Renaming the session keeps the dot in
front of your title; archiving removes it.

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
The health dot keeps its own 1.5 s deadline, so it still grays within a second
and a half whatever the gateway is doing.

## Frames

Every prompt has a budget of forty frames (`--max-frames`), and a turn that
only reads or only prints for six frames is told to act, and stopped at
twelve. Raise `--max-frames` for a long task.

## When the run says it is done

Jev reads every completion against the record the run produced: the task, the
sentence the run wrote, whether the workspace changed, and the last check the
completing frame ran. A completion it reads as unproven is handed back with a
`demand` card titled `claim`, and the run gets a frame to prove it. That
happens at most three times; a claim that still does not match the record ends
the turn with `A completion the run's own record does not support`, and there
is no answer to read. That is the point: the alternative is a sentence nothing
supports, returned with a green finish on it.

## Cost

The session header carries the tokens of every turn. The dollar figure is
the seat's cost when the host names a price, and zero otherwise. The last
line of every turn is a summary: frames, calls, classify calls, and the
Jev calls with their latency and spend.
