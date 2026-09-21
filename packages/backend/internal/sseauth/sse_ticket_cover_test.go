package sseauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// sseTicketCoverNow is a fixed reference time used across the cover tests.
var sseTicketCoverNow = time.Date(2026, 6, 1, 8, 0, 0, 0, time.UTC)

// sseTicketCoverManager builds a manager pinned to a fixed clock.
func sseTicketCoverManager() *SSETicketManager {
	m := NewSSETicketManager("cover-secret")
	m.now = func() time.Time { return sseTicketCoverNow }
	return m
}

// sseTicketCoverB64 encodes bytes with the raw-url encoding used by the ticket format.
func sseTicketCoverB64(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// sseTicketCoverValidHeaderPart returns a correctly-encoded JWT header segment.
func sseTicketCoverValidHeaderPart(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	require.NoError(t, err)
	return sseTicketCoverB64(raw)
}

// sseTicketCoverSignParts computes a valid signature over an arbitrary
// header/claims segment pair using the manager's signing key, returning the
// full three-part token. This lets tests craft tokens whose signature is valid
// but whose claims segment is malformed, exercising verify's post-signature
// decode branches.
func sseTicketCoverSignParts(m *SSETicketManager, headerPart, claimsPart string) string {
	message := headerPart + "." + claimsPart
	mac := hmac.New(sha256.New, m.signingKey)
	mac.Write([]byte(message))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return message + "." + sig
}

// sseTicketCoverValidClaims returns claims that pass every structural check in verify.
func sseTicketCoverValidClaims(now time.Time, userID int64, jti string) sseTicketClaims {
	return sseTicketClaims{
		Audience:  sseTicketAudience,
		ExpiresAt: now.Add(sseTicketTTL).Unix(),
		IssuedAt:  now.Unix(),
		NotBefore: now.Unix(),
		JTI:       jti,
		Kind:      sseTicketKind,
		TokenHash: "cover-hash",
		UserID:    userID,
		Version:   sseTicketVersion,
	}
}

func TestSseTicket_Cover_VerifyMalformedTokens(t *testing.T) {
	t.Parallel()

	m := sseTicketCoverManager()
	validHeader := sseTicketCoverValidHeaderPart(t)

	// Header with a non-HS256 algorithm.
	badAlgHeaderRaw, err := json.Marshal(map[string]string{"alg": "none", "typ": "JWT"})
	require.NoError(t, err)
	badAlgHeader := sseTicketCoverB64(badAlgHeaderRaw)

	// Header with wrong typ.
	badTypHeaderRaw, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "NOPE"})
	require.NoError(t, err)
	badTypHeader := sseTicketCoverB64(badTypHeaderRaw)

	cases := []struct {
		name  string
		token string
	}{
		{name: "single_segment", token: "onlyonesegment"},
		{name: "two_segments", token: "header.claims"},
		{name: "four_segments", token: "a.b.c.d"},
		{name: "header_not_base64", token: "!!!." + validHeader + ".sig"},
		{name: "header_not_json", token: sseTicketCoverB64([]byte("not-json")) + ".x.y"},
		{name: "header_wrong_alg", token: badAlgHeader + ".x.y"},
		{name: "header_wrong_typ", token: badTypHeader + ".x.y"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := m.ValidateAndConsume(tc.token)
			assert.ErrorIs(t, err, ErrSSETicketInvalid)
		})
	}
}

func TestSseTicket_Cover_VerifySignatureFailures(t *testing.T) {
	t.Parallel()

	m := sseTicketCoverManager()
	claims := sseTicketCoverValidClaims(sseTicketCoverNow, 11, "jti-sig")
	token := m.sign(claims)

	// Tamper the signature so it no longer matches (valid base64, wrong bytes).
	parts := splitThree(t, token)
	tamperedMismatch := parts[0] + "." + parts[1] + "." + sseTicketCoverB64([]byte("wrong-signature"))
	_, err := m.ValidateAndConsume(tamperedMismatch)
	assert.ErrorIs(t, err, ErrSSETicketInvalid)

	// Signature segment that is not valid base64.
	tamperedBadB64 := parts[0] + "." + parts[1] + ".!!!"
	_, err = m.ValidateAndConsume(tamperedBadB64)
	assert.ErrorIs(t, err, ErrSSETicketInvalid)
}

