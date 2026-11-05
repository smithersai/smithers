/**
 * A scripted model for the built-in flows a Smithers install runs: a TODO's
 * coding run, the stack's review of its pull request, a conflict resolution,
 * `/review`, and the wiki review.
 *
 * A test of an install drives a TODO through its states: Working, Needs you,
 * failed checks, a repaired attempt, In review. A recording replays one real
 * run, but no real model asks a question, breaks the build once, or waits on
 * cue. This script does, on purpose and on every run. Each turn is recognized
 * by its step's own system teaching and answered with one cell that settles
 * the step's declared output: the plan names one file, the edit appends a
 * greeting to it, the review approves, and the judge routes the TODO to
 * implement and finds every result sound.
 *
 * The test steers a TODO with {@link Directives}, written into the TODO's
 * prompt by {@link tag}. The prompt is the one channel an out-of-process test
 * has into the model, so a directive travels as a bracketed tag such as
 * `[ASK]` or `[HOLD t2]`; ordinary prose never sets one.
 *
 * `smthrs-model-server --script builtin` serves it over HTTP.
 *
 * @since 1.0.0
 */
import * as Evaluator from "@smthrs/model/Evaluator";
import * as ScriptedModel from "./ScriptedModel.vibe";
/**
 * How a TODO's prompt steers its scripted run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Directives {
    /** The request review asks {@link QUESTION} first, so the TODO needs you; the edit writes the answer. */
    readonly ask?: boolean | undefined;
    /** The edit empties `JOURNEY.md`, so a check that reads it fails, until a later message says `fixed`. */
    readonly fail?: boolean | undefined;
    /**
     * The first edit leaves `JOURNEY.md` one blank line: `test -s` passes and
     * `grep -q .` fails its first attempt. The repair restores the file, so the
     * second attempt passes in the same run.
     */
    readonly failOnce?: boolean | undefined;
    /** The edit also appends a line to `JOURNEY.md`; the repair of `failOnce` sets it. */
    readonly restore?: boolean | undefined;
    /** Ends `fail` and `failOnce`, from a steer, an answer or retry feedback. */
    readonly fixed?: boolean | undefined;
    /** The edit turn waits on this `TurnGate` key until the test releases it. */
    readonly hold?: string | undefined;
    /** A conflict turn on this TODO's file gives up instead of resolving it. */
    readonly noResolve?: boolean | undefined;
    /** The edit appends to this path instead of `JOURNEY.md`. */
    readonly file?: string | undefined;
    /** The edit writes only `.smithers/flows/todo/flow.ts`: the TODO flow plus {@link CHANGELOG_STEP}. */
    readonly flowEdit?: boolean | undefined;
    /** The edit also appends one line to `CHANGELOG.md`. */
    readonly changelog?: boolean | undefined;
    /** Before writing, the edit runs `id -u` and refuses unless the coding tools run as this uid. */
    readonly observeUid?: number | undefined;
    /** The pull request review tries `write` and `bash` and approves only when both are refused. */
    readonly probeReview?: boolean | undefined;
}
/**
 * The prompt text that carries `directives`: one bracketed tag each.
 *
 * @throws Error when a hold key, a file path or a uid cannot be written as a tag.
 * @category constructors
 * @since 1.0.0
 */
