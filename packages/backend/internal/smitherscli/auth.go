package smitherscli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Seams so tests can exercise otherwise-unreachable defensive branches.
// json.MarshalIndent never fails for smithersAuthFileRecord.
var (
	authTargetResolver = ResolveAuthTarget
	authMarshalIndent  = json.MarshalIndent
)

type AuthTokenSource string

const (
	AuthTokenSourceEnv              AuthTokenSource = "env"
	AuthTokenSourceKeyring          AuthTokenSource = "keyring"
	AuthTokenSourceSmithersAuthFile AuthTokenSource = "smithers_auth_file"
	AuthTokenSourceConfig           AuthTokenSource = "config"
)

type AuthTarget struct {
	APIURL string `json:"api_url"`
	Host   string `json:"host"`
}

type ResolvedAuthToken struct {
	AuthTarget
	Source AuthTokenSource `json:"source"`
	Token  string          `json:"token"`
}

type AuthStatusResult struct {
	Admin       bool            `json:"admin"`
	TimeLeft    string          `json:"time_left,omitempty"`
	LoggedIn    bool            `json:"logged_in"`
	APIURL      string          `json:"api_url"`
	Host        string          `json:"host"`
	TokenSet    bool            `json:"token_set"`
	User        string          `json:"user,omitempty"`
	Username    string          `json:"username,omitempty"`
	Email       string          `json:"email,omitempty"`
	ExpiresAt   string          `json:"expires_at,omitempty"`
	TokenSource AuthTokenSource `json:"token_source,omitempty"`
	Message     string          `json:"message"`
}

