/**
 * The fingerprint of a validated notification, computed before the journal
 * redacts its payload.
 *
 * `digestSync` declares `Sha256Error`, so the call stays in TypeScript: a
 * failure there is a defect of the queue, exactly as it was before the queue
 * moved to VibeLang.
 *
 * @private
 * @since 1.0.0
 */

import { canonicalize } from "@smthrs/canonical"
import { digestSync } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import type * as NotificationModel from "../Notification.vibe"

/**
 * Canonical JSON text of a notification. Persisted notification JSON predates
 * RFC 8785's rejection of lone surrogates.
 *
 * @throws {never}
 * @private
 * @since 1.0.0
 */
export const canonical = (value: unknown): string => canonicalize(value, { loneSurrogates: "escape" })

/**
 * Fingerprint the validated input before the journal redacts its payload.
 *
 * @private
 * @since 1.0.0
 */
export const fingerprint = (notification: NotificationModel.Notification): Effect.Effect<string> =>
  Effect.sync(() => digestSync(canonical(notification)))
