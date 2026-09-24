/**
 * Writes the flow the read-only liveness proof runs.
 *
 *   node lib/liveness-flow.mjs <seat> <cap>
 *
 * The flow is a control test, not a coding task. It asks the model to spend
 * consecutive frames reading one file and changing nothing, which is the exact
 * shape the read-only cap exists to interrupt, and to stop as soon as the
 * interruption arrives.
 *
 * Two instructions carry the whole design.
 *
 * The first forbids `justification`. `CellTurn` treats a justification on the
 * demanding frame's transition as satisfying a demand it has not yet issued:
 * `justified` suppresses `pendingReadOnlyDemand` and buys `readOnlyCap` quiet
 * frames, so no `read-only-demanded` event is ever emitted. That is not
 * hypothetical — it is why wave 6's `pytest-dev__pytest-6197` journaled none
 * despite an earned twelve-frame streak: its frame 11 transition carried an
 * unsolicited justification. A liveness probe that let the model volunteer one
 * would prove nothing, so this one forbids it and the harness's own escape
 * hatch stays out of the measurement.
 *
 * The second stops the run on the demand text, so the proof costs the cap plus
 * one frame and not the hundred-frame budget.
 *
 * @since 0.1.0
 */
const [, , seat = "openai:gpt-6-sol", cap = "12"] = process.argv
const frames = Number.parseInt(cap, 10) + 2

process.stdout.write(`---
description: Read one file per frame until the harness objects.
model: ${seat}
effort: low
---
You are a control probe for this harness. This is not a coding task. Follow
these instructions exactly and do nothing else; there is no repository to fix
and no bug to find.

Every frame, emit exactly this cell, unchanged except for the counter:

\`\`\`cell
const notes = await ctx.call("read", { path: "NOTES.md" })
const seen = (ctx.state && ctx.state.seen ? ctx.state.seen : 0) + 1
return {
  intent: "continue",
  state: { seen },
  context: [{ role: "user", text: "Read NOTES.md. Frame " + seen + " of ${frames}." }]
}
\`\`\`

Hard rules:

1. Never call \`write\`, \`edit\`, \`apply_patch\` or \`bash\`. Change nothing on disk.
   The point of this probe is a run that reads and never writes.
2. NEVER include a \`justification\` key in any transition you return, under any
   circumstance, including when you are asked why a frame changed nothing. The
   absence of that key is what this probe measures. Answering with a
   justification ends the probe with no result.
3. The moment any message you are given contains the words "Read-only
   discipline", stop. Return exactly:

   \`\`\`cell
   return {
     intent: "complete",
     state: ctx.state,
     output: "The harness demanded an edit or a justification.",
     reason: "the read-only control fired"
   }
   \`\`\`

4. If you reach frame ${frames} without ever seeing that text, complete with
   output "no demand arrived".
`)
