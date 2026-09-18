---
title: "Quickstart"
description: "Serve a repository to the hosted OpenCode app with smithers opencode, allow the local network prompt, and read the health dot."
---

## Start the server

```sh
cd my-repository
smithers opencode
```

The server binds `http://127.0.0.1:4096` and prints the directory it serves.
Pass `--port` for another port and `--seat provider:model` for a model other
than the first provider whose key is set.

## Open the app

Open `https://app.opencode.ai` in Chrome. The page asks to reach a device on
your local network the first time it connects to `127.0.0.1:4096`: allow it.
Add the repository as a project, or open the project route the banner names,
and send a prompt. Every prompt runs one Smithers turn; the cards in the
timeline are the frames, calls, and prints of that turn.

## Keys

| Variable                                                  | What it does                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CEREBRAS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | The model seat. The first key set picks the seat unless `--seat` or `SMITHERS_SEAT` names one.                                                                       |
| `AI_GATEWAY_API_KEY`                                      | Jev through the Vercel AI Gateway, for `classify` calls and the health dot. Optional: without it every `classify` call answers `unreachable` and the dot stays gray. |
| `OPENCODE_SERVER_PASSWORD`                                | Basic authentication. Required with `--listen` on a non-loopback host.                                                                                               |

## The health dot

After every frame the server asks Jev where the run is, whether it is
repeating itself, and whether it needs a person, and puts the answer in
front of the session title.

| Dot | Meaning                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 🟢  | Progressing, verifying, or done.                                                                                                     |
| 🟡  | Repeating itself, exploring without an edit for four frames, or a discipline demand was just issued.                                 |
| 🔴  | Parked on a permission, a question, or quota; needs a person; or a usage limit ended the run.                                        |
| ⚪  | No `AI_GATEWAY_API_KEY`, Jev unreachable or over its 1.5 s deadline, every answer under 0.5 confidence, or the turn was interrupted. |

A `health` card appears in the timeline on every color change, titled with
the reason and carrying the three answers; without a key the gray card says
`health unavailable: set AI_GATEWAY_API_KEY to turn on health and classify`.
Renaming the session keeps the dot in front of your title; archiving removes
it.

## Frames

Every prompt has a budget of forty frames (`--max-frames`), and a turn that
only reads or only prints for six frames is told to act, and stopped at
twelve. Raise `--max-frames` for a long task.

## Cost

The session header carries the tokens of every turn. The dollar figure is
the seat's cost when the host names a price, and zero otherwise. The last
line of every turn is a summary: frames, calls, classify calls, and the
Jev calls with their latency and spend.
