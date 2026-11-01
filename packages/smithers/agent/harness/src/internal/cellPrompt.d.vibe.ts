/**
 * The one contract the cell-first harness teaches a model.
 *
 * This contract is plain JavaScript over `ctx.call`, shaped to look like the
 * Claude Code workflow API, and that is a ruling rather than an accident: will
 * ruled on 2026-08-20 that the model authoring surface stays this shape,
 * because agents perform better on the shape they are trained on. Effect.ts is
 * the language of the code we maintain, not the language the model writes. Do
 * not port this contract onto `Flow`/`Action`/`Node`; that was built out under
 * a 2026-08-12 ruling and reversed. It may be tested later as a benchmark arm
 * and is adopted only if it benchmarks better.
 *
 * There is one contract, and it is the REPL's. The surface it replaced — a cell
 * as the body of its own async function, filing JSON into `state` and choosing
 * its successor's `context` by hand — is recorded as a design error rather than
 * as an arm that lost: it made the model do the realm's job, which is why it
 * never worked like a REPL. will ruled it out on 2026-08-24. The evidence and
 * the ruling are in `../../docs/concepts.md#repl-realm`.
 *
 * The contract comes in two profiles (decision 0003 of `apps/mvp`,
 * 2026-10-19). `workspace` is the contract below, unchanged. `conversation`
 * is the same REPL and rules 1 to 6, byte for byte, without the bug-fix
 * example, rules 7 to 9 and the history fact, for a run whose catalog holds
 * no workspace flows. See {@link Profile}.
 *
 * The teaching here is measured, not preferred, and the measurement has now run
 * both ways. The merged optimal-trace program
 * predicted that more teaching
 * would buy verdicts, and grew the contract it replaced from 8,197 to 11,312
 * characters across changes 2, 9 and 10. The re-run that settles those
 * predictions says it did not:
 * resolved fell 35/45 to 30/45, cost rose 59 %, and five instances spent a whole
 * 1,200 s budget without editing one byte, held there by an unconditional
 * pre-edit reproduction rule. The same wave shows every *tool* change paying.
 * That is why the rules below carry their traces and why a teaching change is
 * made one at a time.
 *
 * The exception rule 8 used to state — "when the command will not bootstrap,
 * edit on the diagnosis you have and establish the proof afterwards" — is gone,
 * and it is gone because the thing it was managing no longer exists. It existed
 * to relieve an *ordering*: a baseline had to be taken before the edit, so a
 * baseline that could not be taken yet blocked the edit. Checkpoints remove the
 * ordering outright (will, 2026-08-24). The baseline is now taken after the
 * edit, against `ctx.base`, so there is nothing left to make conditional and a
 * sentence offering relief from a constraint the contract no longer imposes is
 * teaching a shape that is not the shape.
 *
 * The same ruling is why the worked examples put the edit first and the
 * baseline second. That ordering is the whole of the failure it kills: on
 * `sympy__sympy-13878` the r95repl lane applied one byte-identical
 * 4,789-character patch five times, four of those applications preceded by
 * `git checkout -- sympy/stats/crv_types.py`, because a clean fails-before
 * proof required reverting the very work it was meant to prove. Models imitate
 * the example, and the example now shows a run that never gives its work back.
 *
 * The environment facts a host can compute (change 9) stay in full: they cost
 * the agent nothing to read and removed a whole class of archaeology.
 *
 * Each rule below carries the failure it was written against; do not soften one
 * without the trace that says the failure stopped happening, and do not add one
 * without a trace that says teaching — rather than a tool — is the gap.
 *
 * Governing design: `../../docs/concepts.md#model-authoring-surface` (the
 * ruling) and `../../docs/concepts.md#agent-cell-context` (the surface).
 *
 * @since 0.1.0
 */
import type * as Descriptor from "@smthrs/registry/Descriptor";
import type * as AgentEvent from "../AgentEvent.ts";
import type * as Cell from "../Cell.ts";
/**
 * One rendered prompt section, with the digest that identifies its
 * content.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Section {
    readonly id: "cell-contract" | "cell-stance" | "cell-environment" | "cell-jev" | "cell-catalog";
    readonly text: string;
    readonly digest: string;
}
/**
 * Facts about the container a run executes in, computed by the harness.
 *
 * Every field is something the host can read off the environment without
 * knowing anything about the task, which is the whole admission rule: the
 * program that motivated this section rejects instance-specific teaching
 * outright, so the shape is a closed set of typed fields rather than free
 * prose a caller could smuggle an answer into. Facts that are absent are not
 * rendered; the run discovers them the ordinary way.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Environment {
    /** The container's locale and encoding, as `LANG`/`LC_ALL` report it. */
    readonly locale?: string;
    /** Tools a run will reach for that this image does not install. */
    readonly absentTools?: ReadonlyArray<string>;
}
/**
 * Which contract a run is taught.
 *
 * `workspace`, the default, teaches a run that changes a checkout: the REPL,
 * nine rules, a worked bug fix and the checkout's history facts.
 * `conversation` teaches a run that answers a person through the flows its
 * catalog lists: the same REPL and rules 1 to 6, with no example, no rules 7
 * to 9 and no history fact. Neither changes the stance, `jev` or catalog
 * sections.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export type Profile = "workspace" | "conversation";
type CatalogProjection = Cell.FlowProjection & Partial<Pick<Descriptor.FlowDescriptor, "provenance" | "path">>;
/**
 * Builds the cell-contract teaching sections for one frame.
 *
 * The order is by how often each section changes, because every one of them is
 * a prefix segment and a prefix is only cached up to its first edit: the
 * contract is constant for the life of the binary, the environment and the
 * `jev` teaching for the life of a run, and the catalog can differ frame to
 * frame. The `jev` teaching is rendered only when `flows` binds `jev`.
 *
 * `stance` renders a one-line `cell-stance` section between the contract and
 * the environment. It is constant for the run, so the cached prefix holds;
 * with no stance nothing is rendered and the prompt is unchanged.
 *
 * `environment` carries what the host measured about the container. It is
 * optional because the epoch fact — a checkout has no future in it — holds
 * everywhere and is stated with or without a host that measures anything else.
 *
 * `profile` picks the contract; see {@link Profile}. A `conversation` run is
 * taught no epoch fact, so its environment section is rendered only for facts
 * the host measured.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (flows: Readonly<Record<string, CatalogProjection>>, environment?: Environment, stance?: typeof AgentEvent.Stance.Type, profile?: Profile) => ReadonlyArray<Section>;
export {};
