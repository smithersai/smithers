/**
 * The narrowing ledger: which checks this run has run, and over which tree.
 *
 * A run finishes by claiming its work is done. The evidence for that claim is
 * the checks it actually ran, and a check is only evidence for the tree it ran
 * over. The failure this module names is a completion whose last check is a
 * *narrowed* version of one the run had already run in full, taken after the
 * workspace moved and never followed by the broad one: the narrow result is
 * true, the broad one is unknown, and the run reports the unknown half as
 * proven.
 *
 * It is not hypothetical, and it is not one instance's accident. On a graded
 * benchmark the same run shape decided the same instance twice, in two
 * consecutive waves, identically. The journal of the second reads: the run ran
 * `pytest -rA testing/test_collection.py` in full, used its three failures to
 * discard a wrong candidate, edited two source files, re-ran the *same command
 * with a `-k` filter selecting four of seventy-two names* — "4 passed, 68
 * deselected" — and completed on that frame. The graded patch passed both
 * target tests and 144 of 145 neighbours; the one it broke was among the 68 the
 * filter dropped, and the run had watched that exact test pass, on the exact
 * command, before the change that broke it.
 *
 * The harness does not re-run anything to find this out. It compares two things
 * it already records — the input of every call, and the workspace digest each
 * frame closed on — and hands the run one sentence naming the check it is
 * missing. What the run does with that is the run's business: re-run the broad
 * check, or say why it no longer applies. The loop asks once and accepts what
 * comes back, because a harness that verified completions itself would be
 * grading the agent's work with its own, and that hack was removed on purpose.
 *
 * The module names two shapes of the same failure, and the second is here
 * because the first was escaped from the other side. {@link find} is
 * broad-then-narrow, above. {@link findOnly} is narrow-only: the next wave of
 * the same instance ran a filtered reading of the right file, ran nothing else,
 * and completed — so there was no broader check in the ledger and nothing to
 * narrow. Both readings deselected the one neighbour the patch broke.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * How many distinct checks one run carries forward.
 *
 * The ledger is controller state, so it is bounded. Thirty-two covers a whole
 * run at the rate a graded wave actually calls flows — its longest run issued
 * 43 calls across 24 frames, most of them reads of one file — so the broad
 * check a run ran early is still recognisable when it completes. A run that
 * outlives the bound forgets its oldest checks first, which can cost a demand
 * and can never invent one.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const retained = 32;
/**
 * Most distinct terms one recorded check may carry.
 *
 * A ledger entry stores the terms of a call's input, so an input that is mostly
 * *content* — a patch, a file body, a generated document — would store that
 * content twice over. Such a call is also not a check anybody narrows: nothing
 * re-runs a file write with an added filter. The largest input any flow issued
 * across five graded runs carried 119 terms, so the bound is more than twice
 * the observed ceiling and drops only inputs that are payloads.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxTerms = 256;
/**
 * How many UTF-8 bytes of a check's input the demand may quote back.
 *
 * The demand has to name the check the run is missing, and a name it cannot
 * read is not a name. Bounded because the label lives in controller state,
 * once per retained entry. The honest-elision notice may exceed this content
 * bound so it can say how many bytes are missing and where the whole input is.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const labelWidth = 512;
/**
 * An input as its label quotes it: canonical JSON, except that an object's
 * longest string member comes last.
 *
 * The label is clipped to {@link labelWidth}, and a call routed into a task
 * container carries its route beside its program. For a `script` the route
 * already sorts first; for a `command` it sorts after the program and the clip
 * can take the route. Two graded runs of 2026-09-26 listed their scripts as
 * the route plus the first two hundred bytes of the program. So the short
 * members, the route among them, come first in every input, and the longest
 * string, which is the program in every such input, fills the rest of a wider
 * label.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const label: (input: Schema.Json) => string;
/**
 * Whether a term names a target rather than a condition.
 *
 * The distinction is what keeps {@link narrows} one-directional. A call that
 * repeats every term of an earlier call and adds a *condition* — a filter, a
 * selector, a flag — asks for a subset of what the earlier call covered. A call
 * that adds a *target* asks about something the earlier call never looked at,
 * which is a broader question, not a narrower one; running two files where one
 * ran before is not a narrowing and must not be demanded as one.
 *
 * A term is read as a target when it carries a separator inside it — a slash or
 * a dot. That covers paths, file names, dotted module names, and node ids, and
 * it reads a version number or a decimal as a target too. Both errors are in
 * the same direction: a term wrongly read as a target suppresses a demand, and
 * a demand this module does not issue costs nothing.
 *
 * Exported because `UnresolvedFailure` asks a different question of the same
 * distinction — whether a later call came back to what an earlier one was about
 * — and a second copy of this predicate would be a second thing to keep true.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const targeting: (term: string) => boolean;
/**
 * Whether a term names a target a reader would recognise as one.
 *
 * {@link targeting} is the relation's own rule and is deliberately generous:
 * `.py`, `/`, and a bare `tests/` all satisfy it, and each of them only ever
 * costs a demand. Two callers need the answer to a different question — which
 * of a call's terms is the thing it is *about* — and for that a term nobody can
 * read is worse than no term at all. This is that stricter reading: the
 * separator has a real character on both sides, so `tests/test_a.py` and
 * `django.contrib.admin.sites` qualify while a glob's leftover `/` and a bare
 * `.py` do not.
 *
 * One lexical rule, not two: `CallLedger` names a call's subject with it and
 * {@link findOnly} reads a check's subjects with it.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const names: (term: string) => boolean;
/**
 * The terms of one call input in the order the canonical document states them.
 *
 * The whole canonical input is lexed, keys included, so the relation works for
 * a shell command, a structured search, and any host flow this harness has
 * never heard of.
 *
 * Exported in document order because `CallLedger` asks a positional question of
 * the same lexer — which term this call is *about*, which is the first one that
 * {@link targeting} accepts — and a second copy of the separator would be a
 * second thing to keep true. {@link terms} is the set view of the same lex.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const lex: (input: Schema.Json) => ReadonlyArray<string>;
/**
 * The distinct terms of one call input, sorted.
 *
 * Sorted and de-duplicated because the only questions asked of it are set
 * questions.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const terms: (input: Schema.Json) => ReadonlyArray<string>;
/**
 * The terms of one call input that could be conditions its author added.
 *
 * The whole document is lexed, so three kinds of term come out of the lexer
 * that are part of how the call is *written* rather than a constraint on what
 * it covers, and each is removed here:
 *
 * - a term that names a target ({@link targeting}) is what the call is about,
 *   not a condition on it;
 * - a term that is a key of the input document itself is the call's shape —
 *   `command`, `timeoutMs` — which the author fills in, not adds;
 * - a term that is only digits is a magnitude — a timeout, a limit, an offset
 *   — and a condition that subsets a check names cases rather than counting
 *   them. The flag carrying such a number is still read as a condition, so a
 *   stop-early flag does not hide behind its argument.
 *
 * All three exclusions err in one direction: a term wrongly removed here can
 * suppress a demand and can never invent one.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const conditions: (input: Schema.Json) => ReadonlyArray<string>;
declare const Check_base: Schema.Class<Check, Schema.Struct<{
    /** The flow the call named. */
    readonly flow: Schema.String;
    /** The call's identity, as the controller's own signature names it. */
    readonly signature: Schema.String;
    /** The distinct terms of the call's input, sorted; see {@link terms}. */
    readonly terms: Schema.$Array<Schema.String>;
    /**
     * The subset of {@link Check.terms} that could be conditions the call's
     * author added; see {@link conditions}.
     *
     * Stored rather than recomputed because it is a fact about the input
     * document — its key names — and the ledger keeps terms, not documents.
     * Defaults empty, so an entry journaled before the field decodes; the only
     * reader is {@link findOnly}, where an empty set means the check carries no
     * added condition, which suppresses a demand and never invents one.
     */
    readonly conditions: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.$Array<Schema.String>>, never>;
    /**
     * Content address of the workspace the frame that ran this check closed on.
     *
     * The *closing* digest, and not the opening one, because a frame's calls are
     * not ordered against its edits in anything the harness records. A check that
     * ran in the same frame as an edit is therefore stamped as if it ran after
     * that edit, which reads a stale check as current and suppresses a demand.
     * Conservative on purpose: the whole module errs towards asking nothing.
     *
     * Empty when the frame had no complete measurement to stamp it with, which
     * makes the entry inert — an unmeasured tree cannot say anything moved.
     */
    readonly digest: Schema.String;
    /** The call's input as it was written, clipped, for the demand to quote. */
    readonly label: Schema.String;
    /**
     * Whether the call's own result reported a failing exit status.
     *
     * Nothing in this module reads it: a check that reported failures is exactly
     * as good evidence of what the tree does as one that reported none, and the
     * narrowing relation is about the shape of a question rather than its answer.
     * It is recorded here because `UnresolvedFailure` asks about the answer, and
     * two ledgers over the same calls would be two things to keep true. See
     * `UnresolvedFailure` `failed` for what "reported" means, and why a flow that
     * declares no exit status is neither failing nor passing.
     */
    readonly failing: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Boolean>, never>;
    /**
     * Whether the call's own result reported a passing exit status.
     *
     * Not the negation of {@link Check.failing}, and that is the whole reason it
     * is a second field: a flow that reports no exit status at all — a read, a
     * search — is neither failing nor passing, and reading its silence as a pass
     * would let `Sufficiency` build a completion signal out of a file read. Both
     * default false, so a result that says nothing about a subject says nothing
     * here either. See `UnresolvedFailure` `passed`.
     */
    readonly passing: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Boolean>, never>;
    /**
     * Whether the run declared this call as its check: rule 7's
     * `verification = { flow, input }`, called with that very input. See
     * `Sandbox.Invocation.declared`.
     *
     * The demands that hold a completion over a check read only these. Every
     * call that reports an exit status lands in this ledger, and a read or a
     * search is one: a `grep` that matched nothing exits 1, and a later read of
     * the same file then looked like a failing check the run had stepped around.
     * On the paired SWE-bench Pro run of 2026-10-14 that held 27 of 85
     * "Unanswered failure" completions, and all 6 "Only reading" holds stood on
     * the `git diff` read rule 5 itself asks for (#3994). Telling a read from a
     * check by its command would be a classifier; the run already says which
     * call is its check, so the ledger records that. Defaults false, so an
     * entry journaled before the field holds nothing.
     */
    readonly declared: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Boolean>, never>;
    /**
     * Whether {@link Check.digest} is the tree this check actually read.
     *
     * A check is stamped with its frame's closing digest, and a frame may both
     * edit and check. The frame's writes are calls, though, and calls settle in
     * order, so the question has an answer rather than a guess: a check with no
     * standing write after it read the tree the frame closed on and is stable; a
     * check with a write after it read a tree that is gone and is not. A frame
     * whose measurement moved with no call declaring it — a shell redirect —
     * cannot place the move among its calls at all, so nothing in it is stable.
     *
     * What it buys each reader: for {@link find} an unstable reading is a stale
     * check read as current, which costs a demand; for a *failure* carried by
     * one the stamp would attribute a result to a tree the check never ran over,
     * so `UnresolvedFailure` requires this. A reading attributed to a checkpoint
     * is stable by pin rather than by position.
     */
    readonly stable: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Boolean>, never>;
}>, {}>;
/**
 * One check this run has run, and the tree it ran over.
 *
 * A call becomes a check when it settled successfully and declared no write.
 * "Successfully" is about the call and not about the result: a command that
 * exits non-zero settled successfully, and its output — clean or informative —
 * is exactly what a run reads before deciding what to change. The graded run
 * this module was built from used the three failures its broad check reported
 * to discard a wrong candidate; a rule that only remembered green checks would
 * have forgotten the most useful thing that run ever ran. A call the flow could
 * not run at all observed nothing, and a call that changes the workspace is not
 * an observation of it.
 *
 * @category models
 * @since 0.1.0
 */
