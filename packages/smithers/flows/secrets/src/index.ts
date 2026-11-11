/**
 * `@smthrs/secrets`: secrets a sandbox or a flow step uses without holding
 * them.
 *
 * - `Placeholder`: the text a guest holds in place of a value, derived per
 *   scope with HMAC-SHA-256, and found in text.
 * - `Binding`: a secret's name, hosts and methods, and the checks a value
 *   passes before it is stored or put in a header.
 * - `Scrub`: replaces every echoed form of a value, as a body streams.
 * - `Egress`: swaps placeholders for values in request headers, only for a
 *   secret's own hosts and methods, sends the request without following
 *   redirects, records the decision, and scrubs the answer.
 *
 * ```ts
 * import { Binding, Egress, Placeholder, Scrub } from "@smthrs/secrets"
 * ```
 *
 * Nothing here imports a `node:` built-in or a host module: values come from
 * the host's `Egress.Vault`, decisions go to its `Egress.Audit`, and requests
 * leave through its `HttpClient`.
 *
 * @since 0.1.0
 */

/**
 * A secret's name, hosts and methods, and the value checks.
 *
 * @since 0.1.0
 */
export * as Binding from "./Binding.vibe"

/**
 * The egress: substitution, refusal, audit and scrubbing.
 *
 * @since 0.1.0
 */
export * as Egress from "./Egress.vibe"

/**
 * Placeholders: derived, recognized and found.
 *
 * @since 0.1.0
 */
export * as Placeholder from "./Placeholder.vibe"

/**
 * Scrubbing a value's echoes from text and streams.
 *
 * @since 0.1.0
 */
export * as Scrub from "./Scrub.vibe"
