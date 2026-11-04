/**
 * Typed questions about a JSON state, answered by Jev through an
 * {@link Evaluator.Evaluator}.
 *
 * A host declares a classifier once: an id, a state schema, and a map of
 * questions built with {@link boolean}, {@link choice} and {@link score}. The
 * answer type is inferred from the questions, so a choice's options become a
 * literal union and a score's rungs become its labels. `evaluate` sends one
 * state and decodes the transport's raw answers against the questions;
 * `evaluateAll` fans out over many states with bounded concurrency, one
 * request per state, and keeps every result. `digest` is the canonical hash
 * of the declaration, so a durable call key that folds it in never replays an
 * answer to a question that has since changed.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Evaluator from "../../../src/Evaluator.ts";
declare const ClassifierError_base: Schema.Class<ClassifierError, Schema.TaggedStruct<"flows/model/ClassifierError", {
    readonly code: Schema.Literals<readonly ["unconfigured", "unreachable", "refused", "empty", "timeout", "invalid_answer", "invalid_question"]>;
    readonly status: Schema.optional<Schema.Number>;
    readonly resetAtEpochMillis: Schema.optional<Schema.Number>;
    readonly message: Schema.String;
    /** What the reading paid before it failed; see `Evaluator.EvaluatorError.usage`. */
    readonly usage: Schema.optional<Schema.Struct<{
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly modelId: Schema.optional<Schema.String>;
        readonly costUsd: Schema.optional<Schema.Number>;
    }>>;
}>, import("effect/Cause").YieldableError>;
/**
 * The classifier's failure vocabulary: the transport's codes, plus
 * `invalid_answer` for a raw answer the question's shape does not accept and
 * `invalid_question` for a state the classifier's schema does not encode.
 * Typed, never thrown.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare class ClassifierError extends ClassifierError_base {
}
/**
 * One question as it crosses the wire; the schema for a model-authored
 * question on the ad-hoc path. The same value as `Evaluator.Question`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Question: Schema.Union<readonly [typeof Evaluator.BooleanQuestion, typeof Evaluator.ChoiceQuestion, typeof Evaluator.ScoreQuestion]>;
/**
 * The decoded form of {@link Question}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Question = Evaluator.Question;
/**
 * A yes/no question. `criteria`, when present, says what each side means. The
 * same class as `Evaluator.BooleanQuestion`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const BooleanQuestion: typeof Evaluator.BooleanQuestion;
/**
 * The decoded form of {@link BooleanQuestion}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type BooleanQuestion = Evaluator.BooleanQuestion;
/**
 * A question answered with one of the named options in `criteria`. The same
 * class as `Evaluator.ChoiceQuestion`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const ChoiceQuestion: typeof Evaluator.ChoiceQuestion;
/**
 * The decoded form of {@link ChoiceQuestion}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ChoiceQuestion = Evaluator.ChoiceQuestion;
/**
 * A question answered along the ordered rubric in `criteria`. The same class
 * as `Evaluator.ScoreQuestion`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const ScoreQuestion: typeof Evaluator.ScoreQuestion;
/**
 * The decoded form of {@link ScoreQuestion}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ScoreQuestion = Evaluator.ScoreQuestion;
/**
 * The map of questions a classifier declares, keyed by question id.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Questions = Readonly<Record<string, BooleanQuestion | ChoiceQuestion | ScoreQuestion>>;
/**
 * Builds a yes/no question.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const boolean: (options: {
    readonly instructions: string;
    readonly criteria?: {
        readonly true: string;
        readonly false: string;
    };
}) => Evaluator.BooleanQuestion;
/**
 * Builds a question answered with one of the named options, keeping the
 * literal option keys so the answer's `value` is their union. Between 2 and
 * 255 options; fewer or more is a declaration defect and fails the field's
 * schema check at construction, the same moment a malformed schema would.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const choice: <const Criteria extends Readonly<Record<string, string>>>(options: {
    readonly instructions: string;
    readonly criteria: Criteria;
}) => Omit<Evaluator.ChoiceQuestion, "criteria"> & {
    readonly criteria: Criteria;
};
/**
 * Builds a question answered along an ordered rubric, keeping the literal rung
 * labels. At least 2 distinct rungs; fewer, or a repeated label, is a
 * declaration defect and fails the field's schema check at construction.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const score: <const Rungs extends ReadonlyArray<string>>(options: {
    readonly instructions: string;
    readonly criteria: Rungs;
}) => Omit<Evaluator.ScoreQuestion, "criteria"> & {
    readonly criteria: Rungs;
};
/**
 * The answer to a {@link BooleanQuestion}: the value, and the probability the
 * transport gave to yes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface BooleanAnswer {
    readonly value: boolean;
    readonly probability: number;
}
/**
 * The answer to a {@link ChoiceQuestion}: the chosen option, the distribution
 * over every option, and the confidence, which is the largest probability in
 * that distribution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ChoiceAnswer<Key extends string = string> {
    readonly value: Key;
    readonly probabilities: Readonly<Record<Key, number>>;
    readonly confidence: number;
}
/**
 * The answer to a {@link ScoreQuestion}: the score as the transport gave it,
 * interpolated over zero-based rung indexes; the label of the nearest rung;
 * the distribution over rungs keyed by label; and the confidence, which is
 * the largest probability in that distribution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ScoreAnswer<Label extends string = string> {
    readonly value: number;
    readonly label: Label;
    readonly probabilities: Readonly<Record<string, number>>;
    readonly confidence: number;
}
/**
 * The typed answer a question infers.
 *
 * A `Schema.Class` instance type is not generic, so this reads the option keys
 * and rung labels off `criteria` structurally rather than off a class type
 * parameter. {@link choice} and {@link score} keep those literals on their
 * return types, so `answers.role.value` stays the option union and
 * `answers.risk.label` stays the rung union.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type AnswerOf<Q> = Q extends {
    readonly type: "boolean";
} ? BooleanAnswer : Q extends {
    readonly type: "choice";
    readonly criteria: infer Criteria extends Readonly<Record<string, string>>;
} ? ChoiceAnswer<keyof Criteria & string> : Q extends {
    readonly type: "score";
    readonly criteria: ReadonlyArray<infer Label extends string>;
} ? ScoreAnswer<Label> : never;
/**
 * The typed answers a map of questions infers, keyed like the questions.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type AnswersOf<Qs extends Questions> = {
    readonly [Id in keyof Qs]: AnswerOf<Qs[Id]>;
};
/**
 * One decoded answer, in any of the three shapes; the schema for the ad-hoc
 * path, where the questions are not known at compile time.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Answer: Schema.Union<readonly [Schema.Struct<{
    readonly value: Schema.Number;
    readonly label: Schema.String;
    readonly probabilities: Schema.$Record<Schema.String, Schema.Number>;
    readonly confidence: Schema.Number;
}>, Schema.Struct<{
    readonly value: Schema.Boolean;
    readonly probability: Schema.Number;
}>, Schema.Struct<{
    readonly value: Schema.String;
    readonly probabilities: Schema.$Record<Schema.String, Schema.Number>;
    readonly confidence: Schema.Number;
}>]>;
/**
 * The decoded form of {@link Answer}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Answer = typeof Answer.Type;
/**
 * Decodes a transport's raw answers against the questions they answer.
 *
 * Every question needs an answer of its own type. A boolean's probability
 * and every distribution entry must lie in `[0, 1]`; a choice must name one
 * of its options; a score must lie within the rubric's index range. A
 * distribution the transport did not send is one-hot on the chosen option or
 * nearest rung, so confidence reads 1 and a caller that wants to tell the two
 * apart keeps the raw response. A score distribution uses one dictionary
 * format: all valid zero-based indexes, otherwise all declared labels.
 * Indexes take precedence when numeric labels make both formats valid.
 * Both the typed path and the ad-hoc path go through here.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export declare const decodeAnswers: <Qs extends Questions>(questions: Qs, raw: Evaluator.RawAnswers) => Effect.Effect<AnswersOf<Qs>, ClassifierError>;
/**
 * How sure an answer is, from 0 to 1: a boolean's distance from even odds,
 * doubled; a choice's or score's `confidence`.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export declare const confidence: (answer: Answer) => number;
/**
 * The answer's value when its {@link confidence} is at or above `floor`,
 * else none.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export declare const confident: {
    (answer: BooleanAnswer, floor: number): Option.Option<boolean>;
    <Key extends string>(answer: ChoiceAnswer<Key>, floor: number): Option.Option<Key>;
    <Label extends string>(answer: ScoreAnswer<Label>, floor: number): Option.Option<number>;
    (answer: Answer, floor: number): Option.Option<boolean | string | number>;
};
/**
 * Options for {@link Classifier.evaluateAll}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface EvaluateAllOptions {
    /** How many states are in flight at once. Defaults to {@link defaultConcurrency}. */
    readonly concurrency?: number;
}
/**
 * The concurrency `evaluateAll` uses when its options name none.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const defaultConcurrency = 8;
/**
 * What one reading answered and what it cost: the typed answers, beside
 * everything else the transport's `Evaluator.Response` reported about the call
 * that produced them. `usage` is the tokens the reading spent, `latencyMs` how
 * long it took, and `timing` where that time went on the wire.
 *
 * @category models
 * @since 1.0.0
 */
