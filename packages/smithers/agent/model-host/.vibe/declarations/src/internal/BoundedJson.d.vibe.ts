/** Bounded JSON transport shared by the host's routes.
 * @since 1.0.0
 */
import { Effect } from "effect";
import type { HttpIncomingMessage } from "effect/http";
/**
 * Reads at most MAX_BODY_BYTES of the body as JSON. The byte count is taken
 * while streaming, so a chunked body with no content-length stops being read
 * at the limit instead of being buffered whole. Anything else — a declared
 * length past the limit, an empty or unreadable body, invalid UTF-8 or JSON —
 * is `undefined`, never a failure.
 *
 * @private
 * @since 1.0.0
 */
export declare const boundedJson: <E>(message: HttpIncomingMessage.HttpIncomingMessage<E>) => Effect.Effect<unknown | undefined>;
