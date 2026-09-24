// Package lfsauth issues the short-lived, repository-scoped credentials used
// to bridge an authenticated SSH session to the Git LFS HTTP API.
package lfsauth

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	tokenPrefix         = "smithers_lfs_v1."
	keyDomain           = "smithers:lfs-auth:v1\x00"
	maxTokenLength      = 4096
	clockSkewAllowance  = 30 * time.Second
	DefaultTokenTTL     = 5 * time.Minute
	MaximumTokenTTL     = 15 * time.Minute
	MaximumVerifyTTL    = 8 * 24 * time.Hour
	AuthorizationScheme = "LFS"
)

type Operation string

const (
	OperationDownload Operation = "download"
	OperationUpload   Operation = "upload"
)

type PrincipalType string

const (
	PrincipalUser      PrincipalType = "user"
	PrincipalDeployKey PrincipalType = "deploy_key"
)

type Purpose string

const (
	PurposeBridge Purpose = "bridge"
	PurposeVerify Purpose = "verify"
)

// Grant is the authorization that an already-authenticated SSH session asks
// the HTTP LFS API to honor. RepositoryID is the security boundary; the names
// are retained for auditability and endpoint/path consistency checks.
type Grant struct {
	RepositoryID int64
	Owner        string
	Repository   string
	Operation    Operation
	Principal    PrincipalType
}

// VerifyGrant is an object-bound continuation capability issued by the HTTP
// Batch endpoint. It lets git-lfs finish verification after the broad SSH
// bridge credential expires without extending repository-wide upload access.
type VerifyGrant struct {
	RepositoryID int64
	Owner        string
	Repository   string
	OID          string
	Size         int64
	Principal    PrincipalType
}

// Claims is the authenticated token payload. Times are Unix seconds so the
// payload is language-neutral and compact.
type Claims struct {
	Version      int           `json:"v"`
	Purpose      Purpose       `json:"purpose"`
	RepositoryID int64         `json:"rid"`
	Owner        string        `json:"owner"`
	Repository   string        `json:"repo"`
	Operation    Operation     `json:"op"`
	Principal    PrincipalType `json:"principal"`
	OID          string        `json:"oid,omitempty"`
	Size         int64         `json:"size,omitempty"`
	IssuedAt     int64         `json:"iat"`
	ExpiresAt    int64         `json:"exp"`
	Nonce        string        `json:"nonce"`
}

// Manager signs and verifies LFS bridge credentials. Its key is derived with
// a protocol-specific domain so reusing the server session secret does not
// make an LFS token valid in any other HMAC-based subsystem.
type Manager struct {
	key [sha256.Size]byte
	now func() time.Time
}

// BridgeConfig is shared by the SSH issuer and HTTP verifier. PublicBaseURL
// must be the trusted external HTTP(S) server base; it is never inferred from
// an SSH client or HTTP Host header.
type BridgeConfig struct {
	Secret        string
	PublicBaseURL string
	TokenTTL      time.Duration
}

// Bridge couples token issuance with the exact HTTP LFS endpoint the SSH
// response advertises, preventing the issuer and verifier from drifting onto
// different secrets or URL contracts.
type Bridge struct {
	manager       *Manager
	publicBaseURL string
	tokenTTL      time.Duration
}

type AuthenticateResponse struct {
	Href      string            `json:"href"`
	Header    map[string]string `json:"header"`
	ExpiresIn int64             `json:"expires_in"`
}

func NewBridge(cfg BridgeConfig) (*Bridge, error) {
	manager, err := NewManager(cfg.Secret)
	if err != nil {
		return nil, err
	}
	base, err := validatePublicBaseURL(cfg.PublicBaseURL)
	if err != nil {
		return nil, err
	}
	ttl := cfg.TokenTTL
	if ttl == 0 {
		ttl = DefaultTokenTTL
	}
	if ttl < time.Second || ttl > MaximumTokenTTL || ttl%time.Second != 0 {
		return nil, fmt.Errorf("lfs auth token ttl must be whole seconds between 1s and %s", MaximumTokenTTL)
	}
	return &Bridge{manager: manager, publicBaseURL: base, tokenTTL: ttl}, nil
}

func (b *Bridge) Manager() *Manager {
	if b == nil {
		return nil
	}
	return b.manager
}

func (b *Bridge) Issue(grant Grant) (AuthenticateResponse, Claims, error) {
	if b == nil || b.manager == nil {
		return AuthenticateResponse{}, Claims{}, errors.New("lfs auth bridge is not configured")
	}
	token, claims, err := b.manager.Issue(grant, b.tokenTTL)
	if err != nil {
		return AuthenticateResponse{}, Claims{}, err
	}
	return AuthenticateResponse{
		Href: b.publicBaseURL + "/api/repos/" + url.PathEscape(claims.Owner) + "/" + url.PathEscape(claims.Repository) + "/lfs",
		Header: map[string]string{
			"Authorization": AuthorizationValue(token),
		},
		ExpiresIn: int64(b.tokenTTL / time.Second),
	}, claims, nil
}

