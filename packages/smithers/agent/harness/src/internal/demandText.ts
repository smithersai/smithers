/**
 * Canonical renderings of controller interventions recorded in the journal.
 *
 * `CellTurn` uses these strings when it builds the live model window and
 * `Transcript` uses the same functions when it rebuilds that window. Keeping
 * the rendering here makes an intervention event sufficient to reproduce the
 * exact user message it represented.
 *
 * @since 1.0.0-rc.0
 * @private
 */

/**
 * Renders the read-only-discipline intervention.
 *
 * It asks for a decision rather than a token write. An answerable request can
 * complete without inventing work. An unfinished workspace change still needs
 * evidence or a justification for more observation, and destructive
 * writes made only to satisfy the notice are explicitly refused. A
 * justification must name how later frames differ from the quiet ones so the
 * run cannot buy a repeat by restating its plan.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 * @private
 */
export const readOnly = (cap: number, frames: number): string =>
  `Read-only discipline — ${frames} consecutive frames have made no call that declares a write, and this run's read-only budget is ${cap}. If the current request is already answered, call ctx.done(answer) now. A conversational or read-only answer needs no invented edit or command. If a workspace change is still required, land an edit you can already name the evidence for — the file, the change, and the check you have watched fail that will now pass. If more evidence is needed, call ctx.justify("<the evidence you are still missing, the exact call that will get it, and what that makes the next frames do differently from these ${frames}>"). Do not write something merely to answer this notice. A restore, a revert, an overwrite from captured output, or any edit whose evidence you cannot name is worse than another read-only frame, because it destroys work this run has already done. A justification is recorded and buys ${cap} quiet frames; it does not reset this counter, and one that names the same next step the last quiet frame named has bought a repeat of that frame. At ${
    cap * 2
  } consecutive read-only frames the run stops as a failure, so ${
    cap * 2 - frames
  } frames remain to answer the request or make the required change.`

/**
 * Renders the repeated-observation intervention.
 *
 * This is separate from the read-only demand because a repeating run has
 * often already edited. It redirects the run from re-reading that edit toward
 * mechanism evidence: the failing check, symbol history, or another caller.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 * @private
 */
export const repeat = (frames: number, cap: number): string =>
  `Repeated observation — the last ${frames} frames issued only calls this run had already issued, byte for byte, and none of them changed the workspace. You are re-confirming what you already know: a call repeated over an unchanged tree returns what it returned the first time. If you have already made a change, it is real and it is recorded, and looking at it again cannot tell you whether it is the right change — what is left to establish is the mechanism, not the presence.

Spend the next frame on evidence you do not have. Three places hold some, and none of them is the diff:
- the failing check itself — what it asserts, the values it asserts about, and the setup that produces them;
- the history of the symbol you changed — \`git log -L <start>,<end>:<file>\` over its line range, or \`git blame\` on the line — which says why it is written the way it is and what it was written to handle;
- a different site — the callers of the symbol rather than its definition, which is where a wrong mechanism shows first.

If no call you can name would tell you something you do not already know, say which mechanism you now believe is wrong and change that instead. This notice returns after another ${cap} repeated frames.`

/**
 * Renders the unchanged-workspace completion intervention.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 * @private
 */
export const unmoved = (opened: string, closed: string): string =>
  `Unmoved workspace — the tree you are completing on is the tree this run was handed.

- digest the run opened on: ${opened}
- digest this frame closed on: ${closed}

Nothing in this workspace differs from the tree this run opened on, so there is no change behind the completion you wrote. Make the change, or complete again stating that no change is needed and naming what you ran to conclude it — the calls you made, what they printed, and why that shows the behaviour asked for is already the behaviour this tree has. Both answers are accepted exactly as you write them and nothing re-checks either one; "no change is needed" with its working shown is a finished answer, and the same words with nothing behind them are the completion you just had handed back. Nothing makes the change for you, and what you return next is the answer that stands.`

/**
 * Renders the unresolved-failure completion intervention.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 * @private
 */
export const unresolved = (flow: string, failed: string, instead: string): string =>
  `Unanswered failure — a check you ran over this exact tree reported a failing exit status, and you went back to what it covered with a different command instead of running it again.

- the check that failed, over the tree you are completing on: ${flow} ${failed}
- the reading you took instead: ${flow} ${instead}

The second names the same subject as the first, so the run itself treated that subject as still open; the first was never run again, and its result is the one this completion is standing on. Fix what it reported and run it again, byte for byte, and complete once you have seen what it prints; or complete and state in your output why the failures it reported are expected and not yours. Nothing re-runs it for you, and what you return next is the answer that stands.`

/**
 * Renders the narrowed-check completion intervention.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 * @private
 */
export const narrowed = (flow: string, broader: string, narrower: string): string =>
  `Narrowed verification — your last verification is narrower than a check this run has already run in full, and the workspace has changed since that broader check last ran.

- the broader check, last run before your latest change: ${flow} ${broader}
- the check this frame ran instead: ${flow} ${narrower}

The second repeats every term of the first and adds conditions to it, so it reports on a part of what the first covered and says nothing about the rest — and the rest is exactly where a change breaks something that was passing. Re-run ${flow} with that earlier input, byte for byte, and complete once you have seen what it prints; or complete and state in your output why that check no longer applies to the change you made. Nothing re-runs it for you, and what you return next is the answer that stands.`

/**
 * Renders the only-reading completion intervention.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 * @private
 */
export const narrowOnly = (flow: string, check: string, targets: ReadonlyArray<string>): string =>
  `Only reading — the check you are completing on is the only reading this run has of what it names.

- the check: ${flow} ${check}
- what it names: ${targets.join(", ")}

Every one of those this run has looked at somewhere else, but no other call it made covers them all, so nothing in this run says what they report on their own. Any term this check carries beyond them — a filter, a selector, a subset of cases, a flag that stops early — is a condition you have never taken off, and what a condition hides is exactly where a change breaks something that was passing. Run ${flow} over the same subjects with those conditions removed and complete once you have seen what it prints; or complete and state in your output that it carries no condition and the reading is already whole. Nothing re-runs it for you, and what you return next is the answer that stands.`

/**
 * Renders the completion-review intervention.
 *
 * Any of the three completion questions can ask for another frame. A low
 * completeness reading does not establish that the run invented work, so the
 * notice asks for a direct answer and makes evidence conditional on the
 * actions or results that answer actually claims. A conversational answer
 * needs no work report and must retain the person's requested format.
 *
 * The task is not quoted back. It is in the run's prefix on every frame, so a
 * quote would buy nothing and cost the window the run has to answer in, and
 * leaving it out is also what lets this text be rebuilt from the event alone.
 * No probability is quoted either: a number is journal material for a grader,
 * and in front of a model it is a score to negotiate.
 *
 * The text still warns about the narrower refusal: repeated claims of work
 * the record does not carry can end the run. Honest reports of work left
 * undone remain valid answers when that is what the run can report.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 * @private
 */
export const claim = (): string =>
  `Completion review — reconsider whether your completion answers the current request and whether any claimed actions or results are supported by this run's record.

Answer the current request directly, keeping its requested format. A purely conversational answer needs no file edit, command, or verification. Do not add a work report when the person asked only for an answer.

If you claim a command or result, use recorded evidence: make an allowed call needed to obtain it, or remove the unsupported claim and say plainly what remains unchecked when relevant. A completion that reports work honestly left undone is not refused for that alone.

The next completion is judged again. A repeated claim of work this run never recorded can end the run with no answer.`
