import { Metric } from "effect";
/** Device draft writes by stage: waiting, stored or failed. */
export declare const draftWrites: Metric.Counter<number>;
/** Composer opens, by `via`: `shortcut` (⌘K or Ctrl+K) or `button`. */
export declare const composerOpens: Metric.Counter<number>;
/** Questions this tab asked, by `queued`: `true` when the pill showed, so the question waited in the outbox. */
export declare const questionsAsked: Metric.Counter<number>;
/**
 * Questions that stayed unsent, by `reason`: `refused` (400), `conflict` (409), `too_large` (413) or `not_admitted`
 * (the outbox couldn't store it).
 */
export declare const askFailures: Metric.Counter<number>;
/** What a person did with an unsent question, by `action`: `edit`, `discard` or `retry`. */
export declare const unsentActions: Metric.Counter<number>;
/** From asking to the first text of the answer reaching this tab, time queued included. */
export declare const firstAnswerText: Metric.Histogram<number>;
/**
 * Times the connection pill showed, by `reason`: `offline` (the browser), `unreachable` (shape requests or sends
 * failing for 10 s), `refused` (Electric refused the shape), `invalid_response` (an answer it couldn't read) or
 * `engine` (this tab's engine worker failed).
 */
export declare const connectionDrops: Metric.Counter<number>;
/** Times a person or the browser asked to sync and send now, by `via`: `button` (Retry) or `online`. */
export declare const syncRetries: Metric.Counter<number>;
/** "Load earlier" presses: the window grows on the device, at once. */
export declare const historyLoads: Metric.Counter<number>;
/** Whether the browser granted persistent storage at boot, by `granted`: `true` or `false`. */
export declare const storagePersisted: Metric.Counter<number>;
/**
 * Copies of a message to the clipboard (`chat/copy`), by `door` (`button`, `slash`, `agent`), `which` (`message` or
 * `latest`, the latest finished answer) and `outcome` (`COPY_OUTCOMES`).
 */
export declare const messageCopies: Metric.Counter<number>;
/** Questions taken back into the composer (`chat/edit`), by `door` and `outcome` (`EDIT_OUTCOMES`). */
export declare const questionEdits: Metric.Counter<number>;