export declare class Check extends Check_base {
}
/**
 * A check this frame ran, paired with the broader one it stands in for.
 *
 * @category models
 * @since 0.1.0
 */
export interface Narrowing {
    /** The broader check, last run over a tree that has since changed. */
    readonly earlier: Check;
    /** This frame's check, which repeats it and adds conditions. */
    readonly later: Check;
}
/**
 * Records one settled call as a check, unless its input is a payload.
 *
 * `undefined` is not a failure: it is an input with more distinct terms than
 * {@link maxTerms}, which is a call carrying content rather than a question.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const check: (options: {
    readonly flow: string;
    readonly signature: string;
    readonly input: Schema.Json;
    readonly digest: string;
    /** Whether the call's result reported a failing exit status. */
    readonly failing?: boolean | undefined;
    /** Whether the call's result reported a passing exit status. */
    readonly passing?: boolean | undefined;
    /** Whether the run declared the call as its check; see {@link Check.declared}. */
    readonly declared?: boolean | undefined;
    /** Whether the frame that ran it left the workspace as it found it. */
    readonly stable?: boolean | undefined;
}) => Check | undefined;
/**
 * Whether one call's terms are a strict narrowing of another's.
 *
 * The relation is: every term the earlier call carried is carried again, at
 * least one term is added, and no added term names a target
 * ({@link targeting}). In words — same question, more conditions on it. It is
 * deliberately syntactic. It parses no flag, knows no test runner, and would
 * hold identically for a search flow, a linter, or a host flow written after
 * this one; the moment it started reading `-k` it would be a rule about pytest
 * rather than a rule about evidence.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const narrows: (later: ReadonlyArray<string>, earlier: ReadonlyArray<string>) => boolean;
/**
 * Finds the broadest check a completing frame narrowed and did not re-run.
 *
 * All five conditions have to hold, and each of them is read off something the
 * harness already records:
 *
 * 0. the earlier check is one the run declared as its check
 *    ({@link Check.declared}): only the run's own check can hold its
 *    completion, and a read it ran in passing is not one (#3994);
 * 1. the frame closed on a complete measurement, so a digest means something;
 * 2. some earlier check was last run over a *different* tree, which is what
 *    "you have changed something since" means with no timestamps involved;
 * 3. this frame issued no call with that check's exact signature, so the run
 *    did not simply re-run it here;
 * 4. some call this frame issued names the same flow and {@link narrows} it.
 *
 * The broadest such earlier check wins — fewest terms, which under this
 * module's own relation is the least constrained question — so the demand names
 * the strongest evidence the completion is missing rather than the first one
 * found. Ties go to the more recently run check.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const find: (options: {
    /** Checks this run ran before this frame, oldest first. */
    readonly ledger: ReadonlyArray<Check>;
    /** Checks this frame ran. */
    readonly frame: ReadonlyArray<Check>;
    /** The workspace digest this frame closed on; empty when unmeasured. */
    readonly digest: string;
}) => Narrowing | undefined;
/**
 * States which check a completion is standing on, and which one it is missing.
 *
 * The text asks for a decision and names both ways out as equals, in the shape
 * the read-only demand already uses: re-run the check that was skipped, or say
 * why it does not apply. It never asserts the run is wrong — a filter can be
 * the right check after a change that removed cases — it asserts only what is
 * true from the record: the broad result the run is relying on was measured on
 * a tree that no longer exists.
 *
 * It also says plainly that nothing re-runs the check for the run, and that the
 * next answer stands. Anything softer invites a re-submission of the same
 * frame; anything harder would be the harness pretending it will keep score.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const demand: (found: Narrowing) => string;
/**
 * The reading a completion stands on, when the run holds no other reading of
 * what it names.
 *
 * @category models
 * @since 0.1.0
 */
