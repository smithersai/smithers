import { type Model } from "../../../src/models.ts";
/** Credit refusal codes; timing and scope determine whether they are terminal. */
export declare const refusals: ReadonlySet<string>;
/** Whether `error` permanently refused for lack of credit, rather than a timed window. */
export declare const exhausted: (error: unknown) => boolean;
/** The scope of a normalized credit refusal. */
export declare const scopeOf: (error: unknown) => "model" | "account";
/** `↪ GPT-6.1 Sol has no credit · using Qwen 3.8`: the one line a worker shows when it runs elsewhere. */
export declare const notice: (from: string, to: string, models?: ReadonlyArray<Model>) => string;
export interface Ledger {
    /** Records a terminal credit refusal for a model or account. */
    readonly spend: (seat: string, scope?: "model" | "account") => void;
    /** Records that `seat` answered. */
    readonly answered: (seat: string) => void;
    /** Whether `seat` is covered by a terminal credit refusal this session. */
    readonly spent: (seat: string) => boolean;
    /** The account `seat` runs on (`openai`, `anthropic`, `claude-code`): what a failure names. */
    readonly account: (seat: string) => string;
    /**
     * The seat to run once in place of `seat` when its account has no credit:
     * the latest seat that answered, else `chat`, on an account that has not
     * refused. `Seat.auto` has none only when every routed model's account
     * refused. Undefined when `seat` has credit or nothing known works.
     */
    readonly instead: (seat: string, chat: string) => {
        readonly from: string;
        readonly to: string;
    } | undefined;
    /** `↪ GPT-6.1 Sol has no credit · using Qwen 3.8`. */
    readonly notice: (from: string, to: string) => string;
}
/**
 * A session's ledger over the `models` this machine offers. `routed` are the
 * seats an `auto` worker routes over, in the router's order.
 */
export declare const make: (models: ReadonlyArray<Model>, routed?: ReadonlyArray<string>) => Ledger;