func validatePublicBaseURL(raw string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	if base == "" {
		return "", errors.New("lfs public base url is required")
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("lfs public base url must be a trusted http(s) URL without credentials, query, or fragment")
	}
	return base, nil
}

func NewManager(secret string) (*Manager, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil, errors.New("lfs auth secret is required")
	}
	return &Manager{
		key: sha256.Sum256(append([]byte(keyDomain), []byte(secret)...)),
		now: func() time.Time { return time.Now().UTC() },
	}, nil
}

// Issue returns an opaque signed token for grant. Callers cannot request a TTL
// longer than MaximumTokenTTL, limiting replay after an SSH authorization.
func (m *Manager) Issue(grant Grant, ttl time.Duration) (string, Claims, error) {
	if m == nil {
		return "", Claims{}, errors.New("lfs auth manager is not configured")
	}
	grant.Owner = strings.ToLower(strings.TrimSpace(grant.Owner))
	grant.Repository = strings.ToLower(strings.TrimSpace(grant.Repository))
	if err := validateGrant(grant); err != nil {
		return "", Claims{}, err
	}
	if ttl < time.Second || ttl > MaximumTokenTTL || ttl%time.Second != 0 {
		return "", Claims{}, fmt.Errorf("lfs auth ttl must be whole seconds between 1s and %s", MaximumTokenTTL)
	}
	return m.issueClaims(Claims{
		Version:      1,
		Purpose:      PurposeBridge,
		RepositoryID: grant.RepositoryID,
		Owner:        grant.Owner,
		Repository:   grant.Repository,
		Operation:    grant.Operation,
		Principal:    grant.Principal,
	}, ttl)
}

// IssueVerify mints a longer-lived capability usable only for one exact
// verify payload. Its replay surface is intentionally much narrower than the
// SSH bridge token: repository, canonical path, OID, and size are all signed.
func (m *Manager) IssueVerify(grant VerifyGrant, ttl time.Duration) (string, Claims, error) {
	if m == nil {
		return "", Claims{}, errors.New("lfs auth manager is not configured")
	}
	grant.Owner = strings.ToLower(strings.TrimSpace(grant.Owner))
	grant.Repository = strings.ToLower(strings.TrimSpace(grant.Repository))
	grant.OID = strings.ToLower(strings.TrimSpace(grant.OID))
	if err := validateVerifyGrant(grant); err != nil {
		return "", Claims{}, err
	}
	if ttl < time.Second || ttl > MaximumVerifyTTL {
		return "", Claims{}, fmt.Errorf("lfs verify ttl must be between 1s and %s", MaximumVerifyTTL)
	}
	return m.issueClaims(Claims{
		Version:      1,
		Purpose:      PurposeVerify,
		RepositoryID: grant.RepositoryID,
		Owner:        grant.Owner,
		Repository:   grant.Repository,
		Operation:    OperationUpload,
		Principal:    grant.Principal,
		OID:          grant.OID,
		Size:         grant.Size,
	}, ttl)
}

func (m *Manager) issueClaims(claims Claims, ttl time.Duration) (string, Claims, error) {
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", Claims{}, fmt.Errorf("generate lfs auth nonce: %w", err)
	}
	now := m.now().UTC().Truncate(time.Second)
	claims.IssuedAt = now.Unix()
	claims.ExpiresAt = now.Add(ttl).Unix()
	claims.Nonce = base64.RawURLEncoding.EncodeToString(nonceBytes)
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", Claims{}, fmt.Errorf("marshal lfs auth claims: %w", err)
	}
	sig := m.sign(payload)
	token := tokenPrefix + base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sig)
	return token, claims, nil
}

func (m *Manager) Verify(token string) (Claims, error) {
	if m == nil {
		return Claims{}, ErrNotConfigured
	}
	if len(token) == 0 || len(token) > maxTokenLength || !strings.HasPrefix(token, tokenPrefix) {
		return Claims{}, ErrMalformed
	}
	parts := strings.Split(strings.TrimPrefix(token, tokenPrefix), ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return Claims{}, ErrMalformed
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Claims{}, ErrMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(sig) != sha256.Size {
		return Claims{}, ErrMalformed
	}
	if !hmac.Equal(sig, m.sign(payload)) {
		return Claims{}, ErrSignature
	}

	var claims Claims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return Claims{}, ErrMalformed
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Claims{}, ErrMalformed
	}
	if err := validateClaims(claims, m.now().UTC()); err != nil {
		return Claims{}, err
	}
	return claims, nil
}

