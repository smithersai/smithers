# Running the Jev harness

This is the page to read before the first run of `smithers opencode` against the hosted OpenCode app.

## Export two keys, not one

The harness asks Jev whether every completion describes what the run did, and it fails a run it cannot judge. That judgement rides on the Vercel AI Gateway, so a gateway key is required in addition to a model seat key.

```
export AI_GATEWAY_API_KEY=<your Vercel AI Gateway key>
export CEREBRAS_API_KEY=<your Cerebras key>
```

With no `--seat` and no `SMITHERS_SEAT`, the verb picks the first provider key it finds, in the order `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `CEREBRAS_API_KEY`. On your machine that lands on `OPENAI_API_KEY`, which has no credits, so name the seat yourself with `--seat cerebras:gpt-oss-120b` or `export SMITHERS_SEAT=cerebras:gpt-oss-120b`.

## Start it

```
smithers opencode ~/some-repo --seat cerebras:gpt-oss-120b
```

Keep the default port. The hosted app looks for `http://localhost:4096` and nothing else, so `--port` is for a second server, not for the one the app talks to. The banner names the directory and the address:

```
Serving /Users/you/some-repo at http://127.0.0.1:4096. Open https://app.opencode.ai and allow the local network permission. Seat: cerebras:gpt-oss-120b. Jev judges every completion.
```

State lives in `<directory>/.smithers/opencode.sqlite`. One server serves one directory.

## In the browser

1. Open `https://app.opencode.ai`. Chrome asks for the local network permission; allow it, or the app cannot reach the server.
2. Click **Add project**, type the path into **Search folders**, then click the row **with the mouse**. Enter closes the picker without opening the project.
3. The project appears in the Projects list. Click **New session** to get a prompt box, then type and press Enter.

## The terminal client

`opencode attach` works against this server. Point the shipped OpenCode TUI
at the port the banner names and pass the same directory:

```
opencode attach http://127.0.0.1:4096 --dir ~/some-repo
```

What was proven against OpenCode 1.18.31 on 2026-09-18, driving the TUI
through a pseudo-terminal: it connects and lists the sessions, each with its
health dot in front of the title; it replays a session's history on reattach,
including the cell and tool cards; a prompt streams, the `cell`, `health` and
`demand` cards render as the generic tool row and file, grep, glob and shell
calls get the TUI's native rendering; a permission card appears with **Allow
once**, **Allow always** and **Reject**, and **Allow always** names the
patterns the grant covers; the footer counts the frames, the calls, the Jev
calls and the cost. `Ctrl-C` leaves the TUI and leaves the server serving.
One turn read a repository, ran `bun test`, fixed the bug the test caught and
ran it again, all from the terminal.

Three routes had to be added for this, and they are in the server as of this
page: `config.providers`, the synchronous prompt `POST /session/:id/message`
the TUI prompts through, and `POST /permission/:id/reply` it answers a card
through. Before them the TUI exited at boot with `Error: Route not found`.

What the TUI offers and this server does not answer, so the command reports a
404 and nothing happens: fork, summarize, compact, shell, revert, unrevert,
init and the session command verb. The `/api/*` routes it probes at boot
(location, agent, model, provider, command, skill, integration) and
`/experimental/workspace` answer 404 too, which it has always tolerated.

## What the health dot means

The dot sits in front of the session title. One Jev evaluation runs per frame, from the server, never from the cell.

- Green: the run is progressing, exploring, verifying or done.
- Yellow: the run is repeating itself, or it has read for four frames without an edit, or the harness demanded discipline this frame.
- Red: the run is waiting for you (a permission card, a question, quota), or a usage limit stopped it, or Jev is at least 70 percent sure it needs a person.
- Gray: health is unavailable or uncertain. No gateway key, a transport failure, or no answer above the confidence floor. Gray never blocks the run.

## Allow once and Allow always

**Allow once** answers this one call. **Allow always** grants for the rest of the session, and the grant is stored, so it survives a restart of the server.

What "always" covers depends on the flow. For `bash` it is the first word of the command: allowing `ls -la` always allows every `ls` in that session, and nothing else. For every other flow it is the whole flow: allowing one `write` always allows every `write` in that session. Grants are per session, so a new session asks again.

## Stop and Ctrl-C

**Stop** in the app aborts the turn. Every card that was still running settles, any permission card you never answered is answered `reject` and disappears, and the session goes idle. The work already done stays in the transcript.

**Ctrl-C** in the terminal stops the server cleanly and prints `Stopped serving <directory>.`. Turns that were open when you stopped are re-driven from their journals when you start the server again, and the app's cards update in place.

## The frame budget

A turn gets 40 frames by default from the CLI. Raise it for a long task with `--max-frames 120`. When the budget runs out the turn stops and says so: `The frame budget of 40 is exhausted. The run stops here; the last transition was a request to continue.`

## What a working classify call looks like

A `classify` card in the transcript, titled with the door, the state count, the question count and the latency, for example `triage/relevance · 1 state · 3 questions · 212 ms`. The footer under the finished answer counts them: `2 frames · 4 calls · 1 classify · Jev 1 call · 212 ms · $0.0000`. Jev costs $0.042 per million input tokens, so a session of ordinary size rounds to zero.

## When something fails

**`smithers opencode needs AI_GATEWAY_API_KEY, because the harness asks Jev to judge every completion and fails a run it cannot judge.`** and exit code 2, before any socket opens. You did not export the gateway key. Export it, or pass `--scripted` to walk the whole app surface on a recorded turn with no keys at all.

**`No model seat: pass --seat provider:model, set SMITHERS_SEAT or a provider key such as CEREBRAS_API_KEY, or pass --scripted to replay the recorded turn.`** No seat and no provider key is set.

**`Seat cerebras:gpt-oss-120b refused the model call (quota_exceeded, HTTP 429): ... Pass --seat provider:model or set SMITHERS_SEAT to run on another seat.`** The seat, not the harness, said no. The dot goes red and names the limit.

**`A completion no evaluator could judge (refused): The gateway answered 503`** The turn ended because Jev could not judge its completion. The gateway is retried up to three times over eight seconds first, so this means the gateway was down or the key was rejected, not that one request was slow. A 401 or 403 is answered once, because a second request reaches the same sentence.

**The app shows nothing after Add project.** The server is not reachable. Check the local network permission, check that the server is on 4096, and check `curl -s localhost:4096/global/health`.

## Known rough edges

- Enter on a highlighted row in the folder picker closes the picker instead of opening the project; use the mouse.
- The `cell`, `classify`, `health` and `demand` cards render with the app's generic "Called `cell`" row; only file and shell calls get the app's native rendering. Each of the four leads that row with its own one line, so a collapsed card reads `frame 1 · 3 calls · read-only`, `triage/relevance · relevant: yes (0.93)`, `needs you: approve the write` or `read-only · 1/1`. The frame's program and the classify call's state are on the card's metadata, not in that line.
- A collapsed `health` card shows its input (`color=red`) rather than its reason; expand it to read why.
- The folder picker lists your home directory, so a project outside `~` has to be typed into the search box.
- The dot is gray for the whole run when no gateway key is set, which is also what a gateway outage looks like.

## Filing what you find

Open an issue at `https://github.com/smithersai/smithers/issues` with the exact refusal line, the command you ran, and `<directory>/.smithers/opencode.sqlite` if the transcript matters. `smithers opencode --scripted` reproduces the whole UI surface without keys, so say whether the problem survives `--scripted`: if it does, it is the app or the projection; if it does not, it is the model path.
