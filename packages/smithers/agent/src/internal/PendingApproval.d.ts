/**
 * Find the approval a run is still waiting on from its control journal.
 * @since 1.0.0
 */
import type { JournalEvent } from "@smthrs/journal";
/**
 * The latest approval request in `entries` that no decision has answered,
 * with the question it asked.
 *
 * An unrequested round re-parks a run in a host that may never have parked
 * it, after the engine cleared the waiting row to activate the round. The
 * `control.approval.requested` fact is then the only durable record of the
 * wait's token and question, so this is what the re-park declares.
 *
 * @category utilities
 * @since 1.0.0
 * @throws {never}
 */
export declare const latestPendingApproval: (entries: Iterable<JournalEvent.Entry>) => {
    readonly requestId: string;
    readonly question: string;
} | undefined;
