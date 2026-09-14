/**
 * plue's failure taxonomy, vendored as types.
 *
 * GENERATED FILE — do not edit. Regenerate with:
 *
 *   node packages/rpc/scripts/refresh-failure-codes.mjs --from <plue checkout or deployment>
 *
 * Source: plue docs/failure-codes.json, rendered by its cmd/failurecodes and
 * served at GET /api/meta/failure-codes. WHICH revision is the digest below,
 * not a path — a local checkout's location is not provenance, and putting one
 * here would rewrite this file on every machine that regenerated it.
 *
 * plue's closed failure taxonomy (pkg/errors/registry.go), vendored so the
 * codes are TYPES here and not strings. Everything downstream — the fault a
 * refusal carries, the copy the app puts in front of it, whether the app may
 * retry on its own — is derived from this table, so a code plue adds and this
 * file has not picked up is a compile error at the table below, never a
 * refusal the user is shown with no verdict on it.
 *
 * @since 1.0.0
 */

/**
 * The document schema version plue stamps; a bump means the shape changed, not just the rows.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURE_SCHEMA_VERSION = 1

/**
 * plue's digest over the code rows. The drift test recomputes it from the
 * vendored JSON, so this constant and that file cannot disagree silently.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURE_DIGEST = "sha256:634f265e0847fbbd573a3ada67f237f155556a943fec7268bbccabda51da8722"

/**
 * Whose problem a failure is — plue's own word, and the only question the app
 * actually needs answered to know what to say.
 *
 * - `user` the request has to change; retrying it unchanged fails the same way.
 * - `wait` nothing is wrong, it is not ready yet, and the server said how long.
 * - `infra` Smithers' own fleet failed the caller. Not their fault.
 * - `dependency` something Smithers depends on failed or throttled us.
 * - `bug` Smithers is defective here.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAULTS = ["user", "wait", "infra", "dependency", "bug"] as const

/**
 * Whose problem a failure is.
 *
 * @since 1.0.0
 * @category models
 */
export type PlueFault = (typeof PLUE_FAULTS)[number]

/**
 * Every code plue may put on the wire, in the artifact's own sorted order.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURE_CODES = [
  "FORBIDDEN_ACTION",
  "NOT_ON_WAITLIST",
  "access_denied",
  "access_not_granted",
  "authentication_not_configured",
  "bad_gateway",
  "bad_request",
  "branch_lock_held",
  "build_cache_busy",
  "coding_guest_failure",
  "coding_host_unavailable",
  "coding_invalid_request",
  "coding_outcome_unknown",
  "coding_provenance_pending",
  "coding_reporter_upgrade_required",
  "coding_unsupported_jj",
  "coding_workspace_busy",
  "conflict",
  "desktop_act_repeated",
  "desktop_busy",
  "desktop_input_out_of_bounds",
  "desktop_not_ready",
  "desktop_not_running",
  "desktop_tools_unavailable",
  "egress_proxy_unavailable",
  "environment_image_unavailable",
  "exec_in_progress",
  "feature_not_enabled",
  "focus_terminal",
  "forbidden",
  "frame_changed",
  "gateway_timeout",
  "generation_required",
  "github_import_already_active",
  "github_import_too_large",
  "github_pull_diff_too_large",
  "github_rate_limited",
  "github_reconnect_required",
  "github_unavailable",
  "guest_not_ready",
  "guest_user_required",
  "host_lease_lost",
  "idempotency_conflict",
  "idempotency_key_required",
  "image_required",
  "internal",
  "internal_error",
  "invalid_egress_audit_batch",
  "invalid_json",
  "invalid_path",
  "invalid_placement",
  "invalid_request",
  "invalid_resource_link",
  "invalid_worker",
  "landing_blocked",
  "language_server_missing",
  "listing_secret_detected",
  "no_capacity",
  "non_replayable_operation",
  "not_found",
  "not_implemented",
  "operation_in_progress",
  "peer_identity_denied",
  "preview_unavailable",
  "provisioning_failed",
  "quiesce_failed",
  "quota_exceeded",
  "rate_limit_exceeded",
  "rate_limiter_unavailable",
  "repository_provisioning_rollout",
  "request_entity_too_large",
  "request_too_large",
  "retained_runtime_not_found",
  "retained_runtime_not_running",
  "retained_runtime_not_stopped",
  "runtime_error",
  "secret_delivery_unavailable",
  "service_unavailable",
  "snapshot_in_use",
  "snapshot_not_found",
  "snapshot_too_large",
  "sse_unavailable",
  "stale_generation",
  "token_generation_failed",
  "unauthorized",
  "unprocessable_entity",
  "unsupported_media_type",
  "validation_failed",
  "wiki_unavailable",
  "worker_draining",
  "worker_error",
  "worker_fenced",
  "worker_identity_conflict",
  "worker_identity_denied",
  "worker_identity_expired",
  "worker_identity_invalid",
  "worker_identity_stale",
  "worker_registration_conflict",
  "workspace_session_kind_mismatch",
  "workspace_session_pending",
  "workspace_source_invalid_ack",
  "workspace_source_missing",
  "workspace_source_unavailable"
] as const

/**
 * One of plue's failure codes.
 *
 * @since 1.0.0
 * @category models
 */
