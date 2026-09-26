package services

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// A hosted deployment never stores a user's Claude.ai or ChatGPT subscription login,
// whether as a provider connection or pasted into a secret or variable. The
// secret, variable and agent-environment writers refuse one unless the
// deployment sets feature_flags.subscription_connections (self-host only).

// subscriptionTokenNames only ever hold a subscription login.
var subscriptionTokenNames = map[string]struct{}{
	"CLAUDE_CODE_OAUTH_TOKEN":   {},
	"OPENAI_CODEX_ACCESS_TOKEN": {},
	"CODEX_AUTH_JSON":           {},
}

// isSubscriptionToken reports whether a name/value pair is a Claude or
// ChatGPT subscription credential: a Claude OAuth access or refresh token
// (sk-ant-oat / sk-ant-ort, whatever the name), a ChatGPT access token (a JWT
// carrying the chatgpt_account_id claim), a Codex auth.json, or a name that
// only ever holds one. API keys (sk-ant-api, sk-proj) are not.
func isSubscriptionToken(name, value string) bool {
	if _, ok := subscriptionTokenNames[strings.ToUpper(strings.TrimSpace(name))]; ok {
		return true
	}
	if strings.Contains(value, "sk-ant-oat") || strings.Contains(value, "sk-ant-ort") {
		return true
	}
	var auth struct {
		AuthMode string `json:"auth_mode"`
		Tokens   *struct {
			RefreshToken string `json:"refresh_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(value)), &auth) == nil && (auth.AuthMode == "chatgpt" || (auth.Tokens != nil && auth.Tokens.RefreshToken != "")) {
		return true
	}
	for _, field := range strings.FieldsFunc(value, func(r rune) bool { return strings.ContainsRune(" \t\r\n\"'=:,", r) }) {
		if isChatGPTAccessToken(field) {
			return true
		}
	}
	return false
}

func isChatGPTAccessToken(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return false
	}
	var claims struct {
		Auth struct {
			AccountID string `json:"chatgpt_account_id"`
		} `json:"https://api.openai.com/auth"`
	}
	return json.Unmarshal(raw, &claims) == nil && claims.Auth.AccountID != ""
}

// refuseSubscriptionToken is the write-path guard. The message starts with
// the feature gate's text so clients treat both refusals the same way.
func refuseSubscriptionToken(allowed bool, name, value string) error {
	if allowed || !isSubscriptionToken(name, value) {
		return nil
	}
	return pkgerrors.Forbidden("feature not available: this deployment does not store Claude or ChatGPT subscription tokens; use an API key")
}