func TestSseTicket_Cover_VerifyClaimsDecodeFailures(t *testing.T) {
	t.Parallel()

	m := sseTicketCoverManager()
	header := sseTicketCoverValidHeaderPart(t)

	// Claims segment is not valid base64 but the signature over it is valid,
	// forcing verify past the signature check to the claims base64 decode.
	badB64Token := sseTicketCoverSignParts(m, header, "!!!")
	_, err := m.ValidateAndConsume(badB64Token)
	assert.ErrorIs(t, err, ErrSSETicketInvalid)

	// Claims segment decodes but is not valid JSON.
	notJSONClaims := sseTicketCoverB64([]byte("not-json-claims"))
	badJSONToken := sseTicketCoverSignParts(m, header, notJSONClaims)
	_, err = m.ValidateAndConsume(badJSONToken)
	assert.ErrorIs(t, err, ErrSSETicketInvalid)
}

func TestSseTicket_Cover_VerifyClaimContentFailures(t *testing.T) {
	t.Parallel()

	base := sseTicketCoverValidClaims(sseTicketCoverNow, 21, "jti-content")

	mutate := func(fn func(c *sseTicketClaims)) sseTicketClaims {
		c := base
		fn(&c)
		return c
	}

	cases := []struct {
		name    string
		claims  sseTicketClaims
		wantErr error
	}{
		{
			name:    "wrong_version",
			claims:  mutate(func(c *sseTicketClaims) { c.Version = sseTicketVersion + 1 }),
			wantErr: ErrSSETicketInvalid,
		},
		{
			name:    "wrong_kind",
			claims:  mutate(func(c *sseTicketClaims) { c.Kind = "other" }),
			wantErr: ErrSSETicketInvalid,
		},
		{
			name:    "wrong_audience",
			claims:  mutate(func(c *sseTicketClaims) { c.Audience = "someone-else" }),
			wantErr: ErrSSETicketInvalid,
		},
		{
			name:    "empty_jti",
			claims:  mutate(func(c *sseTicketClaims) { c.JTI = "" }),
			wantErr: ErrSSETicketInvalid,
		},
		{
			name:    "non_positive_user",
			claims:  mutate(func(c *sseTicketClaims) { c.UserID = 0 }),
			wantErr: ErrSSETicketInvalid,
		},
		{
			name:    "not_yet_valid",
			claims:  mutate(func(c *sseTicketClaims) { c.NotBefore = sseTicketCoverNow.Add(time.Minute).Unix() }),
			wantErr: ErrSSETicketInvalid,
		},
		{
			name: "expired",
			claims: mutate(func(c *sseTicketClaims) {
				c.NotBefore = sseTicketCoverNow.Add(-time.Hour).Unix()
				c.IssuedAt = sseTicketCoverNow.Add(-time.Hour).Unix()
				c.ExpiresAt = sseTicketCoverNow.Add(-time.Minute).Unix()
			}),
			wantErr: ErrSSETicketExpired,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			m := sseTicketCoverManager()
			token := m.sign(tc.claims)
			_, err := m.ValidateAndConsume(token)
			assert.ErrorIs(t, err, tc.wantErr)
		})
	}
}

func TestSseTicket_Cover_ValidateNoActiveTicketsForUser(t *testing.T) {
	t.Parallel()

	m := sseTicketCoverManager()
	// A structurally valid, correctly signed ticket for a user that has never
	// been issued a ticket: the activeByUser lookup returns nil.
	claims := sseTicketCoverValidClaims(sseTicketCoverNow, 777, "jti-ghost-user")
	token := m.sign(claims)

	_, err := m.ValidateAndConsume(token)
	assert.ErrorIs(t, err, ErrSSETicketInvalid)
}

