# 0012. The reply is smithers.sh's agent

**Status:** accepted, 2026-11-07. **Rulings:** VL-4 (item 5), VL-7, VL-11; repository rules "Use the Smithers
libraries" (SDK-1, SDK-2) and "Everything is a durable flow" (DUR-4). **Changes:** 0010.

**Decision.** `vibelang/Reply`'s answer step is `vibelang/reply/agent`, an `@smthrs/agent` `AgentAction`: the cell
loop smithers.sh's chat answer runs (apps/mvp `chat/Respond`, `src/features/agent/flows.ts`), declared here with
VibeLang's skill (`worker/agentContext.vibe`) as its system context. It replaces the one `ModelStep.run` call.

```
vibelang/Reply ─ start ─ admit ─ history ─ vibelang/reply/agent ─ spend ─ settle
                                            │ AgentAction: profile "conversation", seat "agent", ≤ 8 frames
                                            │ each frame: one ModelStep (the agent's), one cell in QuickJS
                                            └ EventSink ─▶ queue ─▶ fiber ─▶ append / restart (sequencer)
```

| smithers.sh's agent (apps/mvp) | Here |
| --- | --- |
| `AgentAction.make("chat/Respond", { profile: "conversation", seat: "agent", maxFrames: 8, prompt })` | `AgentAction.make("vibelang/reply/agent", …)`, the same profile, seat, frame bound and prompt shape |
| `CHAT_SYSTEM` (the app's flows and slash commands) | VibeLang's skill, `AGENT_CONTEXT` |
| Hosted in the browser's durable engine (mvp decision 0011) | Hosted in the conversation's Durable Object, on the engine in its SQLite (0010) |
| Seat `agent` → the model proxy | Seat `agent` → `CHAT_MODEL` (`HostModel`), context window 32,768 |
| QuickJS single-file build | `@smthrs/harness/QuickJSWorkerd`: the separate-file build as a compiled module |
| `Budget.layerUnbounded`, `QuotaPolicy.layerDefault`, `Evaluator.layerUnavailable` | The same |
| The app's flow catalog as tools | None: see below |

- **Streaming.** The agent's `EventSink` puts each event on a queue; the sink runs inside the engine's write, so it
  never writes storage. A fiber folds the events (`fold`): the visible answer is the literal the reply passes to its
  last `ctx.done(`, as far as it has arrived (`@smthrs/harness`'s `DoneText.project`). Text that extends what was
  shown is appended; text that doesn't (a retry or another frame) restarts the reply (`RestartReply`, 0005). The
  step's own answer settles it with `FinishReply`.
- **Spend.** The fold sums every `model-settled` usage; the spend step records that once per reply, answered or not.
  The daily budget still admits the reply before the agent runs (0010).
- **Failures** read as before: a model call that failed with `content_policy` is "refused", `out_of_credit` or
  `quota_exceeded` is the provider's credit, any other model failure is "unavailable", an unresolved seat is "no
  model", an answer that never fit is "empty", anything else is "failed". Logged as `vibelang.reply.agent` with the
  outcome code and tokens only.

**The SDK change.** workerd refuses to compile WebAssembly from bytes, so the agent's default sandbox can't load in a
Worker. apps/mvp solved this in its own `worker/AgentSandbox.ts` with a `#quickjs.wasm` import mapped in its
package.json. That now lives in `@smthrs/harness/QuickJSWorkerd` (`variant`, `variantFrom`), with the mapping in
harness's `imports`, so this app adds no QuickJS dependency. Its tests run a real cell in Node over a compiled module
and in local workerd through Miniflare. apps/mvp still carries its own copy; moving it onto `QuickJSWorkerd` is the
follow-up.

**Tools.** The agent has no tools in this Worker (`flows: []`, `calls: 0`); it answers from the skill, and a cell may
compute. smithers.sh's chat agent's tools, and why none runs here yet:

| Tool family | Why not here |
| --- | --- |
| `app/theme/set`, `app/navigate`, `file/open`, `file/close`, `app/web/open`, `conversation/new`, `ui/form`, `ui/render`, `view/set-state`, `ui/repo`, `ui/issues`, `chat/copy`, `repo/copy` | They act on the person's tab (`Placement.client`); this agent runs on a server |
| `app/agent/ask` | Needs the tab's approval channel |
| `app/memory/remember`, opening memory | Needs a per-person memory store; there is no sign-in (roadmap brick 2) |
| `repo/*`, `branch/*`, `issue/*`, `todo/*`, `pull/*` | Need GitHub sign-in and smithers.sh's Postgres API |
| `flow/*`, `run/*` | Need smithers.sh's saved flows and its device engine |
| `sandbox/*` | Need a branch machine (Cloudflare Containers); VL-25 brings sandboxes later |
| `model/*`, `watch/set`, `app/bug/*`, `app/jev/*`, `chat/pin`, `chat/unpin` | Account, admin or judge state this app doesn't have |
| `app/docs/search` | Searches smithers.sh's docs, not VibeLang's |

**Proof.** `test/agentReply.test.vibe` checks the task, the streamed text, the tokens and the reasons.
`test/live.workerd.test.vibe` runs a reply in local workerd against a model at an `.invalid` host: the reply reaches
the agent's host, seat, sandbox build and model step, whose real connection failure reads "unavailable". With
`CEREBRAS_API_KEY` set, the opt-in case requires a streamed answer from the real model; no key was available on the
build host, so that case was not run.

**Outside this decision.** A real model answer in CI, tools (above), and per-reply limits beyond the eight frames
and 2,048 output tokens per model call.
