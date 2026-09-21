package clusterdb

import (
	"context"
)

const getOAuth2AuthorizationCodeByHash = `
SELECT code_hash, app_id, user_id, scopes, redirect_uri, code_challenge, code_challenge_method, expires_at, used_at, created_at
FROM oauth2_authorization_codes
WHERE code_hash = $1
  AND used_at IS NULL
  AND expires_at > NOW()
`

// GetOAuth2AuthorizationCodeByHash loads an unconsumed, unexpired
// authorization code WITHOUT marking it used. The token endpoint validates
// client binding, redirect_uri, and PKCE against this row first, then
// consumes it with ConsumeOAuth2AuthorizationCode (whose used_at IS NULL
// guard keeps single-use atomic), so a failed redemption attempt cannot burn
// the legitimate client's one-time code.
func (q *Queries) GetOAuth2AuthorizationCodeByHash(ctx context.Context, codeHash string) (Oauth2AuthorizationCode, error) {
	row := q.db.QueryRow(ctx, getOAuth2AuthorizationCodeByHash, codeHash)
	var i Oauth2AuthorizationCode
	err := row.Scan(
		&i.CodeHash,
		&i.AppID,
		&i.UserID,
		&i.Scopes,
		&i.RedirectUri,
		&i.CodeChallenge,
		&i.CodeChallengeMethod,
		&i.ExpiresAt,
		&i.UsedAt,
		&i.CreatedAt,
	)
	return i, err
}
