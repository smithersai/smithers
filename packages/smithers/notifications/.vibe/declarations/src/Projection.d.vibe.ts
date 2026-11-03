/**
 * Journal projection for pending notifications.
 *
 * @since 0.1.0
 */
import { Projection as JournalProjection } from "@smthrs/journal";
import * as NotificationState from "../../../src/NotificationState.ts";
/**
 * Re-derives pending notifications from admitted and promoted journal events.
 * Foreign journal entries leave the state unchanged.
 *
 * Replay never re-decides, so capacity does not truncate it:
 * `NotificationState.applyAdmission` applies the decision each record already
 * committed, and an admitted record is retained however many are pending. A
 * composition built with `NotificationQueue.layerWith` above the default
 * replays every admission it wrote. A versioned edit of a steer that is still
 * pending replaces that item in place, exactly as the queue's own fold reads
 * it, so an edited steer projects as one pending item rather than one per
 * version.
 *
 * The projected `capacity` is `NotificationState.defaultCapacity` because the
 * initial state has to start somewhere and no journal record carries the bound
 * the layer was built at. Read `items`, not `capacity`, to learn what a run
 * holds.
 *
 * @category projections
 * @since 0.1.0
 */
export declare const derive: JournalProjection.Projection<NotificationState.State, never, never>;
