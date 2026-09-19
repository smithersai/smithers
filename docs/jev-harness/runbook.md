# Running the Jev harness

This is the page to read before the first run of `smithers opencode` against the hosted OpenCode app.

## Export two keys, not one

The harness asks Jev whether every completion describes what the run did. It fails a run it cannot judge, and it fails a run whose claim it can read the record against: a completion Jev reads as unproven is handed back for a frame, up to three times, and a claim that still does not match the record ends the turn instead of standing as its answer. That judgement rides on the Vercel AI Gateway, so a gateway key is required in addition to a model seat key.

The brake stops the run, not only the sentence. The turn ends with no answer at all, the assistant message carries the two probabilities Jev returned, and the dot goes gray. It also fires on completions that were true. Across sixteen live turns on 2026-09-18 it killed two runs that had the answer in hand (`add(2, 3) returns -1` over a repository where `add` subtracts, and `planted` as the name field in `package.json`), and one live CI dispatch of the planted one-character bug in four ended the same way. The shape it reads as unproven is the task whose evidence is not a moved tree plus a check that passed: a question about the repository, or a command run and reported. A task that edits a file and runs the repository's own test came back green seven times out of seven on this machine.

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
Serving /Users/you/some-repo at http://127.0.0.1:4096. Open https://app.opencode.ai and allow the local network permission. Seat: cerebras:gpt-oss-120b. Jev judges every completion, and an unproven claim ends the turn.
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
- Yellow: the harness demanded discipline this frame, or the run is repeating itself, or it has read for four frames without an edit.
- Red: the run is waiting for you (a permission card, a question, quota), or a usage limit stopped it, or Jev is at least 70 percent sure it needs a person.
- Gray: health is unavailable or uncertain. No gateway key, a transport failure, no answer above the confidence floor, a turn you interrupted (reason `interrupted`), or a turn the harness ended on a claim it could not prove (reason `failed`). Gray never blocks the run.

The facts beat the answers, and a finished run beats both. A confident `done`, or a turn that resolved, reads green even when Jev calls the run repetitive: a run that re-read a file on its way to a correct answer is not stuck. The dot a finished session keeps is the color its last state earned, so a session that parked on a permission you answered ends green and stays green rather than keeping "waiting for approval" over an empty permission list.

Two finished colors do not mean what they look like, both measured on 2026-09-18. A run the harness killed on an unproven claim keeps a gray dot whose reason line reads `failed`, so the sidebar says health was unavailable where it should say the run was stopped. A run that spends its whole frame budget keeps the color of its last frame, which was green with the reason `exploring` on a run that answered nothing. Read the last message before you trust either color. A conversational turn that finishes in one frame keeps no dot at all.

## Allow once and Allow always

**Allow once** answers this one call. **Allow always** grants for the rest of the session, and the grant is stored, so it survives a restart of the server.

What "always" covers depends on the flow. For `bash` it is the first word of the command: allowing `ls -la` always allows every `ls` in that session, and nothing else. The card names the pattern, `ls *`, so you can read the grant off the card before you press the button. A command that runs inside a container covers that container only, so allowing `pytest` in `ci` never allows `pytest` on your machine. For every other flow it is the whole flow: allowing one `write` always allows every `write` in that session. Grants are per session, so a new session asks again.

A `bash` call is not always a command line. The run can also hand an interpreter a program on standard input, and such a call has no first word to generalise from. Its card reads `node script: console.log(2 + 3)` and carries the interpreter and the whole program beside it, and it offers no "always" at all: whichever button you press, your answer covers that one call. No answer to a `bash` card ever grants the whole shell. Measured on 2026-09-18 in one session: an "always" on that script card left the next `ls -la` asking with its own `ls *` pattern, and left the same script call asking again two frames later.

A script call also has a mode. `mode: hermetic` pre-checks path tokens by reading the program as shell text, so an interpreter that is not a shell is refused before it runs, with `The hermetic pre-check reads shell text, and node is not a shell. Run this script with mode:unhermetic, or express it as shell`. The permission card is asked and answered first either way, so an approved call can still come back with that refusal.

**Reject** answers the call and the turn. When a later frame asks for the same subject again, the server answers it with the refusal itself rather than asking you a second time, and the run reads `the person already rejected ...`. A new turn asks again, because the answer was about this one.

## Stop and Ctrl-C

**Stop** in the app aborts the turn. Every card that was still running settles, any permission card you never answered is answered `reject` and disappears, and the session goes idle. Measured on 2026-09-18: idle 15 ms after the abort, no permission left pending, the message carries `MessageAbortedError: The turn was interrupted`, and the dot is gray with the reason `interrupted`. The work already done stays in the transcript.

**Ctrl-C** in the terminal stops the server cleanly and prints `Stopped serving <directory>.`. Turns that were open when you stopped are re-driven from their journals when you start the server again, and the app's cards update in place. Measured on 2026-09-18 with a SIGTERM nine seconds into a turn, after three frames and ten settled cards: the server printed the line, the restarted server replayed those three frames rather than re-running them, and the turn went on to fix the bug and finish `stop` at frame seven.

## The frame budget

A turn gets 40 frames by default from the CLI. Raise it for a long task with `--max-frames 120`. When the budget runs out the turn stops and says so: `The frame budget of 40 is exhausted. The run stops here; the last transition was a request to continue.` That notice is the whole answer, the finish reason is `stop`, and the dot keeps whatever color the last frame earned, so a run that answered nothing can end green. The notice is the thing to read, not the color.

## What a working classify call looks like

