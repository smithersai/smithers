/**
 * The deadline every host callback shares.
 *
 * @since 1.0.0-rc.1
 */

/**
 * How long one host callback attempt may go unanswered.
 *
 * A hosted guest reaches its journal through the sandbox's egress proxy, and
 * nothing below this host bounds that call: `fetch` has no default deadline.
 * Production turn 2d851bdd attempted its first commit 1 ms after its first
 * provider event, and the guest's own records show that one attempt still
 * `pending` half an hour later with no socket for it in the guest's table at
 * all; turn 7e5fc00f spent 1 h 19 m there and committed nothing. An unanswered
 * callback is a transport fault whatever its cause, and a fault has to end the
 * attempt — an unbounded one spends the person's whole turn in silence and
 * produces neither output nor a receipt.
 *
 * A healthy callback is a loopback-shaped round trip: the fastest production
 * turns commit 300–500 batches in 30–60 s, and provider-start answered in
 * 424 ms under the worst conditions this investigation saw. 15 s is therefore
 * two orders of magnitude of headroom, and a journal attempt that exceeds it
 * is retried once on a new request before the turn fails.
 *
 * The same bound covers every other callback a turn waits on: the shared
 * conversation context a chat turn resolves before inference, and the source
 * and API callbacks its host-owned commands make. Each one ends, request and
 * body together, with a refusal the turn can answer.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export const CHAT_CALLBACK_DEADLINE_MS = 15_000
