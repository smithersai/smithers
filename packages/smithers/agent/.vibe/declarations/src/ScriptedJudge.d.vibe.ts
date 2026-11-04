/**
 * Offline judges for fixtures, answered from the evidence each classifier
 * sends.
 *
 * {@link layer} answers only the completion brake, and compares reported
 * commands with the evidence the brake received. {@link layerAll} answers
 * every classifier the agent asks, one {@link answer} per classifier, each
 * computed from the state it is sent. Neither is a general language judge and
 * neither must ever be a production default. Whole-host fixtures with other
 * classifiers must dispatch those question ids too;
 * .smithers/flows/test/fixtures/scripted-judge.ts is the example. Unknown questions
 * fail closed rather than borrowing another classifier's probabilities.
 *
 * @since 1.0.0-rc.0
 */
import * as Evaluator from "@smthrs/model/Evaluator";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
type Answers = Readonly<Record<string, Evaluator.ScriptedAnswer>>;
/**
 * One classifier's scripted answers to one request, or the outage reply when
 * its state is not what that classifier sends.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Answerer = (request: Evaluator.Request) => Effect.Effect<Answers, Evaluator.EvaluatorError>;
/**
 * One answerer per classifier. {@link layer} and {@link layerAll} dispatch to
 * these by question id; a fixture that scripts its own classifiers calls them
 * for the agent's.
 *
 * @category answerers
 * @since 1.0.0-rc.0
 */
export declare const answer: {
    /**
     * The completion brake's three answers, from one reading of one evidence
     * record.
     *
     * `invented` is the only one with a verdict behind it: whether the claim
     * reports work this run's record does not record. `complete` and
     * `overclaims` are bounce heights that decide nothing — `CompletionClaim`'s
     * own corpus demoted them because neither separates an honest completion
     * from a lie — so they are answered consistently with the one reading: a
     * claim that reports work nothing recorded is also a claim that overclaims
     * and has not shown the task done, and a claim that does not is neither.
     * Answering them at no demand keeps a fixture's measured model-call counts
     * honest, since a bounce spends a frame that a fixed script would answer
     * with the same sentence.
     *
     * `sentence${i}` per sentence, when the brake reads a long claim one
     * sentence at a time: the same `invented` reading, of that sentence alone.
     */
    readonly completion: Answerer;
    /**
     * `unnecessary_${i}` per item. A flow or skill is unnecessary (0.95) when
     * neither its name nor any of its words of four or more characters appears
     * in the task, query or recent text; an instruction chunk or memory row
     * when it shares no such word with them. Anything else is needed (0.05).
     */
    readonly relevance: Answerer;
    /**
     * `remove_${i}` and `keep_${i}` per frame: removable (0.9) when what it
     * observed is byte-identical to what a later frame observed, else 0.1;
     * never worth keeping verbatim (0.1).
     */
    readonly compaction: Answerer;
    /**
     * The routing graph's edge questions, from the task's words: `phase` is
     * `review`, `plan`, or `ui` when the task says so, `implement` when it
     * says fix, implement, rename, or refactor, else `other`; `size` is
     * `important` when it says critical, architecture, or migrate, `middle`
     * when it says refactor, else `simple`; `clarity` is `unknowns` when it
     * says unfamiliar or unknown, else `clear`; `binary` is yes (0.9) when it
     * says test, pass, or check, else no (0.1). `system`, when asked: `change`
     * when the task says fix or implement, else `investigate`.
     */
    readonly route: Answerer;
    /**
     * A calm run: thrashing only when more than one frame repeated, on target,
     * nothing suspect, outdated or irrelevant, every emotion `none`, and nothing
     * needed from a person. A skill monitor fires (0.9) while the run has not
     * called the skill it asks about; every other monitor stays quiet (0.05).
     */
    readonly supervisor: Answerer;
    /**
     * `memory/mine`: no candidate is a durable fact or an issue (0.1), so an
     * offline run remembers nothing.
     */
    readonly mine: Answerer;
};
/**
 * The {@link answer} for a question-id set, or none for a set no classifier
 * asks.
 *
 * @category answerers
 * @since 1.0.0-rc.0
 */
export declare const answererFor: (ids: ReadonlyArray<string>) => Answerer | undefined;
/**
 * Deliberately bind this only in an offline fixture whose reported commands
 * use the syntax above. An unrecorded command changes the verdict; no answer
 * is an unconditional permission to complete.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layer: Layer.Layer<Evaluator.Evaluator>;
/**
 * Every classifier the agent asks, each answered by its {@link answer}: the
 * completion brake, relevance, compaction marks, seat routing, the
 * supervisor and the transcript miner. Bind this only in an offline fixture; a question-id set no
 * classifier asks fails `unreachable`.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layerAll: Layer.Layer<Evaluator.Evaluator>;
export {};
