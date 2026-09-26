package smitherscli

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/smithersai/incur"
)

// Bring-your-own subscriptions (RFD-003): connect a Claude or Codex account
// so agent runs authenticate through the egress proxy with a token the guest
// never sees. Connecting imports the vendor CLI's own stored login, or a
// pasted Claude setup token.

type providerConnectPayload struct {
	Provider        string     `json:"provider"`
	Kind            string     `json:"kind,omitempty"`
	Label           string     `json:"label,omitempty"`
	AccessToken     string     `json:"access_token"`
	RefreshToken    string     `json:"refresh_token,omitempty"`
	AccessExpiresAt *time.Time `json:"access_expires_at,omitempty"`
	AccountEmail    string     `json:"account_email,omitempty"`
	AccountID       string     `json:"account_id,omitempty"`
	Plan            string     `json:"plan,omitempty"`
}

// claudeLocalLogin reads the Claude Code CLI's stored subscription login: the
// macOS keychain item, or ~/.claude/.credentials.json elsewhere. configDir
// overrides the config directory (CLAUDE_CONFIG_DIR) for a registered
// smithers account.
func claudeLocalLogin(configDir string) (providerConnectPayload, error) {
	var raw []byte
	if configDir == "" {
		configDir = strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	}
	if configDir == "" {
		home, _ := os.UserHomeDir()
		configDir = filepath.Join(home, ".claude")
	}
	if data, err := os.ReadFile(filepath.Join(configDir, ".credentials.json")); err == nil {
		raw = data
	} else if runtime.GOOS == "darwin" {
		out, err := exec.Command("security", "find-generic-password", "-s", "Claude Code-credentials", "-w").Output()
		if err != nil {
			return providerConnectPayload{}, fmt.Errorf("no Claude Code login found: run `claude` and sign in with your subscription, or pass --setup-token")
		}
		raw = out
	} else {
		return providerConnectPayload{}, fmt.Errorf("no Claude Code login found at %s", filepath.Join(configDir, ".credentials.json"))
	}
	var doc struct {
		OAuth struct {
			AccessToken      string `json:"accessToken"`
			RefreshToken     string `json:"refreshToken"`
			ExpiresAt        int64  `json:"expiresAt"`
			SubscriptionType string `json:"subscriptionType"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.OAuth.AccessToken == "" {
		return providerConnectPayload{}, fmt.Errorf("the Claude Code login is not a subscription login")
	}
	payload := providerConnectPayload{Provider: "claude", Kind: "oauth", AccessToken: doc.OAuth.AccessToken, RefreshToken: doc.OAuth.RefreshToken, Plan: doc.OAuth.SubscriptionType}
	if doc.OAuth.ExpiresAt > 0 {
		t := time.UnixMilli(doc.OAuth.ExpiresAt).UTC()
		payload.AccessExpiresAt = &t
	}
	if data, err := os.ReadFile(filepath.Join(configDir, ".claude.json")); err == nil {
		var meta struct {
			OAuthAccount struct {
				EmailAddress string `json:"emailAddress"`
			} `json:"oauthAccount"`
		}
		if json.Unmarshal(data, &meta) == nil {
			payload.AccountEmail = meta.OAuthAccount.EmailAddress
		}
	}
	return payload, nil
}

// codexLocalLogin reads the Codex CLI's stored ChatGPT login from
// $CODEX_HOME/auth.json (default ~/.codex/auth.json).
func codexLocalLogin(codexHome string) (providerConnectPayload, error) {
	if codexHome == "" {
		codexHome = strings.TrimSpace(os.Getenv("CODEX_HOME"))
	}
	if codexHome == "" {
		home, _ := os.UserHomeDir()
		codexHome = filepath.Join(home, ".codex")
	}
	raw, err := os.ReadFile(filepath.Join(codexHome, "auth.json"))
	if err != nil {
		return providerConnectPayload{}, fmt.Errorf("no Codex login found at %s: run `codex login`", filepath.Join(codexHome, "auth.json"))
	}
	var doc struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			IDToken      string `json:"id_token"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Tokens.AccessToken == "" || doc.Tokens.RefreshToken == "" {
		return providerConnectPayload{}, fmt.Errorf("the Codex login at %s is not a ChatGPT subscription login", codexHome)
	}
	payload := providerConnectPayload{Provider: "codex", Kind: "oauth", AccessToken: doc.Tokens.AccessToken, RefreshToken: doc.Tokens.RefreshToken, AccountID: doc.Tokens.AccountID}
	if claims := jwtPayloadClaims(doc.Tokens.IDToken); claims != nil {
		payload.AccountEmail, _ = claims["email"].(string)
		if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
			payload.Plan, _ = auth["chatgpt_plan_type"].(string)
			if payload.AccountID == "" {
				payload.AccountID, _ = auth["chatgpt_account_id"].(string)
			}
		}
	}
	if claims := jwtPayloadClaims(doc.Tokens.AccessToken); claims != nil {
		if exp, ok := claims["exp"].(float64); ok && exp > 0 {
			t := time.Unix(int64(exp), 0).UTC()
			payload.AccessExpiresAt = &t
		}
	}
	return payload, nil
}

func jwtPayloadClaims(token string) map[string]any {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return nil
	}
	return claims
}