export interface Only {
    /** The last check the completing frame ran. */
    readonly later: Check;
    /** The subjects it names, as {@link names} reads them, sorted. */
    readonly targets: ReadonlyArray<string>;
}
/**
 * Finds a completion standing on the run's only reading of its own subjects.
 *
 * {@link find} names the completion whose check *narrows* an earlier, broader
 * one. This names the case that escapes it from the other side: a completion
 * whose check narrows nothing because the run never took the broader reading at
 * all. On a graded benchmark the same instance was lost both ways in two
 * consecutive waves — one run took a broad reading of the wrong file, the next
 * took a filtered reading of the right one and ran nothing else — and the
 * second escaped {@link find} because there was nothing in the ledger to
 * narrow. The filtered reading deselected the one neighbour the patch broke.
 *
 * The harness cannot see that a filter is a filter without learning one test
 * runner's flags, so it does not try. It asks the question the record can
 * answer: is this reading the only one this run has of what it names, and does
 * it carry a phrase this run alone put there.
 *
 * Six conditions, each read off the run's own record:
 *
 * 0. that check is one the run declared as its check ({@link Check.declared}).
 *    Rule 5 asks the completing cell to read the tree back with `git status`
 *    and `git diff`, and that read, naming the files the run changed, was the
 *    last check of every completion this demand held on 2026-10-14 (#3994);
 * 1. the completing frame ran at least one check, and the subject is its
 *    *last* one — the reading the completion stands closest to, as
 *    `UnresolvedFailure` reads its own ledger;
 * 2. that check names at least one subject ({@link names}) and carries at
 *    least one condition ({@link conditions}) the run itself added: a term
 *    that is not in the text the run was handed (`taught`) and not in any
 *    other check the run has made. A term the harness taught the run — the
 *    runner its task names, a flag the task prescribes, an envelope value its
 *    own example shows — is the run doing as it was told, and a term the run
 *    uses in its other checks is how this run phrases a question. Neither is
 *    a condition this check put on its subjects, and a check whose every
 *    non-target term is accounted for one of those two ways carries nothing
 *    the demand could ask to see removed;
 * 3. the run never ran this exact call before this frame. A call replayed from
 *    an earlier frame is the run's own baseline re-run byte for byte, which is
 *    the discipline the contract asks for and the opposite of the failure here;
 * 4. every subject it names is named by some other check of this run, so these
 *    are subjects the run has been working on rather than a container path or a
 *    scratch directory that one command creates and uses;
 * 5. no other check of this run names all of them together, so nothing in the
 *    record says what they report as one.
 *
 * ## What it deliberately cannot see
 *
 * Conditions 4 and 5 together mean a check naming exactly *one* subject is
 * never named: if the run read that subject anywhere else, that reading covers
 * this one, and if it did not, there is nothing to corroborate against. So the
 * demand is about a *combination* the run has read only through one command,
 * and a single filtered file with no other mention of the file in the run goes
 * unremarked.
 *
 * That is a chosen floor rather than an oversight. Three benchmark waves
 * produced fifteen completions between them, and the shapes are not separable
 * above it: the losing run's `check <file> -k "<two cases>"` and a resolved
 * run's `check <file-a> <file-b>` differ only in what the flag means, which is
 * a fact about one test runner. Every weaker condition tried against those
 * fifteen runs fired on one or both of the two best rounds the harness has ever
 * scored — a demand costing a correct round a frame to ask about a check that
 * carries no condition at all. This one speaks once, to the run that lost its
 * instance to a filter, naming the command that carried it, and says nothing to
 * the other fourteen.
 *
 * Condition 2's second half was measured in, not reasoned in. The r97 wave
 * fired this demand five times: twice on completions standing on a `-k`
 * filter — the failure the module exists to catch — and three times on runs
 * whose last check ran a whole test module exactly as their task text
 * prescribed, `<interpreter> -m <runner> <flag> <file>`. Each of those three
 * answered the demand by re-issuing the identical completion with a sentence
 * saying the check carried no filter, and each was accepted: the demand
 * taught the harness nothing and cost a correct run one full-context frame.
 * What separates the five in the record is exactly condition 2: every
 * non-target term of the three was taught by the run's own prompt, part of
 * the input's own shape, or already in the run's other checks, and the two
 * that deserved the demand each carried a filter phrase found nowhere else in
 * the run. The residual errors both suppress: a run whose task text happens
 * to contain a term it later uses as a filter, or whose earlier checks
 * carried the same filter flag over other subjects, completes unasked — and a
 * demand this module does not issue costs nothing.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const findOnly: (options: {
    /** Every check this run has run, this frame's included, oldest first. */
    readonly ledger: ReadonlyArray<Check>;
    /** Signatures the run had already issued before this frame. */
    readonly before: ReadonlyArray<string>;
    /** Checks this frame ran, in the order they settled. */
    readonly frame: ReadonlyArray<Check>;
    /**
     * The distinct terms of the text the run was handed — its teaching, its
     * catalog, its task — as {@link terms} lexes it.
     *
     * The prefix of the run's own context window is that text and nothing else:
     * nothing model-authored lands there, so a run cannot teach itself a term
     * by using it.
     */
    readonly taught: ReadonlyArray<string>;
}) => Only | undefined;
/**
 * States that the completion has one reading of its subjects, and asks for the
 * other one.
 *
 * It quotes the check, names the subjects, and says exactly what the record
 * establishes: no other call of this run covers them. It does not claim the
 * reading is filtered — the harness cannot read a flag — so it names what a
 * condition is and leaves the run to say whether it has one. The two ways out
 * are equals, as they are in every demand here, and the second answer stands.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const demandOnly: (found: Only) => string;
/**
 * Folds this frame's checks into the run's ledger, newest last and bounded.
 *
 * A repeated signature moves to the newest position rather than taking a second
 * slot, so a run looping on one command cannot push the broad check it ran
 * early out of the ledger — and its digest is restamped, which is how re-running
 * a check answers the demand it caused.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const remember: (ledger: ReadonlyArray<Check>, added: ReadonlyArray<Check>) => ReadonlyArray<Check>;
/**
 * The ledger schema carried in controller state.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Ledger: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.$Array<typeof Check>>, never>;
export {};