func (m *Manager) sign(payload []byte) []byte {
	mac := hmac.New(sha256.New, m.key[:])
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func validateGrant(grant Grant) error {
	if grant.RepositoryID <= 0 || !validName(grant.Owner) || !validName(grant.Repository) {
		return errors.New("invalid lfs auth repository grant")
	}
	if grant.Operation != OperationUpload && grant.Operation != OperationDownload {
		return errors.New("invalid lfs auth operation")
	}
	if grant.Principal != PrincipalUser && grant.Principal != PrincipalDeployKey {
		return errors.New("invalid lfs auth principal")
	}
	return nil
}

func validateVerifyGrant(grant VerifyGrant) error {
	if validateGrant(Grant{
		RepositoryID: grant.RepositoryID,
		Owner:        grant.Owner,
		Repository:   grant.Repository,
		Operation:    OperationUpload,
		Principal:    grant.Principal,
	}) != nil || !validOID(grant.OID) || grant.Size < 0 {
		return errors.New("invalid lfs verify grant")
	}
	return nil
}

func validateClaims(claims Claims, now time.Time) error {
	grant := Grant{
		RepositoryID: claims.RepositoryID,
		Owner:        claims.Owner,
		Repository:   claims.Repository,
		Operation:    claims.Operation,
		Principal:    claims.Principal,
	}
	if claims.Version != 1 || claims.Owner != strings.ToLower(strings.TrimSpace(claims.Owner)) || claims.Repository != strings.ToLower(strings.TrimSpace(claims.Repository)) || validateGrant(grant) != nil {
		return ErrInvalidClaims
	}
	maxTTL := MaximumTokenTTL
	switch claims.Purpose {
	case PurposeBridge:
		if claims.OID != "" || claims.Size != 0 {
			return ErrInvalidClaims
		}
	case PurposeVerify:
		maxTTL = MaximumVerifyTTL
		if claims.Operation != OperationUpload || validateVerifyGrant(VerifyGrant{
			RepositoryID: claims.RepositoryID,
			Owner:        claims.Owner,
			Repository:   claims.Repository,
			OID:          claims.OID,
			Size:         claims.Size,
			Principal:    claims.Principal,
		}) != nil {
			return ErrInvalidClaims
		}
	default:
		return ErrInvalidClaims
	}
	issuedAt := time.Unix(claims.IssuedAt, 0)
	expiresAt := time.Unix(claims.ExpiresAt, 0)
	if claims.Nonce == "" || !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > maxTTL {
		return ErrInvalidClaims
	}
	if issuedAt.After(now.Add(clockSkewAllowance)) {
		return ErrNotYetValid
	}
	if !expiresAt.After(now) {
		return ErrExpired
	}
	return nil
}

func validOID(value string) bool {
	if len(value) != 64 || value != strings.ToLower(strings.TrimSpace(value)) {
		return false
	}
	for _, ch := range value {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

func validName(value string) bool {
	return value != "" && value != "." && value != ".." && !strings.ContainsAny(value, "/\\\x00\r\n")
}

// AuthorizationValue formats token for both the git-lfs-authenticate response
// and a verify action header.
func AuthorizationValue(token string) string {
	return AuthorizationScheme + " " + token
}

type contextGrant struct {
	claims Claims
	token  string
}

type contextKey struct{}

func ContextWithGrant(ctx context.Context, claims Claims, token string) context.Context {
	return context.WithValue(ctx, contextKey{}, contextGrant{claims: claims, token: token})
}

func ClaimsFromContext(ctx context.Context) (Claims, bool) {
	grant, ok := ctx.Value(contextKey{}).(contextGrant)
	return grant.claims, ok
}

func AuthorizationFromContext(ctx context.Context) (string, bool) {
	grant, ok := ctx.Value(contextKey{}).(contextGrant)
	if !ok || grant.token == "" {
		return "", false
	}
	return AuthorizationValue(grant.token), true
}

// HTTPMiddleware recognizes only the dedicated LFS authorization scheme.
// Other schemes continue to the normal session/PAT loader. A malformed or
// expired LFS credential fails closed instead of falling back to anonymous.
func HTTPMiddleware(manager *Manager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := strings.TrimSpace(r.Header.Get("Authorization"))
			if auth == "" {
				next.ServeHTTP(w, r)
				return
			}
			fields := strings.Fields(auth)
			if len(fields) == 0 || !strings.EqualFold(fields[0], AuthorizationScheme) {
				next.ServeHTTP(w, r)
				return
			}
			if len(fields) != 2 {
				reject(w, r, reasonMalformed)
				return
			}
			if manager == nil {
				reject(w, r, reasonNotConfigured)
				return
			}
			claims, err := manager.Verify(fields[1])
			if err != nil {
				reject(w, r, rejectionReason(err))
				return
			}
			if claims.Purpose == PurposeVerify && (r.Method != http.MethodPost || !strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "/lfs/verify")) {
				reject(w, r, reasonPurpose)
				return
			}
			next.ServeHTTP(w, r.WithContext(ContextWithGrant(r.Context(), claims, fields[1])))
		})
	}
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", AuthorizationScheme)
	apierrors.WriteError(w, apierrors.Unauthorized("invalid or expired lfs credential"))
}