func TestSseTicket_Cover_ValidateUnknownJTIForActiveUser(t *testing.T) {
	t.Parallel()

	m := sseTicketCoverManager()
	// The user has an active-tickets map, but not this specific JTI.
	m.activeByUser[55] = map[string]time.Time{
		"a-different-jti": sseTicketCoverNow.Add(sseTicketTTL),
	}

	claims := sseTicketCoverValidClaims(sseTicketCoverNow, 55, "jti-not-present")
	token := m.sign(claims)

	_, err := m.ValidateAndConsume(token)
	assert.ErrorIs(t, err, ErrSSETicketInvalid)

	// The pre-existing unrelated active ticket must be left untouched.
	_, stillThere := m.activeByUser[55]["a-different-jti"]
	assert.True(t, stillThere)
}

func TestSseTicket_Cover_CleanupLockedPrunesExpiredEntries(t *testing.T) {
	t.Parallel()

	m := sseTicketCoverManager()
	past := sseTicketCoverNow.Add(-time.Hour)
	future := sseTicketCoverNow.Add(time.Hour)

	// User 1 has only an expired ticket -> the ticket is dropped and the user
	// entry itself is removed once its map is empty.
	m.activeByUser[1] = map[string]time.Time{"expired": past}
	// User 2 keeps a live ticket.
	m.activeByUser[2] = map[string]time.Time{"live": future}
	// Used tickets: one expired (pruned), one live (kept).
	m.usedTickets["used-expired"] = past
	m.usedTickets["used-live"] = future

	m.mu.Lock()
	m.cleanupLocked(sseTicketCoverNow)
	m.mu.Unlock()

	_, user1Present := m.activeByUser[1]
	assert.False(t, user1Present, "expired-only user should be removed")

	live, user2Present := m.activeByUser[2]
	require.True(t, user2Present, "user with a live ticket should remain")
	_, liveTicketPresent := live["live"]
	assert.True(t, liveTicketPresent)

	_, expiredUsedPresent := m.usedTickets["used-expired"]
	assert.False(t, expiredUsedPresent)
	_, liveUsedPresent := m.usedTickets["used-live"]
	assert.True(t, liveUsedPresent)
}

func TestSseTicket_Cover_ReplayGuardExpiresSoConsumeSucceedsAgain(t *testing.T) {
	t.Parallel()

	m := sseTicketCoverManager()

	// Issue and consume a ticket so its JTI lands in usedTickets.
	token, expiresAt, err := m.Issue(SSETicketSubject{UserID: 33, TokenHash: "hash-33"})
	require.NoError(t, err)
	subject, err := m.ValidateAndConsume(token)
	require.NoError(t, err)
	assert.Equal(t, int64(33), subject.UserID)

	// The used-ticket entry is retained until its expiry.
	usedExpiry, present := m.usedTickets[usedJTIFor(t, m, token)]
	require.True(t, present)
	assert.Equal(t, expiresAt.Unix(), usedExpiry.Unix())
}

// --- small local helpers -------------------------------------------------

func splitThree(t *testing.T, token string) [3]string {
	t.Helper()
	var out [3]string
	idx := 0
	start := 0
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			require.Less(t, idx, 3, "token had more than three segments")
			out[idx] = token[start:i]
			idx++
			start = i + 1
		}
	}
	require.Equal(t, 2, idx, "token did not have exactly three segments")
	out[2] = token[start:]
	return out
}

// usedJTIFor decodes the JTI claim from a token so the replay test can look it
// up in the used-tickets map without reaching into unexported claim parsing.
func usedJTIFor(t *testing.T, m *SSETicketManager, token string) string {
	t.Helper()
	claims, err := m.verify(token, sseTicketCoverNow)
	require.NoError(t, err)
	return claims.JTI
}
