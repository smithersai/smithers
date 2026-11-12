/**
 * The credential shapes a recording must never hold, shared by
 * `HttpRecording` and `ContainerRecording`. It imports no Node module, so a
 * Worker that records can scan too.
 *
 * @since 1.0.0
 */

import { defaultRules } from "@smthrs/journal/Redaction"

// The journal's token-shaped rules, as RecordingModel uses them. Its name and
// assignment rules are applied by `redact` while scrubbing and are not part of
// the scan: a recorded field named `token` is already `[REDACTED]`.
const credentialRules = new Set([
  "private-key-block",
  "smithers-scoped-token",
  "smithers-machine-token",
  "url-credentials",
  "bearer-token",
  "jwt",
  "api-key",
  "github-token",
  "github-fine-grained-token",
  "aws-access-key",
  "slack-token",
  "google-api-key",
  "gitlab-token",
  "npm-token",
  "slack-webhook"
])
const credentialPatterns = defaultRules
  .filter((rule) => credentialRules.has(rule.id))
  .map((rule) => ({ id: rule.id, pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "")) }))

/**
 * The ids of the credential shapes found in `text`; empty when it holds none.
 *
 * @category scanning
 * @since 1.0.0
 */
export const scan = (text: string): ReadonlyArray<string> =>
  credentialPatterns.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id)