func providerConnectionsPath(org string) string {
	if org != "" {
		return fmt.Sprintf("/api/orgs/%s/provider-connections", org)
	}
	return "/api/user/provider-connections"
}

// providerConnectionsRequest calls the connections API and turns the feature
// gate's 403 into a plain statement: the hosted product never stores
// subscription logins, and a self-hosted server must opt in.
func providerConnectionsRequest(method, path string, body any) (any, error) {
	result, err := APIRequest(method, path, body, nil)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusForbidden && strings.Contains(apiErr.Detail, "feature not available") {
		return nil, fmt.Errorf("subscription connections are not available on this deployment; a self-hosted server enables them with SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS=true, for each user's own subscription only")
	}
	return result, err
}

func registerProviderConnectionCommands(cmd *incur.Cli) {
	cmd.Command("connect", &incur.CommandDef{
		Description: "Connect your own Claude or Codex subscription for your own agent runs on a self-hosted server (imports the vendor CLI's login, or a pasted Claude setup token)",
		ArgsSchema: objectSchema([]string{"provider"}, map[string]*incur.JSONSchema{
			"provider": stringSchema("claude or codex"),
		}),
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"setup-token": booleanSchema("Read a Claude setup token from stdin (`claude setup-token`) instead of importing the local login", false),
			"config-dir":  stringSchema("Claude config directory (CLAUDE_CONFIG_DIR) or Codex home (CODEX_HOME) to import from"),
			"label":       stringSchema("Display label for the connection"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			provider := strings.ToLower(strings.TrimSpace(stringValue(ctx.Args["provider"])))
			var (
				payload providerConnectPayload
				err     error
			)
			switch provider {
			case "claude":
				if ctx.Options["setup-token"] == true {
					fmt.Fprintln(os.Stderr, "Paste the Claude setup token from `claude setup-token`, then press Ctrl-D.")
					raw, readErr := readStdinText("Claude setup token", false)
					if readErr != nil {
						return nil, readErr
					}
					token, validateErr := validateClaudeSetupToken(raw)
					if validateErr != nil {
						return nil, validateErr
					}
					payload = providerConnectPayload{Provider: "claude", Kind: "setup_token", AccessToken: token}
				} else {
					payload, err = claudeLocalLogin(stringValue(ctx.Options["config-dir"]))
				}
			case "codex":
				payload, err = codexLocalLogin(stringValue(ctx.Options["config-dir"]))
			default:
				return nil, fmt.Errorf("provider must be claude or codex")
			}
			if err != nil {
				return nil, err
			}
			payload.Label = stringValue(ctx.Options["label"])
			result, err := providerConnectionsRequest("POST", providerConnectionsPath(""), payload)
			if err != nil {
				return nil, err
			}
			if payload.Kind == "oauth" {
				fmt.Fprintln(os.Stderr, "Connected. Smithers now refreshes this login; the provider revokes the copy on this machine at its next refresh, so keep this account dedicated to Smithers or sign in again here when prompted.")
			}
			return result, nil
		},
	})
	cmd.Command("connections", &incur.CommandDef{
		Description: "List connected subscriptions",
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"org": stringSchema("List an organization's connections"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			return providerConnectionsRequest("GET", providerConnectionsPath(stringValue(ctx.Options["org"])), nil)
		},
	})
	cmd.Command("revoke", &incur.CommandDef{
		Description: "Revoke a connected subscription",
		ArgsSchema: objectSchema([]string{"id"}, map[string]*incur.JSONSchema{
			"id": stringSchema("Connection id"),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			id := strings.TrimSpace(stringValue(ctx.Args["id"]))
			if id == "" {
				return nil, fmt.Errorf("connection id is required")
			}
			if _, err := providerConnectionsRequest("DELETE", "/api/user/provider-connections/"+id, nil); err != nil {
				return nil, err
			}
			return map[string]any{"status": "revoked", "id": id}, nil
		},
	})
}
