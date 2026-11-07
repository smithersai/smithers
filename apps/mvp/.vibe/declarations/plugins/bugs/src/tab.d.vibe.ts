export { FORM, MAX_WHAT, idFor, settle, tab, whatOf } from "../../../../../plugins/bugs/src/tab.vibe.platform.js";
export type { BugsTab, ErrorItem, Failure, Report, Sending, Watched } from "../../../../../plugins/bugs/src/tab.vibe.platform.js";
/** The inbox's view. */
export declare const INBOX = "bugs/inbox";
/** Why a report wasn't sent, in a few words, from its failure's code. */
export declare const reasonOf: (code: string) => string;