type smithersAuthFileRecord struct {
	Admin     bool   `json:"admin,omitempty"`
	Token     string `json:"token,omitempty"`
	Host      string `json:"host,omitempty"`
	APIURL    string `json:"api_url,omitempty"`
	Username  string `json:"username,omitempty"`
	Email     string `json:"email,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type authTokenMetadata struct {
	Admin     bool
	Username  string
	Email     string
	ExpiresAt string
}

func isLoopbackHost(host string) bool {
	value := strings.TrimSpace(strings.ToLower(host))
	return strings.HasPrefix(value, "localhost") ||
		strings.HasPrefix(value, "127.") ||
		strings.HasPrefix(value, "[::1]") ||
		strings.HasPrefix(value, "::1")
}

func apiURLFromHostInput(hostnameOrAPIURL string) (string, error) {
	value := strings.TrimSpace(hostnameOrAPIURL)
	if value == "" {
		return "", errors.New("Hostname is required.")
	}
	if strings.HasPrefix(strings.ToLower(value), "http://") || strings.HasPrefix(strings.ToLower(value), "https://") {
		return normalizeAPIURL(value), nil
	}
	if isLoopbackHost(value) {
		return "http://" + value, nil
	}
	apiHost := value
	if !strings.HasPrefix(apiHost, "api.") {
		apiHost = "api." + hostFromURL(value)
	}
	return "https://" + apiHost, nil
}

func ResolveAuthTarget(options map[string]string) (AuthTarget, error) {
	if options == nil {
		options = map[string]string{}
	}
	if apiURL := strings.TrimSpace(options["apiUrl"]); apiURL != "" {
		normalized := normalizeAPIURL(apiURL)
		return AuthTarget{APIURL: normalized, Host: hostFromURL(normalized)}, nil
	}
	cfg, err := LoadConfig()
	if err != nil {
		return AuthTarget{}, err
	}
	configuredAPIURL := normalizeAPIURL(cfg.APIURL)
	configuredHost := hostFromURL(configuredAPIURL)

	hostname := strings.TrimSpace(options["hostname"])
	if hostname == "" {
		if configuredAPIURL == "" {
			return AuthTarget{}, errors.New("Smithers API origin is not configured. Set SMITHERS_API_ORIGIN or run `smithers config set api_origin ORIGIN`.")
		}
		return AuthTarget{APIURL: configuredAPIURL, Host: configuredHost}, nil
	}
	if strings.HasPrefix(strings.ToLower(hostname), "http://") || strings.HasPrefix(strings.ToLower(hostname), "https://") {
		apiURL := normalizeAPIURL(hostname)
		return AuthTarget{APIURL: apiURL, Host: hostFromURL(apiURL)}, nil
	}
	host := hostFromURL(hostname)
	if host == configuredHost {
		return AuthTarget{APIURL: configuredAPIURL, Host: host}, nil
	}
	// hostname is non-empty here, so apiURLFromHostInput never returns an error.
	apiURL, _ := apiURLFromHostInput(hostname)
	return AuthTarget{APIURL: apiURL, Host: host}, nil
}

func FormatTokenSource(source AuthTokenSource) string {
	switch source {
	case AuthTokenSourceEnv:
		return "SMITHERS_TOKEN env"
	case AuthTokenSourceKeyring:
		return "keyring"
	case AuthTokenSourceSmithersAuthFile:
		return "~/.config/smithers/auth.json"
	case AuthTokenSourceConfig:
		return "config file"
	default:
		return string(source)
	}
}

func smithersAuthFilePath() string {
	if override := strings.TrimSpace(os.Getenv("SMITHERS_AUTH_FILE")); override != "" {
		return override
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "smithers", "auth.json")
}

func readSmithersAuthFile() (*smithersAuthFileRecord, error) {
	path := smithersAuthFilePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, nil
	}
	var record smithersAuthFileRecord
	if err := json.Unmarshal(trimmed, &record); err != nil {
		return nil, err
	}
	return &record, nil
}

func writeSmithersAuthFile(target AuthTarget, token string, metadata authTokenMetadata) error {
	path := smithersAuthFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	record := smithersAuthFileRecord{
		Token:     token,
		Admin:     metadata.Admin,
		Host:      target.Host,
		APIURL:    target.APIURL,
		Username:  strings.TrimSpace(metadata.Username),
		Email:     strings.TrimSpace(metadata.Email),
		ExpiresAt: strings.TrimSpace(metadata.ExpiresAt),
		UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	raw, err := authMarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o600)
}

func clearSmithersAuthFile(targetHost string) bool {
	path := smithersAuthFilePath()
	record, err := readSmithersAuthFile()
	if err != nil || record == nil {
		return false
	}
	if record.Host != "" && record.Host != targetHost {
		return false
	}
	return os.Remove(path) == nil
}

func readSmithersAuthRecordForTarget(target AuthTarget) *smithersAuthFileRecord {
	record, err := readSmithersAuthFile()
	if err != nil || record == nil {
		return nil
	}
	if record.Host != "" && record.Host != target.Host {
		return nil
	}
	return record
}

// authRecordDescribes reports whether record's metadata belongs to resolved.
// A metadata-only record (written after a keychain save) describes the
// keychain token for its host.
func authRecordDescribes(record *smithersAuthFileRecord, resolved *ResolvedAuthToken) bool {
	if record == nil || resolved == nil {
		return false
	}
	if record.Token != "" {
		return record.Token == resolved.Token
	}
	return resolved.Source == AuthTokenSourceKeyring
}

func readSmithersAuthTokenForTarget(target AuthTarget) string {
	record := readSmithersAuthRecordForTarget(target)
	if record == nil {
		return ""
	}
	return strings.TrimSpace(record.Token)
}

func readLegacyTokenForTarget(target AuthTarget) string {
	raw, err := LoadRawConfig()
	if err != nil || hostFromURL(raw.APIURL) != target.Host {
		return ""
	}
	return strings.TrimSpace(raw.Token)
}

func scrubLegacyTokenIfCurrentHost(target AuthTarget) bool {
	raw, err := LoadRawConfig()
	if err != nil || strings.TrimSpace(raw.Token) == "" || hostFromURL(raw.APIURL) != target.Host {
		return false
	}
	cleared, err := ClearLegacyToken()
	return err == nil && cleared
}

func ResolveAuthToken(options map[string]string) (*ResolvedAuthToken, error) {
	target, err := authTargetResolver(options)
	if err != nil {
		return nil, err
	}
	if envToken := strings.TrimSpace(os.Getenv("SMITHERS_TOKEN")); envToken != "" {
		return &ResolvedAuthToken{AuthTarget: target, Source: AuthTokenSourceEnv, Token: envToken}, nil
	}
	stored, storageErr := LoadStoredToken(target.Host)
	if stored = strings.TrimSpace(stored); stored != "" {
		return &ResolvedAuthToken{AuthTarget: target, Source: AuthTokenSourceKeyring, Token: stored}, nil
	}
	if token := readSmithersAuthTokenForTarget(target); token != "" {
		return &ResolvedAuthToken{AuthTarget: target, Source: AuthTokenSourceSmithersAuthFile, Token: token}, nil
	}
	if token := readLegacyTokenForTarget(target); token != "" {
		return &ResolvedAuthToken{AuthTarget: target, Source: AuthTokenSourceConfig, Token: token}, nil
	}
	// No other source holds a token, so an unreadable keychain is the reason
	// the user looks logged out. Say so instead of asking them to log in.
	if storageErr != nil {
		return nil, fmt.Errorf("could not read the stored token for %s: %w", target.Host, storageErr)
	}
	return nil, nil
}

func RequireAuthToken(options map[string]string) (*ResolvedAuthToken, error) {
	resolved, err := ResolveAuthToken(options)
	if err != nil {
		return nil, err
	}
	if resolved != nil {
		return resolved, nil
	}
	target, err := authTargetResolver(options)
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("no token found for %s. Run `smithers auth login` or set SMITHERS_TOKEN.", target.Host)
}

func PersistAuthToken(token string, options map[string]string) (AuthTarget, error) {
	if options == nil {
		options = map[string]string{}
	}
	target, err := authTargetResolver(options)
	if err != nil {
		return AuthTarget{}, err
	}
	trimmed := strings.TrimSpace(token)
	// auth.json holds the token only when no secure store exists. After a
	// keychain save it holds metadata alone, so no plaintext copy is left.
	fileToken := ""
	if err := StoreToken(target.Host, trimmed); err != nil {
		var unavailable *SecureStorageUnavailableError
		if !errors.As(err, &unavailable) {
			return AuthTarget{}, err
		}
		fileToken = trimmed
		fmt.Fprintf(os.Stderr, "Secure credential storage is unavailable; storing the token in plaintext at %s (mode 0600).\n", smithersAuthFilePath())
	}
	if err := writeSmithersAuthFile(target, fileToken, authTokenMetadata{
		Username:  options["username"],
		Email:     options["email"],
		ExpiresAt: options["expiresAt"],
		Admin:     options["admin"] == "true",
	}); err != nil {
		return AuthTarget{}, err
	}
	if err := SaveConfig(map[string]string{"api_origin": target.APIURL}); err != nil {
		return AuthTarget{}, err
	}
	scrubLegacyTokenIfCurrentHost(target)
	return target, nil
}

type ClearAuthTokenResult struct {
	AuthTarget
	Cleared       bool `json:"cleared"`
	LegacyCleared bool `json:"legacy_cleared"`
}

func ClearAuthToken(options map[string]string) (ClearAuthTokenResult, error) {
	target, err := authTargetResolver(options)
	if err != nil {
		return ClearAuthTokenResult{}, err
	}
	keyringCleared := DeleteStoredToken(target.Host)
	fileCleared := clearSmithersAuthFile(target.Host)
	legacyCleared := scrubLegacyTokenIfCurrentHost(target)
	return ClearAuthTokenResult{
		AuthTarget:    target,
		Cleared:       keyringCleared || fileCleared,
		LegacyCleared: legacyCleared,
	}, nil
}

func GetAuthStatus(client *http.Client, options map[string]string) (status AuthStatusResult) {
	target, err := authTargetResolver(options)
	if err != nil {
		return AuthStatusResult{Message: err.Error()}
	}
	resolved, resolveErr := ResolveAuthToken(options)
	if resolveErr != nil {
		return AuthStatusResult{APIURL: target.APIURL, Host: target.Host, Message: resolveErr.Error()}
	}
	record := readSmithersAuthRecordForTarget(target)
	defer func() {
		if !authRecordDescribes(record, resolved) {
			return
		}
		status.Admin = record.Admin
		if expires, err := time.Parse(time.RFC3339, record.ExpiresAt); err == nil {
			left := time.Until(expires).Truncate(time.Second)
			if left < 0 {
				left = 0
			}
			status.TimeLeft = left.String()
		}
	}()
	storedUsername, storedEmail, storedExpiresAt := "", "", ""
	if record != nil {
		storedUsername = strings.TrimSpace(record.Username)
		storedEmail = strings.TrimSpace(record.Email)
		storedExpiresAt = strings.TrimSpace(record.ExpiresAt)
	}
	if resolved == nil {
		return AuthStatusResult{
			LoggedIn: false,
			APIURL:   target.APIURL,
			Host:     target.Host,
			TokenSet: false,
			Message:  "Not logged in to " + target.Host,
		}
	}
	source := FormatTokenSource(resolved.Source)
	stored := AuthStatusResult{
		LoggedIn:    true,
		APIURL:      resolved.APIURL,
		Host:        resolved.Host,
		TokenSet:    true,
		Username:    storedUsername,
		User:        storedUsername,
		Email:       storedEmail,
		ExpiresAt:   storedExpiresAt,
		TokenSource: resolved.Source,
	}
	user, _, err := doAPIJSON(apiCall{Method: http.MethodGet, URL: resolved.APIURL + "/api/user", Path: "/api/user", Token: resolved.Token, Client: client})
	if err != nil {
		var apiErr *APIError
		if !errors.As(err, &apiErr) {
			stored.Message = fmt.Sprintf("Logged in to %s via %s (could not verify token due to network error)", resolved.Host, source)
			return stored
		}
		// Only the server rejecting the token means the token is bad. An
		// outage or rate limit says nothing about it.
		if apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden {
			stored.LoggedIn = false
			stored.Message = fmt.Sprintf("Stored token for %s from %s is invalid or expired", resolved.Host, source)
			return stored
		}
		stored.Message = fmt.Sprintf("Logged in to %s via %s (could not verify token: server returned %d)", resolved.Host, source, apiErr.Status)
		return stored
	}
	fields := objectValue(user)
	username := firstNonEmpty(stringValue(fields["login"]), stringValue(fields["username"]), storedUsername)
	email := firstNonEmpty(stringValue(fields["email"]), storedEmail)
	message := fmt.Sprintf("Logged in to %s via %s", resolved.Host, source)
	if username != "" && email != "" {
		message = fmt.Sprintf("Logged in to %s as %s (%s) via %s", resolved.Host, username, email, source)
	} else if username != "" {
		message = fmt.Sprintf("Logged in to %s as %s via %s", resolved.Host, username, source)
	}
	stored.Username, stored.User, stored.Email, stored.Message = username, username, email, message
	return stored
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
