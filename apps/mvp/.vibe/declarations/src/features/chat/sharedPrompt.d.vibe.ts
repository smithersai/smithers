import { Context, type Effect } from "effect";
/** Where in the draft the person's selection is: where it started and where the caret is. */
export interface DraftSelection {
    readonly anchor: number;
    readonly head: number;
}
declare const SharedPrompt_base: Context.ServiceClass<SharedPrompt, "@smthrs/mvp/chat/SharedPrompt", {
    /** The person made the draft `draft`, from `base`, the draft the composer showed, with `selection` after. */
    readonly set: (draft: string, edit: {
        readonly base: string;
        readonly selection?: DraftSelection | undefined;
    }) => Effect.Effect<void>;
}>;
export declare class SharedPrompt extends SharedPrompt_base {
}
export {};
