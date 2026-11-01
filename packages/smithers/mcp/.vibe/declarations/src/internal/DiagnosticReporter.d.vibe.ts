/**
 * Internal optional-observer capture. Every detail is redacted with
 * `Redaction.redactDiagnostic` and then wrapped in `Redacted`. Stderr is redacted by the
 * transport, one whole line at a time, before its byte cap.
 *
 * @since 1.0.0-rc.0
 */
import { Effect } from "effect";
import * as Diagnostics from "../Diagnostics.vibe";
/**
 * Captures the optional host observer without introducing a required service.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const make: (server: string) => Effect.Effect<(source: Diagnostics.Event["source"], detail: unknown) => void, never, never>;