export interface Reading<Qs extends Questions> extends Omit<Evaluator.Response, "answers"> {
    readonly answers: AnswersOf<Qs>;
}
/**
 * A declared classifier: its identity, its schemas, and the ways to ask.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Classifier<Id extends string, State extends Schema.Codec<any, any>, Qs extends Questions> {
    readonly id: Id;
    readonly description: string;
    readonly state: State;
    readonly questions: Qs;
    /** The SHA-256 of the canonical JSON of `{ id, questions }`. */
    readonly digest: string;
    /** Asks every question about one state. */
    readonly evaluate: (state: State["Type"]) => Effect.Effect<AnswersOf<Qs>, ClassifierError, Evaluator.Evaluator>;
    /**
     * Asks exactly what {@link Classifier.evaluate} asks, and answers what the
     * reading cost beside its answers. One request; nothing more is sent.
     */
    readonly read: (state: State["Type"]) => Effect.Effect<Reading<Qs>, ClassifierError, Evaluator.Evaluator>;
    /**
     * Asks every question about each state, one request per state, at most
     * `concurrency` in flight. Results keep the states' order and a failed
     * state never hides its neighbours.
     */
    readonly evaluateAll: (states: ReadonlyArray<State["Type"]>, options?: EvaluateAllOptions) => Effect.Effect<ReadonlyArray<Result.Result<AnswersOf<Qs>, ClassifierError>>, never, Evaluator.Evaluator>;
}
/**
 * Options for {@link make}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface MakeOptions<State extends Schema.Codec<any, any>, Qs extends Questions> {
    /** What the classifier judges, in one sentence; the catalog shows it. */
    readonly description: string;
    /** The state each question is asked about. It is encoded before it is sent. */
    readonly state: State;
    readonly questions: Qs;
    /**
     * How a generation seat asked to judge reads these questions' words, where
     * it reads them otherwise than Jev does; see `Evaluator.Request.seatNote`.
     * It is no part of the questions: the digest does not cover it.
     */
    readonly seatNote?: string | undefined;
}
/**
 * The classifier failure an evaluator failure is: the same code, status,
 * and message. `@smthrs/std`'s `classify` flow maps its calls with it too.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const fromEvaluatorError: (error: Evaluator.EvaluatorError) => ClassifierError;
/**
 * Declares a classifier. The digest is computed here, once, from the id and
 * an immutable snapshot of the questions, including their criteria. Caller
 * mutation cannot change the questions evaluated under that digest.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const make: <const Id extends string, State extends Schema.Codec<any, any>, const Qs extends Questions>(id: Id, options: MakeOptions<State, Qs>) => Classifier<Id, State, Qs>;
export {};