export type PlueFailureCode = (typeof PLUE_FAILURE_CODES)[number]

/**
 * One row: the verdict, the status plue answers with, and the pacing it states (0 = none).
 *
 * @since 1.0.0
 * @category models
 */
export interface PlueFailureEntry {
  readonly fault: PlueFault
  readonly status: number
  readonly retryAfter: number
}

/**
 * The registry itself. `satisfies Record<PlueFailureCode, PlueFailureEntry>`
 * is the exhaustiveness gate: a code in the union with no row here, or a row
 * here for a code not in the union, does not compile.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURES = {
  /** The GitHub proxy refuses this action for the caller's grant. Legacy SCREAMING_CASE spelling kept for the clients that already branch on it. */
  "FORBIDDEN_ACTION": { fault: "user", status: 403, retryAfter: 0 },
  /** The signed-in account is not on the alpha waitlist yet. Legacy SCREAMING_CASE spelling; the OAuth callback matches it to redirect to the waitlist page. */
  "NOT_ON_WAITLIST": { fault: "user", status: 403, retryAfter: 0 },
  /** The access grant presented to the controller does not cover this sandbox. */
  "access_denied": { fault: "user", status: 403, retryAfter: 0 },
  /** The OAuth2 authorization was not granted to this client. */
  "access_not_granted": { fault: "user", status: 403, retryAfter: 0 },
  /** The controller has no authentication material configured, so it refuses every authenticated call. */
  "authentication_not_configured": { fault: "infra", status: 503, retryAfter: 0 },
  /** An upstream service plue depends on answered in a way plue could not use. */
  "bad_gateway": { fault: "dependency", status: 502, retryAfter: 0 },
  /** The request was malformed or carried a value the endpoint cannot accept. */
  "bad_request": { fault: "user", status: 400, retryAfter: 0 },
  /** Another person or agent holds the branch lock; details carry the holder and whether the caller may ask to join. */
  "branch_lock_held": { fault: "user", status: 409, retryAfter: 0 },
  /** The build cache is at its own concurrency ceiling; the caller is inside its budget and the identical request works once a slot frees. */
  "build_cache_busy": { fault: "wait", status: 429, retryAfter: 1 },
  /** The guest's coding helper failed. The guest's own sentence is logged server-side, never returned. */
  "coding_guest_failure": { fault: "bug", status: 503, retryAfter: 0 },
  /** The repository's configured coding host has not registered its native capability. */
  "coding_host_unavailable": { fault: "user", status: 409, retryAfter: 0 },
  /** The guest refused the coding request as malformed. */
  "coding_invalid_request": { fault: "user", status: 400, retryAfter: 0 },
  /** The transport to the box was interrupted before its receipt came back; the identical request recovers it. */
  "coding_outcome_unknown": { fault: "wait", status: 503, retryAfter: 1 },
  /** The mutation is saved in the box but its provenance projection has not landed; the identical request finishes it. */
  "coding_provenance_pending": { fault: "wait", status: 503, retryAfter: 1 },
  /** The box's reporter is older than the operation requires; it upgrades on the next boot. */
  "coding_reporter_upgrade_required": { fault: "infra", status: 503, retryAfter: 0 },
  /** The box's jj is too old for the requested operation. */
  "coding_unsupported_jj": { fault: "infra", status: 503, retryAfter: 0 },
  /** Another coding operation holds the box's reporter lock. */
  "coding_workspace_busy": { fault: "wait", status: 503, retryAfter: 1 },
  /** The resource is in a state that refuses this operation right now. */
  "conflict": { fault: "user", status: 409, retryAfter: 0 },
  /** This act_id already ran on this box; the guest replayed its verdict instead of acting twice. */
  "desktop_act_repeated": { fault: "user", status: 409, retryAfter: 0 },
  /** Another action holds this box's desktop lock. Nothing was injected; retry once the other action returns. */
  "desktop_busy": { fault: "wait", status: 409, retryAfter: 1 },
  /** A positioned action fell outside the live framebuffer. Earlier actions in the same plan may already have run. */
  "desktop_input_out_of_bounds": { fault: "user", status: 422, retryAfter: 0 },
  /** The box is up but its desktop helpers have not finished linking; the same request works seconds later. */
  "desktop_not_ready": { fault: "wait", status: 503, retryAfter: 2 },
  /** The box is suspended, failed, or has no VM. Observe and input never auto-resume: the caller asks for a resume first. */
  "desktop_not_running": { fault: "user", status: 409, retryAfter: 0 },
  /** The box booted from an image older than the one shipping the desktop helpers. It is terminal for that box, and it is plue's rollout lag rather than anything the caller did. */
  "desktop_tools_unavailable": { fault: "infra", status: 409, retryAfter: 0 },
  /** The box's egress proxy is not answering, so the box would have had no outbound network. */
  "egress_proxy_unavailable": { fault: "infra", status: 503, retryAfter: 0 },
  /** No NixOS environment image is registered for this workspace kind on this deployment, so no box of that kind can boot until plue builds and registers one. */
  "environment_image_unavailable": { fault: "infra", status: 409, retryAfter: 0 },
  /** An exec is already running in this sandbox and the endpoint serializes them. */
  "exec_in_progress": { fault: "user", status: 409, retryAfter: 0 },
  /** The endpoint's storage is not provisioned on this deployment, so the feature is switched off here. Retrying does not help until the deployment is migrated. */
  "feature_not_enabled": { fault: "infra", status: 503, retryAfter: 0 },
  /** The focused window is a terminal and the caller did not set allow_terminal, so the keystroke was refused. */
  "focus_terminal": { fault: "user", status: 409, retryAfter: 0 },
  /** The credential is valid but is not allowed to perform this operation. */
  "forbidden": { fault: "user", status: 403, retryAfter: 0 },
  /** The framebuffer geometry moved between the observation the plan was aimed at and the injection. Nothing was injected. */
  "frame_changed": { fault: "user", status: 409, retryAfter: 0 },
  /** plue gave up waiting for an upstream call it made on the caller's behalf. */
  "gateway_timeout": { fault: "bug", status: 504, retryAfter: 0 },
  /** The worker request omitted the placement generation that fences it. */
  "generation_required": { fault: "user", status: 400, retryAfter: 0 },
  /** An import for this repository is already running. */
  "github_import_already_active": { fault: "user", status: 409, retryAfter: 0 },
  /** The GitHub repository is larger than plue's import limit. It is refused before the clone, so nothing was written. */
  "github_import_too_large": { fault: "user", status: 413, retryAfter: 0 },
  /** GitHub's diff for this pull request is larger than plue will buffer. */
  "github_pull_diff_too_large": { fault: "dependency", status: 502, retryAfter: 0 },
  /** GitHub rate-limited the call plue made on the caller's behalf. */
  "github_rate_limited": { fault: "dependency", status: 429, retryAfter: 0 },
  /** The GitHub grant is dead in a way no server-side refresh can repair; the person has to re-authorize the GitHub App. */
  "github_reconnect_required": { fault: "user", status: 401, retryAfter: 0 },
  /** plue could not complete a call it made to GitHub on the caller's behalf: the request failed, or GitHub answered with something plue could not read. */
  "github_unavailable": { fault: "dependency", status: 502, retryAfter: 0 },
  /** The guest is reachable but activation has not finished exposing its login shell. */
  "guest_not_ready": { fault: "wait", status: 503, retryAfter: 3 },
  /** The exec request did not name the guest user to run as. */
  "guest_user_required": { fault: "user", status: 400, retryAfter: 0 },
  /** The controller's lease on a sandbox host has expired, so the host is no longer the controller's to act on. */
  "host_lease_lost": { fault: "infra", status: 503, retryAfter: 0 },
  /** The idempotency key was reused with a different request body. */
  "idempotency_conflict": { fault: "user", status: 409, retryAfter: 0 },
  /** The operation requires an idempotency key and the request carried none. */
  "idempotency_key_required": { fault: "user", status: 400, retryAfter: 0 },
  /** The sandbox create request named neither an image nor a snapshot. */
  "image_required": { fault: "user", status: 400, retryAfter: 0 },
  /** plue failed in a way it does not have a name for. It is a defect, not a condition the caller can fix. */
  "internal": { fault: "bug", status: 500, retryAfter: 0 },
  /** A sandbox control operation failed in a way the controller does not have a name for. */
  "internal_error": { fault: "bug", status: 500, retryAfter: 0 },
  /** The egress audit batch is malformed or larger than the controller accepts. */
  "invalid_egress_audit_batch": { fault: "user", status: 400, retryAfter: 0 },
  /** The sandbox request body is not the JSON the endpoint expects. */
  "invalid_json": { fault: "user", status: 400, retryAfter: 0 },
  /** The guest file path is absent, relative, or escapes the sandbox root. */
  "invalid_path": { fault: "user", status: 400, retryAfter: 0 },
  /** The placement the controller handed the worker does not describe a runnable VM. */
  "invalid_placement": { fault: "user", status: 400, retryAfter: 0 },
  /** The sandbox request is missing a required field or carries an impossible combination. */
  "invalid_request": { fault: "user", status: 400, retryAfter: 0 },
  /** The resource link on the request does not name a resource this controller owns. */
  "invalid_resource_link": { fault: "user", status: 400, retryAfter: 0 },
  /** The worker identity on the request is not one the controller knows. */
  "invalid_worker": { fault: "user", status: 400, retryAfter: 0 },
  /** The landing request cannot proceed as asked; details name what is blocking it. */
  "landing_blocked": { fault: "user", status: 422, retryAfter: 0 },
  /** The box has no binary for the session's language. The message is the install line, verbatim. */
  "language_server_missing": { fault: "user", status: 409, retryAfter: 0 },
  /** The share listing contains something that scans as a credential; it was not published. */
  "listing_secret_detected": { fault: "user", status: 400, retryAfter: 0 },
  /** No worker in the pool has free CPU, memory or VM slots for the box, at placement or at resume. The box and its disk are untouched. */
  "no_capacity": { fault: "infra", status: 503, retryAfter: 30 },
  /** The recorded operation for this idempotency key cannot be replayed. */
  "non_replayable_operation": { fault: "user", status: 409, retryAfter: 0 },
  /** The addressed resource does not exist, or the caller may not see that it does. */
  "not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** The route exists but its implementation does not. */
  "not_implemented": { fault: "bug", status: 501, retryAfter: 0 },
  /** Another operation on this sandbox is still running; the same request works once it settles. */
  "operation_in_progress": { fault: "wait", status: 409, retryAfter: 1 },
  /** The calling peer's mTLS identity is not one this worker accepts. */
  "peer_identity_denied": { fault: "user", status: 403, retryAfter: 0 },
  /** The preview gateway could not reach the port the box is serving. */
  "preview_unavailable": { fault: "infra", status: 503, retryAfter: 0 },
  /** Provisioning a box failed for a reason plue has no specific code for. Persisted on the workspace row as failure_code. */
  "provisioning_failed": { fault: "bug", status: 500, retryAfter: 0 },
  /** The worker could not quiesce the guest in time to take the action; retrying usually succeeds. */
  "quiesce_failed": { fault: "wait", status: 409, retryAfter: 1 },
  /** The account is at a per-resource cap, such as the number of boxes it may keep running. */
  "quota_exceeded": { fault: "user", status: 429, retryAfter: 0 },
  /** The caller sent more requests, or held more live connections, than the endpoint's budget allows. */
  "rate_limit_exceeded": { fault: "user", status: 429, retryAfter: 0 },
  /** plue's rate-limit store is not answering and the endpoint fails closed rather than let a budget go unenforced. */
  "rate_limiter_unavailable": { fault: "infra", status: 503, retryAfter: 1 },
  /** Repository provisioning is mid-rollout on this deployment and is not accepting new work. */
  "repository_provisioning_rollout": { fault: "infra", status: 503, retryAfter: 0 },
  /** The request body is larger than the endpoint accepts. */
  "request_entity_too_large": { fault: "user", status: 413, retryAfter: 0 },
  /** The sandbox request body exceeds the controller's limit. */
  "request_too_large": { fault: "user", status: 413, retryAfter: 0 },
  /** The worker holds no retained runtime under that id. */
  "retained_runtime_not_found": { fault: "user", status: 409, retryAfter: 0 },
  /** The retained runtime exists but is not running, and the operation needs it running. */
  "retained_runtime_not_running": { fault: "user", status: 409, retryAfter: 0 },
  /** The retained runtime is still running, and the operation needs it stopped. */
  "retained_runtime_not_stopped": { fault: "user", status: 409, retryAfter: 0 },
  /** The worker's runtime driver failed: a VMM, a snapshot restore, or a guest transport on one machine. Another worker may well succeed. */
  "runtime_error": { fault: "infra", status: 500, retryAfter: 0 },
  /** This worker build cannot deliver secrets into a guest. */
  "secret_delivery_unavailable": { fault: "infra", status: 501, retryAfter: 0 },
  /** plue is up but a component it needs is not answering. */
  "service_unavailable": { fault: "infra", status: 503, retryAfter: 0 },
  /** The snapshot backs a live sandbox and cannot be changed or deleted. */
  "snapshot_in_use": { fault: "user", status: 409, retryAfter: 0 },
  /** The named sandbox snapshot does not exist. Distinct from not_found so a bad golden snapshot is diagnosable. */
  "snapshot_not_found": { fault: "user", status: 404, retryAfter: 0 },
  /** The snapshot upload exceeds the worker's limit. */
  "snapshot_too_large": { fault: "user", status: 413, retryAfter: 0 },
  /** plue's event-stream tier could not open the stream: the LISTEN backing it failed, or the broker refused the subscription. The stream was never established. */
  "sse_unavailable": { fault: "infra", status: 503, retryAfter: 1 },
  /** The request carries an older placement generation than the one the worker holds; another actor moved the VM. */
  "stale_generation": { fault: "user", status: 409, retryAfter: 0 },
  /** The controller could not mint the token the operation needs. */
  "token_generation_failed": { fault: "bug", status: 500, retryAfter: 0 },
  /** The request carried no credential, or one the server could not verify. */
  "unauthorized": { fault: "user", status: 401, retryAfter: 0 },
  /** The request parsed but its meaning cannot be acted on. */
  "unprocessable_entity": { fault: "user", status: 422, retryAfter: 0 },
  /** The request's Content-Type is not one this endpoint reads. */
  "unsupported_media_type": { fault: "user", status: 415, retryAfter: 0 },
  /** One or more fields failed validation; the errors array names each one. */
  "validation_failed": { fault: "user", status: 422, retryAfter: 0 },
  /** The wiki's collaboration backend is not answering. */
  "wiki_unavailable": { fault: "infra", status: 503, retryAfter: 1 },
  /** The worker is draining and takes no new placements. */
  "worker_draining": { fault: "infra", status: 503, retryAfter: 0 },
  /** A Microsandbox worker failed an operation and the controller has no more specific code for it. */
  "worker_error": { fault: "infra", status: 502, retryAfter: 0 },
  /** The request targets a different worker than the one holding the placement, or the worker lost its controller authorization. */
  "worker_fenced": { fault: "user", status: 409, retryAfter: 0 },
  /** Two workers claim the same id with different identity keys. */
  "worker_identity_conflict": { fault: "user", status: 403, retryAfter: 0 },
  /** The worker's identity key is not the one the controller registered. */
  "worker_identity_denied": { fault: "user", status: 403, retryAfter: 0 },
  /** The worker's identity assertion is past its validity window. */
  "worker_identity_expired": { fault: "user", status: 403, retryAfter: 0 },
  /** The worker heartbeat's identity key is malformed. */
  "worker_identity_invalid": { fault: "user", status: 403, retryAfter: 0 },
  /** The worker heartbeat's identity was superseded by a newer registration. */
  "worker_identity_stale": { fault: "user", status: 403, retryAfter: 0 },
  /** The worker's registration conflicts with a live one under the same id. */
  "worker_registration_conflict": { fault: "user", status: 403, retryAfter: 0 },
  /** A session of one kind was opened on the other kind's stream route. */
  "workspace_session_kind_mismatch": { fault: "user", status: 409, retryAfter: 0 },
  /** The session row exists but its box is still provisioning; the same open succeeds once it is running. */
  "workspace_session_pending": { fault: "wait", status: 425, retryAfter: 2 },
  /** The box acknowledged a different revision than the one requested. */
  "workspace_source_invalid_ack": { fault: "infra", status: 503, retryAfter: 0 },
  /** The original source is not retained in this box. */
  "workspace_source_missing": { fault: "user", status: 404, retryAfter: 0 },
  /** plue could not verify the box's native source. */
  "workspace_source_unavailable": { fault: "infra", status: 503, retryAfter: 0 }
} satisfies Record<PlueFailureCode, PlueFailureEntry>
