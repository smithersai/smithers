package sseauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	sseTicketAudience    = "smithers:sse"
	sseTicketKind        = "sse_ticket"
	sseTicketVersion     = 1
	sseTicketTTL         = 30 * time.Second
	maxSSETicketsPerUser = 50
)

var (
	ErrSSETicketInvalid = errors.New("invalid sse ticket")
	ErrSSETicketExpired = errors.New("expired sse ticket")
	ErrSSETicketReplay  = errors.New("replayed sse ticket")
	ErrSSETicketLimit   = errors.New("too many active sse tickets")
)

var readRandomTicketID = rand.Read

type SSETicketSubject struct {
	UserID    int64
	TokenHash string
	// TokenAuth records whether the ticket was minted by a token-authenticated
	// caller; Scopes carries that token's raw scope string so ticket auth
	// retains the minting token's scope restrictions.
	TokenAuth bool
	Scopes    string
}

type sseTicketClaims struct {
	Audience  string `json:"aud"`
	ExpiresAt int64  `json:"exp"`
	IssuedAt  int64  `json:"iat"`
	NotBefore int64  `json:"nbf"`
	JTI       string `json:"jti"`
	Kind      string `json:"kind"`
	TokenHash string `json:"token_hash"`
	TokenAuth bool   `json:"token_auth,omitempty"`
	Scopes    string `json:"scopes,omitempty"`
	UserID    int64  `json:"user_id"`
	Version   int    `json:"ver"`
}

type SSETicketManager struct {
	mu           sync.Mutex
	signingKey   []byte
	now          func() time.Time
	activeByUser map[int64]map[string]time.Time
	usedTickets  map[string]time.Time
}

func NewSSETicketManager(sessionSecret string) *SSETicketManager {
	derived := sha256.Sum256([]byte("smithers:sse-ticket:v1:" + sessionSecret))
	return &SSETicketManager{
		signingKey:   derived[:],
		now:          func() time.Time { return time.Now().UTC() },
		activeByUser: make(map[int64]map[string]time.Time),
		usedTickets:  make(map[string]time.Time),
	}
}

func (m *SSETicketManager) Issue(subject SSETicketSubject) (string, time.Time, error) {
	now := m.now().UTC()
	expiresAt := now.Add(sseTicketTTL)
	jti, err := randomTicketID()
	if err != nil {
		return "", time.Time{}, err
	}

	m.mu.Lock()
	m.cleanupLocked(now)
	active := m.activeByUser[subject.UserID]
	if active == nil {
		active = make(map[string]time.Time)
		m.activeByUser[subject.UserID] = active
	}
	if len(active) >= maxSSETicketsPerUser {
		m.mu.Unlock()
		return "", time.Time{}, ErrSSETicketLimit
	}
	active[jti] = expiresAt
	m.mu.Unlock()

	claims := sseTicketClaims{
		Audience:  sseTicketAudience,
		ExpiresAt: expiresAt.Unix(),
		IssuedAt:  now.Unix(),
		NotBefore: now.Unix(),
		JTI:       jti,
		Kind:      sseTicketKind,
		TokenHash: strings.TrimSpace(subject.TokenHash),
		TokenAuth: subject.TokenAuth,
		Scopes:    strings.TrimSpace(subject.Scopes),
		UserID:    subject.UserID,
		Version:   sseTicketVersion,
	}

	return m.sign(claims), expiresAt, nil
}

func (m *SSETicketManager) ValidateAndConsume(token string) (SSETicketSubject, error) {
	now := m.now().UTC()
	claims, err := m.verify(token, now)
	if err != nil {
		return SSETicketSubject{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.cleanupLocked(now)

	if expiry, used := m.usedTickets[claims.JTI]; used && expiry.After(now) {
		return SSETicketSubject{}, ErrSSETicketReplay
	}

	active := m.activeByUser[claims.UserID]
	if active == nil {
		return SSETicketSubject{}, ErrSSETicketInvalid
	}
	expiry, ok := active[claims.JTI]
	if !ok {
		return SSETicketSubject{}, ErrSSETicketInvalid
	}

	delete(active, claims.JTI)
	if len(active) == 0 {
		delete(m.activeByUser, claims.UserID)
	}
	m.usedTickets[claims.JTI] = expiry

	return SSETicketSubject{
		UserID:    claims.UserID,
		TokenHash: claims.TokenHash,
		TokenAuth: claims.TokenAuth,
		Scopes:    claims.Scopes,
	}, nil
}

func (m *SSETicketManager) cleanupLocked(now time.Time) {
	for userID, active := range m.activeByUser {
		for jti, expiry := range active {
			if !expiry.After(now) {
				delete(active, jti)
			}
		}
		if len(active) == 0 {
			delete(m.activeByUser, userID)
		}
	}
	for jti, expiry := range m.usedTickets {
		if !expiry.After(now) {
			delete(m.usedTickets, jti)
		}
	}
}

func (m *SSETicketManager) sign(claims sseTicketClaims) string {
	headerJSON := mustBytes(json.Marshal(map[string]string{
		"alg": "HS256",
		"typ": "JWT",
	}))
	claimsJSON := mustBytes(json.Marshal(claims))

	headerPart := base64.RawURLEncoding.EncodeToString(headerJSON)
	claimsPart := base64.RawURLEncoding.EncodeToString(claimsJSON)
	message := headerPart + "." + claimsPart

	mac := hmac.New(sha256.New, m.signingKey)
	_, err := mac.Write([]byte(message))
	mustNoErr(err)

	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return message + "." + signature
}

func (m *SSETicketManager) verify(token string, now time.Time) (sseTicketClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}

	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}
	var header struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}
	if header.Algorithm != "HS256" || header.Type != "JWT" {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}

	message := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, m.signingKey)
	_, err = mac.Write([]byte(message))
	mustNoErr(err)
	expectedSignature := mac.Sum(nil)

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(signature, expectedSignature) {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}

	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}

	var claims sseTicketClaims
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}
	if claims.Version != sseTicketVersion || claims.Kind != sseTicketKind || claims.Audience != sseTicketAudience {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}
	if claims.JTI == "" || claims.UserID <= 0 {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}

	if now.Unix() < claims.NotBefore {
		return sseTicketClaims{}, ErrSSETicketInvalid
	}
	if now.Unix() >= claims.ExpiresAt {
		return sseTicketClaims{}, ErrSSETicketExpired
	}

	return claims, nil
}

func randomTicketID() (string, error) {
	buf := make([]byte, 16)
	if _, err := readRandomTicketID(buf); err != nil {
		return "", fmt.Errorf("generate ticket id: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func mustBytes(value []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return value
}

func mustNoErr(err error) {
	if err != nil {
		panic(err)
	}
}
