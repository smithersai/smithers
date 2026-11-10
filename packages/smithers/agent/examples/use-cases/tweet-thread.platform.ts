/**
 * The platform code of tweet-thread.vibe, which a .vibe file does not use directly (EK4402): the `X_*`
 * environment, OAuth 1.0a signing with `node:crypto`, and the `fetch` that posts.
 */
import { createHmac, randomBytes } from "node:crypto"

const percent = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The four X API secrets one signed post needs. */
export interface Credentials {
  readonly apiKey: string
  readonly apiSecret: string
  readonly accessToken: string
  readonly accessSecret: string
}

/** The OAuth 1.0a `Authorization` header for a POST to `endpoint` with a JSON body. */
const authorization = (endpoint: string, credentials: Credentials): string => {
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0"
  }
  // A JSON body is not part of the signature base string; only the OAuth parameters are.
  const parameters = Object.entries(oauth).map(([k, v]) => `${percent(k)}=${percent(v)}`).sort().join("&")
  const base = ["POST", percent(endpoint), percent(parameters)].join("&")
  const key = `${percent(credentials.apiSecret)}&${percent(credentials.accessSecret)}`
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64")
  return `OAuth ${Object.entries(oauth).map(([k, v]) => `${percent(k)}="${percent(v)}"`).join(", ")}`
}

/**
 * The four `X_*` variables, read now.
 *
 * @throws {never}
 */
export const xEnvironment = () => ({
  apiKey: process.env.X_API_KEY,
  apiSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET
})

/** POSTs `body` as JSON to `endpoint`, signed with `credentials`, and answers the status and response text. */
export const postSigned = (endpoint: string, credentials: Credentials, body: unknown) =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: authorization(endpoint, credentials),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, ok: r.ok, text: await r.text() }))
