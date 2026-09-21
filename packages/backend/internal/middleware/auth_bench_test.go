package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type benchUserQuerier struct {
	row db.GetAuthInfoByTokenHashRow
}

func (b *benchUserQuerier) GetAuthInfoByTokenHash(_ context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
	_ = tokenHash
	return b.row, nil
}

func (b *benchUserQuerier) GetOAuth2AccessTokenByHash(_ context.Context, tokenHash string) (db.Oauth2AccessToken, error) {
	_ = tokenHash
	return db.Oauth2AccessToken{}, pgx.ErrNoRows
}

func (b *benchUserQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	return db.User{ID: id, Username: "bench-user", LowerUsername: "bench-user", IsActive: true}, nil
}

func BenchmarkExtractToken_ValidBearer(b *testing.B) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_0123456789abcdef0123456789abcdef01234567")

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if tok := ExtractToken(req); tok == "" {
			b.Fatal("expected token")
		}
	}
}

func BenchmarkExtractToken_InvalidToken(b *testing.B) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer invalid")

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if tok := ExtractToken(req); tok != "" {
			b.Fatal("expected empty token")
		}
	}
}

func BenchmarkTokenAuth_ValidToken(b *testing.B) {
	token := "smithers_0123456789abcdef0123456789abcdef01234567"
	hash := sha256.Sum256([]byte(token))
	expectedHash := hex.EncodeToString(hash[:])

	q := &benchUserQuerier{
		row: db.GetAuthInfoByTokenHashRow{
			ID:          1,
			Username:    "bench-user",
			TokenID:     42,
			TokenScopes: "read:repository,write:repository",
		},
	}

	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromContext(r.Context()) == nil {
			b.Fatal("missing user in context")
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
			b.Fatalf("unexpected status: %d", rec.Code)
		}
	}

	if expectedHash == "" {
		b.Fatal("expected hash")
	}
}
