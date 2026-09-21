// Package credentialscan detects credential material in text that must be
// safe to persist or publish.
package credentialscan

import (
	"math"
	"regexp"
	"strings"
)

// The credential scan is deliberately a floor, not a vault: it catches the
// literals people actually paste by accident (provider-prefixed tokens, PEM
// blocks, bearer literals, JWTs, and high-entropy secret assignments). It is
// tuned to prefer a false positive over persisting or publishing a leaked key.

// CredentialFinding names credential-looking content found in text. Rule,
// Hint, and Line are safe to expose; the matched text is deliberately omitted.
type CredentialFinding struct {
	// Rule is the machine-readable id of the pattern that fired, e.g.
	// "github_token". Clients may branch on it.
	Rule string `json:"rule"`
	// Hint is a human sentence describing what was found, with no excerpt.
	Hint string `json:"hint"`
	// Line is the 1-indexed line that matched.
	Line int `json:"line"`
}

type credentialRule struct {
	rule    string
	hint    string
	pattern *regexp.Regexp
	// generic marks the heuristic `key = value` rule, whose capture group 1 is
	// put through the placeholder/entropy filters before it counts as a match.
	generic bool
}

var credentialRules = []credentialRule{
	{
		rule:    "pem_private_key",
		hint:    "a PEM private key block",
		pattern: regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`),
	},
	{
		rule:    "github_token",
		hint:    "a GitHub token",
		pattern: regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})`),
	},
	{
		rule:    "anthropic_api_key",
		hint:    "an Anthropic API key",
		pattern: regexp.MustCompile(`\bsk-ant-[A-Za-z0-9\-_]{16,}`),
	},
	{
		rule:    "openai_api_key",
		hint:    "an OpenAI API key",
		pattern: regexp.MustCompile(`\bsk-(?:proj-)?[A-Za-z0-9]{32,}`),
	},
	{
		rule:    "aws_access_key_id",
		hint:    "an AWS access key id",
		pattern: regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
	},
	{
		rule:    "slack_token",
		hint:    "a Slack token",
		pattern: regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9-]{10,}`),
	},
	{
		rule:    "google_api_key",
		hint:    "a Google API key",
		pattern: regexp.MustCompile(`\bAIza[0-9A-Za-z\-_]{35}`),
	},
	{
		rule:    "stripe_secret_key",
		hint:    "a Stripe secret key",
		pattern: regexp.MustCompile(`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`),
	},
	{
		rule:    "sendgrid_api_key",
		hint:    "a SendGrid API key",
		pattern: regexp.MustCompile(`\bSG\.[A-Za-z0-9\-_]{16,}\.[A-Za-z0-9\-_]{16,}`),
	},
	{
		rule:    "gitlab_token",
		hint:    "a GitLab token",
		pattern: regexp.MustCompile(`\bglpat-[A-Za-z0-9\-_]{16,}`),
	},
	{
		rule:    "npm_token",
		hint:    "an npm token",
		pattern: regexp.MustCompile(`\bnpm_[A-Za-z0-9]{30,}`),
	},
	{
		rule:    "notion_token",
		hint:    "a Notion integration token",
		pattern: regexp.MustCompile(`\b(?:secret_[A-Za-z0-9]{40,}|ntn_[A-Za-z0-9]{30,})`),
	},
	{
		rule: "smithers_token",
		hint: "a Smithers token",
		// Every minted Smithers token is the prefix plus a run of 32+ hex or
		// base64url characters; the API and CLI send it as `Authorization:
		// token <pat>`, which no other rule covers. The bare-alphanumeric
		// tail leaves snake_case identifiers (smithers_first_party_apps) and
		// the committed-by-design public build-cache read token
		// (smithers_cachero_<hex>, buildcache.ReadTokenPrefix) unmatched.
		pattern: regexp.MustCompile(`\bsmithers_(?:(?:oat_|ort_|oas_|agent_|gateway_|desk_)?[A-Za-z0-9]{32,}|sandbox_[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{16,})`),
	},
	{
		rule: "bearer_literal",
		hint: "a literal bearer token",
		// The character class excludes `$`, `{` and `<`, so the legitimate
		// `Authorization: Bearer ${TOKEN}` / `Bearer <your-token>` forms do
		// not match — only a pasted literal does.
		pattern: regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}`),
	},
	{
		rule:    "jwt",
		hint:    "a JSON Web Token",
		pattern: regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	},
	{
		rule: "credential_assignment",
		hint: "a credential-looking value assigned to a secret-named field",
		// The keyword may carry an env-style service prefix glued on with an
		// underscore or dash (DB_PASSWORD, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY):
		// the left boundary is start-of-line or a non-alphanumeric, not \b.
		// Alphanumeric glue (csrfmiddlewaretoken, 1password) still does not
		// match, so identifier suffixes stay out.
		pattern: regexp.MustCompile(`(?i)(?:^|[^A-Za-z0-9])(?:api[_-]?key|apikey|secret|secret[_-]?key|secret[_-]?access[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|token)\b["']?\s*[:=]\s*["']?([^"'\s,;}]{16,})`),
		generic: true,
	},
}

// placeholderPattern matches the value forms that mean "supply your own here"
// rather than "here is mine": env/template references, obvious dummies, and
// masked strings.
var placeholderPattern = regexp.MustCompile(`(?i)^(?:x{3,}|\*{3,}|\.{3,}|-{3,}|_{3,}|redacted|placeholder|changeme|change-me|none|null|nil|undefined|todo|tbd|omitted|sanitized|your[-_.].*|my[-_.].*|example[-_.].*|.*[-_.]example|dummy.*|fake.*|sample.*|test[-_]?(?:key|token|secret|password)?)$`)

// referencePattern matches dotted / kebab identifier paths — `connectors.
// github.token`, `smithers-cloud-secret-name` — which are pointers at a
// credential, not the credential.
var referencePattern = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9]*(?:[.\-/][A-Za-z0-9]+)+)$`)

// templateMarkers are interpolation and secret-manager forms that always mean
// "resolved elsewhere".
var templateMarkers = []string{
	"${", "{{", "%(", "<%", "process.env", "os.environ", "deno.env",
	"secrets.", "vault:", "sops:", "op://", "gcp-secret", "aws-secret",
	"env.", "$env", "getenv",
}

// minCredentialEntropy is the Shannon entropy (bits per character) a generic
// assignment value must clear before it is treated as a real credential.
// Random tokens sit above 4; English words and identifiers sit below 3.
const minCredentialEntropy = 3.2

// ScanForCredentialMaterial reports the first credential-looking match in
// text, or nil when the text looks clean. Scanning is line-oriented so the
// finding can name a line without ever quoting it.
func ScanForCredentialMaterial(text string) *CredentialFinding {
	for i, line := range strings.Split(text, "\n") {
		if line == "" {
			continue
		}
		for _, rule := range credentialRules {
			match := rule.pattern.FindStringSubmatch(line)
			if match == nil {
				continue
			}
			if rule.generic && !looksLikeSecretValue(match[1]) {
				continue
			}
			return &CredentialFinding{Rule: rule.rule, Hint: rule.hint, Line: i + 1}
		}
	}
	return nil
}

// looksLikeSecretValue decides whether the value side of a `secret: <value>`
// assignment is a real credential rather than a reference or a placeholder.
func looksLikeSecretValue(value string) bool {
	value = strings.Trim(value, `"'`+"` \t")
	if len(value) < 16 {
		return false
	}
	lower := strings.ToLower(value)
	for _, marker := range templateMarkers {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	switch value[0] {
	case '$', '{', '<', '%', '!', '&', '*':
		return false
	}
	if placeholderPattern.MatchString(value) || referencePattern.MatchString(value) {
		return false
	}
	return shannonEntropy(value) >= minCredentialEntropy
}

// shannonEntropy returns the per-character Shannon entropy of s in bits.
func shannonEntropy(s string) float64 {
	if s == "" {
		return 0
	}
	counts := make(map[rune]int, len(s))
	total := 0
	for _, r := range s {
		counts[r]++
		total++
	}
	entropy := 0.0
	for _, n := range counts {
		p := float64(n) / float64(total)
		entropy -= p * math.Log2(p)
	}
	return entropy
}