export declare const tag: (directives: Directives) => string;
/**
 * The directives a text carries, as the script reads them: `fail` and
 * `failOnce` are already ended by `fixed`. A value that is not a string is
 * read as its JSON.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const directives: (value: unknown) => Directives;
/**
 * The question an `ask` TODO's request review asks.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const QUESTION = "Which greeting should the file carry?";
/**
 * The greeting the edit appends when the options name none.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const GREETING = "Hello from Smithers!";
/**
 * The one commit message the scripted run writes.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const SUBJECT = "\uD83D\uDCDD docs: add a greeting to JOURNEY.md";
/**
 * The step a `flowEdit` TODO adds to every later TODO's request.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const CHANGELOG_STEP = "[CHANGELOG] Add one line for this change to CHANGELOG.md.";
/**
 * The scripted review of a TODO's pull request: `approve` on its first line.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const REVIEW_ANSWER = "approve\n\nThe change does what the TODO asks and nothing else.";
/**
 * The system teaching that names each scripted step: the script answers a
 * turn whose system text contains its step's teaching, and a conflict turn
 * whose messages contain `conflict`. A flow that rewords its teaching leaves
 * its turn unscripted, so a test of the flows asserts each one still appears.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const teachings: {
    readonly "coding/review-request": "Review a coding request against supplied repository memory";
    readonly "coding/draft-plan": "Plan one linear mythical coding progression";
    readonly "coding/edit-atom": "Implement the single atomic change";
    readonly "coding/select-owner-repair": "Select one existing JJ atom owned by this Change to correct the supplied findings";
    readonly "coding/review-final-history": "Clean the descriptions of the validated request";
    readonly "coding/review-lens": "Review one implementation diff through exactly one lens";
    readonly "review/change": "Your answer's first line is exactly `approve` or `request-changes`";
    readonly "review/file": "You are a precise code reviewer.";
    readonly "review/verify": "You adjudicate code-review findings against the diff";
    readonly "wiki/review-page": "Review a repository wiki page against its exact source snapshot.";
    readonly conflict: "Resolve the conflict in path";
};
/**
 * One finding the scripted `/review` reports.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReviewFinding {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
    readonly existingCode: string;
    readonly severity: string;
    readonly category: string;
    readonly confidence: string;
    /** The finding is reported when the reviewed text holds `path` and this text; `existingCode` by default. */
    readonly match?: string | undefined;
    /** Why the verification turn keeps it. */
    readonly reason?: string | undefined;
}
/**
 * What a builtin script is built from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    /** The greeting the edit appends; {@link GREETING} by default. */
    readonly greeting?: string | undefined;
    /** The source of `.smithers/flows/todo/flow.ts`, which a `flowEdit` TODO edits. Required for `flowEdit`. */
    readonly todoFlow?: string | undefined;
    /**
     * Steps besides `coding/edit-atom` that hold on the TODO's `hold` key, such
     * as `coding/draft-plan` to pause a TODO while it plans.
     */
    readonly holdAt?: ReadonlyArray<string> | undefined;
    /** What the scripted `/review` reports. Nothing by default. */
    readonly reviewFindings?: ReadonlyArray<ReviewFinding> | undefined;
}
/**
 * A message as a Chat Completions client sends it.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChatMessage {
    readonly role?: unknown;
    readonly content?: unknown;
}
/**
 * A built script.
 *
 * It keeps one piece of state: the directives each planned file's TODO
 * carried, so a later conflict turn on that file answers as its TODO asked.
 *
 * @category models
 * @since 1.0.0
 */
export interface BuiltinScript {
    /** The reply for a Chat Completions conversation, or `undefined` for a turn no builtin step sends. */
    readonly respond: (messages: ReadonlyArray<ChatMessage>) => ScriptedModel.Reply | undefined;
    /** {@link respond} as a `ScriptedModel` script. */
    readonly script: ScriptedModel.Script;
}
/**
 * Builds a script.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (options?: Options) => BuiltinScript;
/**
 * The reply for a turn no builtin step sends: a cell that settles it with
 * `{ messages: ["scripted"] }`, named `unscripted`, with the turn's system
 * teaching and last message (6,000 characters of each) on its trace entry,
 * so the next step can be scripted from the evidence.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const unscripted: ScriptedModel.Script;
/**
 * Whether an evaluation is one the coding run asks.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const isJudgement: (questions: Readonly<Record<string, unknown>> | null | undefined) => boolean;
/**
 * The judge's answer to one question: route a TODO to implement, call its
 * result complete and on target and nothing else, and a wiki citation
 * supported.
 *
 * @throws Error for a choice it cannot route or a question type it does not know.
 * @category constructors
 * @since 1.0.0
 */
export declare const answer: (name: string, question: {
    readonly type?: unknown;
    readonly criteria?: unknown;
}) => Evaluator.RawAnswer;
/**
 * {@link answer} as an evaluator. A question it cannot answer fails the
 * evaluation as `invalid_question`. Each answer reports 120 input tokens, so a
 * metering proxy prices it as it prices any judgment.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const evaluator: Evaluator.Evaluator;