A `classify` card in the transcript, titled with the door, the state count, the question count and the latency, for example `triage/relevance · 1 state · 3 questions · 212 ms`. A batch names how many states it judged and reports the wall clock of the whole batch. The footer under the finished answer counts them: `2 frames · 4 calls · 1 classify · Jev 5 calls · 1412 ms · $0.0000`.

`Jev N calls` is every Jev call the run made, not just the classify calls: the health evaluation behind each dot and the completion brake's reading at each completion attempt are in there too. Each is counted where it is asked, so an answer that arrives after the turn has gone idle is still counted. The milliseconds and the dollars are what the gateway answered, so a refusal and the brake add calls and time without spend. Jev costs $0.042 per million input tokens, so a session of ordinary size costs a hundredth of a cent or rounds to zero.

Counted on the wire on 2026-09-18, against every request fifteen turns sent to `ai-gateway.vercel.sh`: twelve matched their footer exactly, and two sent more than they counted, 11 against 9 and 13 against 12. The footer counts the calls that answered, so a request that did not answer and was retried is on the wire twice and in the footer once. It never went the other way, so the footer never left out a call that answered. The fifteenth was killed and resumed: its footer counts the resumed turn alone, 8 against the 15 the two processes sent.

## When something fails

**`smithers opencode needs AI_GATEWAY_API_KEY, because the harness asks Jev to judge every completion and fails a run it cannot judge.`** and exit code 2, before any socket opens. You did not export the gateway key. Export it, or pass `--scripted` to walk the whole app surface on a recorded turn with no keys at all.

**`No model seat: pass --seat provider:model, set SMITHERS_SEAT or a provider key such as CEREBRAS_API_KEY, or pass --scripted to replay the recorded turn.`** No seat and no provider key is set.

**`Seat cerebras:gpt-oss-120b refused the model call (quota_exceeded, HTTP 429): ... Pass --seat provider:model or set SMITHERS_SEAT to run on another seat.`** The seat, not the harness, said no. The dot goes red and names the limit.

**`A completion the run's own record does not support (overclaimed): complete 0.08, overclaims 0.89. The claim was handed back for a frame and came back still unproven.`** The turn ended because the run said it was done and Jev read the run's own record against that. The two numbers are the classifier's answers to "is the task as stated done" and "does the claim assert what the evidence does not show"; `(incomplete)` in place of `(overclaimed)` means the first question failed rather than the second. The run was told what was missing and given up to three frames to prove it; what came back did not. There is no answer to read, by design: the alternative is a sentence nothing supports, returned with a green finish on it.

This is the refusal you will meet most often, and it is not always right. It reaches the app as `UnknownError` carrying that sentence, the finish reason is `error`, the dot is gray, and the only sign in the transcript that a claim was read is a `demand` card titled `claim`. On 2026-09-18 it correctly refused "the tests pass" over a repository whose one test exits 1 with every shell call denied, and it also killed two turns whose answers were right. Read the sentence, then either re-prompt with the part that is actually missing, allow the call the run needs to prove its work, or restate the task so it ends in a check the run can run.

**`A completion no evaluator could judge (refused): The gateway answered 503`** The turn ended because Jev could not judge its completion. The gateway is retried up to three times over eight seconds first, so this means the gateway was down or the key was rejected, not that one request was slow. A 401 or 403 is answered once, because a second request reaches the same sentence. The server logs **`The completion judge vercel-gateway:typesafe-ai/jev refused the call (authentication, HTTP 401): ... Check AI_GATEWAY_API_KEY and the gateway's status; the run's own seat is not the problem.`** The way out is the gateway key, never another seat, and the app shows it as an authentication failure rather than an unknown one.

**The app shows nothing after Add project.** The server is not reachable. Check the local network permission, check that the server is on 4096, and check `curl -s localhost:4096/global/health`.

## Known rough edges

- Enter on a highlighted row in the folder picker closes the picker instead of opening the project; use the mouse.
- The `cell`, `classify`, `health` and `demand` cards render with the app's generic "Called `cell`" row; only file and shell calls get the app's native rendering. Each of the four leads that row with its own one line, so a collapsed card reads `frame 1 · 3 calls · read-only`, `triage/relevance · relevant: yes (0.93)`, `needs you: approve the write` or `read-only · 1/1`. The frame's program and the classify call's state are on the card's metadata, not in that line.
- A collapsed `health` card shows its input (`color=red`) rather than its reason; expand it to read why.
- The folder picker lists your home directory, so a project outside `~` has to be typed into the search box.
- The dot is gray for the whole run when no gateway key is set, which is also what a gateway outage looks like.
- The dot flickers gray mid-run with `health unavailable: Health did not answer within 1500 ms` when one health call misses its deadline. It came up in four of sixteen measured turns and changes nothing about the run.
- A turn the harness killed on an unproven claim keeps a gray dot, and a turn that ran out of frames keeps whatever color it had, including green. Neither color says the run stopped.
- Nothing in the transcript reads "the claim was not accepted" in words. The message error says it, and a `demand` card titled `claim` marks where it happened.
- A claim the brake bounced is never shown, so a correct answer it refused is not in the transcript either. It is in `<directory>/.smithers/opencode.sqlite`, as that frame's `complete` transition.
- A prompt sent while a turn is running reaches the run and steers it, and it gets no assistant message of its own. The running turn answers both prompts, or dies on one claim covering both.

## Filing what you find

Open an issue at `https://github.com/smithersai/smithers/issues` with the exact refusal line, the command you ran, and `<directory>/.smithers/opencode.sqlite` if the transcript matters. `smithers opencode --scripted` reproduces the whole UI surface without keys, so say whether the problem survives `--scripted`: if it does, it is the app or the projection; if it does not, it is the model path.
