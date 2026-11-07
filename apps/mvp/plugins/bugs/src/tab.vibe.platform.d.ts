import { Host } from "@smthrs/plugin";
import { Effect } from "effect";
/** One failure a report carries: the flow and its code. */
export interface Failure {
    readonly flow: string;
    readonly code: string;
}
/** Something that went wrong in the reporter's tab: when, what kind, its record's name, its code and its trace. */
export interface ErrorItem {
    readonly at: string;
    readonly kind: "log" | "http" | "page";
    readonly name: string;
    readonly code: string | null;
    readonly traceId: string | null;
}
/** One report, as `core/bug-reports` has it: the row, and GitHub's prefilled new-issue form for it. */
export interface Report {
    readonly id: string;
    readonly reporterLogin: string | null;
    readonly reporterRole: string | null;
    readonly actedBy: string | null;
    readonly what: string;
    readonly route: string | null;
    readonly repo: string | null;
    readonly build: string;
    readonly traces: ReadonlyArray<string>;
    readonly runs: ReadonlyArray<string>;
    readonly failures: ReadonlyArray<Failure>;
    readonly errors: ReadonlyArray<ErrorItem>;
    readonly browser: string;
    readonly viewport: string;
    readonly createdAt: string;
    readonly github: string;
}
/**
 * Where the form's last Send stands: nothing sent yet; on its way, with its id and words; Sent, with its report; or
 * not sent, with its id, words and the failure's code, so Retry sends the same report again.
 */
export type Sending = {
    readonly status: "idle";
} | {
    readonly status: "invalid";
    readonly what: string;
    readonly code: "empty" | "too_large";
} | {
    readonly status: "sending";
    readonly id: string;
    readonly what: string;
} | {
    readonly status: "sent";
    readonly report: Report;
} | {
    readonly status: "failed";
    readonly id: string;
    readonly what: string;
    readonly code: string;
};
/** The form's view, whose `send` event files a report. */
export declare const FORM = "bugs/report";
/** The longest report the form sends, as the manifest's `Report` allows. */
export declare const MAX_WHAT = 4000;
/** What a person's words become: trimmed at the ends; nothing to send when only spaces, or too long. */
export declare const whatOf: (text: string) => string | undefined;
/** Where the last Send stands once `rows` arrived: Sent when its report is among them. */
export declare const settle: (sending: Sending, rows: ReadonlyArray<Report>) => Sending;
/**
 * The id a Send of `what` files under: the failed report's again when its words are unchanged, so Retry never files a
 * second copy; a new one otherwise.
 */
export declare const idFor: (sending: Sending, what: string, fresh: () => string) => string;
/** One value, live: what it is now, and a way to hear it changed. */
export interface Watched<A> {
    readonly current: () => A;
    readonly subscribe: (listener: () => void) => () => void;
}
/** What the bug plugin's components read and do. */
export interface BugsTab {
    readonly queries: {
        readonly reports: Host.Live<Report>;
        readonly sending: Watched<Sending>;
    };
    readonly actions: {
        /** Files a report of `text`, or a failed one again; nothing when it is empty, too long, or one is on its way. */
        readonly send: (text: string) => void;
        /** Opens the form. */
        readonly report: () => void;
    };
}
/** The tab: built by the host in the plugin's scope on first use. */
export declare const tab: Effect.Effect<{
    queries: {
        reports: Host.Live<Report>;
        sending: {
            current: () => Sending;
            subscribe: (listener: () => void) => () => undefined;
        };
    };
    actions: {
        send: (text: string) => void;
        report: () => undefined;
    };
}, Host.PluginRefused, Host.PluginHost | import("effect/Scope").Scope>;
