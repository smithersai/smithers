/**
 * HTTP contracts for the tutorial's model egress: a closed set of provider
 * destinations the product Worker forwards to, keyed by name.
 *
 * The tutorial coordinator sends every model request, token refreshes
 * included, to `{TUTORIAL_PROVIDER_PROXY_PATH}/{destination}` with the service
 * token in {@link TUTORIAL_PROXY_TOKEN_HEADER}. The Worker checks the token,
 * looks the name up in {@link tutorialProviderDestinations}, and refuses any
 * other name, so a caller names a destination and never supplies a URL. The
 * ChatGPT subscription destinations reject Worker egress, so the Worker sends
 * those back to the coordinator's relay, which makes the final request.
 *
 * @since 1.0.0
 */

/**
 * The provider proxy route family on the product origin. The destination name
 * is the path segment after it, and only `POST` without a query string is
 * forwarded.
 *
 * @since 1.0.0
 * @category constants
 */
export const TUTORIAL_PROVIDER_PROXY_PATH = "/api/tutorial/provider"
/**
 * The header that carries the tutorial service token: on the coordinator's
 * request to the Worker, and on the Worker's request to the coordinator's
 * subscription relay. Both receivers compare it in constant time.
 *
 * @since 1.0.0
 * @category constants
 */
export const TUTORIAL_PROXY_TOKEN_HEADER = "x-smithers-proxy-token"
/**
 * The destinations the proxy forwards to, by name. Both sides read this table
 * as the allow-list: the coordinator rewrites a request only when its URL
 * equals an entry, and the Worker forwards only to a name it finds here. A new
 * entry opens a new egress route.
 *
 * @since 1.0.0
 * @category constants
 */
export const tutorialProviderDestinations = {
  chatgpt: "https://chatgpt.com/backend-api/codex/responses",
  refresh: "https://auth.openai.com/oauth/token",
  openai: "https://api.openai.com/v1/responses",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
} as const
