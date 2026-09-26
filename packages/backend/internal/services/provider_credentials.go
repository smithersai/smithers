package services

import (
	"strings"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// AgentProviderCredentialEnvNames are the AI-provider credential environment
// variables an agent or gateway VM may authenticate a model call with. The
// order is the preference order used when reporting which one is missing.
var AgentProviderCredentialEnvNames = []string{
	"CEREBRAS_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENAI_CODEX_ACCESS_TOKEN",
	"OPENROUTER_API_KEY",
	"GOOGLE_API_KEY",
}

// placeholderCredentialPrefixes are the operator-seeded stand-ins that
// Secret Manager holds until a real credential is provisioned (see the
// "intentionally operator-seeded placeholders" block in
// infra/helm/smithers/templates/external-secret.yaml). They are non-empty
// strings, so every "is it set?" check treats them as configured — which is
// exactly how production ended up injecting
// ANTHROPIC_API_KEY=placeholder-pending-h1-credential-seed into every agent VM.
// The VM`s model selector picks a provider by env-var PRESENCE, so the
// placeholder won selection, every model call came back
// 401 "invalid x-api-key", and the agent session sat active forever with no
// reply and no error.
var placeholderCredentialPrefixes = []string{
	"placeholder",
	"changeme",
	"change-me",
	"replace-me",
	"replaceme",
	"todo",
	"unset",
	"example",
}

// IsUsableProviderCredential reports whether a credential value is something a
// provider could plausibly accept. It rejects blanks, operator-seeded
// placeholders, and `<angle-bracket>` config templates.
func IsUsableProviderCredential(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, "<") && strings.HasSuffix(trimmed, ">") {
		return false
	}
	lower := strings.ToLower(trimmed)
	for _, prefix := range placeholderCredentialPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return false
		}
	}
	return true
}

// ProviderCredentialBinding is where the egress proxy may substitute a
// platform AI-provider credential: the provider's API host and the request
// locations its SDKs put the key in. Anything else the guest sends the
// placeholder to is forwarded unchanged, so a leaked placeholder is worthless.
type ProviderCredentialBinding struct {
	Hosts        []string
	MatchHeaders []string
	MatchQuery   bool
}

// providerCredentialBindings is keyed by AgentProviderCredentialEnvNames.
// Anthropic SDKs send x-api-key for API keys and Authorization: Bearer for
// OAuth tokens; OpenAI-compatible providers send Authorization: Bearer;
// Google's Generative Language API accepts x-goog-api-key or ?key=.
var providerCredentialBindings = map[string]ProviderCredentialBinding{
	"CEREBRAS_API_KEY":     {Hosts: []string{"api.cerebras.ai"}, MatchHeaders: []string{"authorization"}},
	"ANTHROPIC_API_KEY":    {Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"x-api-key", "authorization"}},
	"ANTHROPIC_AUTH_TOKEN": {Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"authorization"}},
	"OPENAI_API_KEY":       {Hosts: []string{"api.openai.com"}, MatchHeaders: []string{"authorization"}},
	// A ChatGPT subscription access token (Codex CLI in chatgpt mode) authenticates against chatgpt.com.
	"OPENAI_CODEX_ACCESS_TOKEN": {Hosts: []string{"chatgpt.com"}, MatchHeaders: []string{"authorization"}},
	"OPENROUTER_API_KEY":        {Hosts: []string{"openrouter.ai"}, MatchHeaders: []string{"authorization"}},
	"GOOGLE_API_KEY":            {Hosts: []string{"generativelanguage.googleapis.com"}, MatchHeaders: []string{"x-goog-api-key"}, MatchQuery: true},
}

// ProviderCredentialBindingFor returns the proxy binding for a platform
// provider credential name.
func ProviderCredentialBindingFor(name string) (ProviderCredentialBinding, bool) {
	binding, ok := providerCredentialBindings[strings.TrimSpace(name)]
	if !ok {
		return ProviderCredentialBinding{}, false
	}
	return ProviderCredentialBinding{
		Hosts:        append([]string(nil), binding.Hosts...),
		MatchHeaders: append([]string(nil), binding.MatchHeaders...),
		MatchQuery:   binding.MatchQuery,
	}, true
}

// ProviderCredentialEgressSecret turns a usable platform credential into a
// proxy-bound secret. ok is false for names without a known binding; those
// keep the legacy in-guest path so an unfamiliar provider never gets a
// placeholder the proxy would not swap.
func ProviderCredentialEgressSecret(name, value string) (sandbox.EgressProxySecret, bool) {
	binding, ok := ProviderCredentialBindingFor(name)
	if !ok || !IsUsableProviderCredential(value) {
		return sandbox.EgressProxySecret{}, false
	}
	return sandbox.EgressProxySecret{
		Name: strings.TrimSpace(name), Value: strings.TrimSpace(value),
		Hosts: binding.Hosts, MatchHeaders: binding.MatchHeaders, MatchQuery: binding.MatchQuery,
	}, true
}

// HasUsableProviderCredentialWithPlaceholders reports whether env carries at
// least one AI-provider credential a model call could authenticate with, for a
// proxy-backed guest: a provider credential whose env value is exactly
// its placeholder counts as usable when the name is in proxied, because the
// proxy holds the real value. A placeholder for a name that is NOT proxied is
// still refused, so the old "placeholder-pending" 401-forever failure cannot
// come back through this door.
func HasUsableProviderCredentialWithPlaceholders(env map[string]string, proxied map[string]struct{}) bool {
	for _, name := range AgentProviderCredentialEnvNames {
		value := env[name]
		if value == sandbox.EgressProxyPlaceholder(name) {
			// NAME=NAME is a credential only when the proxy holds the value;
			// on the legacy path it is exactly the 401-forever key this guard
			// exists to refuse.
			_, viaProxy := proxied[name]
			if viaProxy {
				return true
			}
			continue
		}
		if IsUsableProviderCredential(value) {
			return true
		}
	}
	return false
}
