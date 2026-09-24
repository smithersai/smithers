package compose

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/sseauth"
)

type fakeRevocationChecker struct {
	revokedTokens map[string]bool
	disabledUsers map[int64]bool
}

func (c fakeRevocationChecker) IsTokenRevoked(tokenHash string) bool {
	return c.revokedTokens[tokenHash]
}
func (c fakeRevocationChecker) IsUserDisabled(userID int64) bool { return c.disabledUsers[userID] }

// A request that authenticates only with ?ticket= must still pass the
// revocation guard: the ticket's principal is installed after AuthLoader, so
// the guard has to run after ticket auth too.
//
// Not parallel: it swaps the process-wide revocationChecker, which the router
// reads at construction time.
func TestServerRouter_RevocationGuardChecksSSETicketPrincipal(t *testing.T) {
	previous := revocationChecker
	t.Cleanup(func() { revocationChecker = previous })

	cases := map[string]struct {
		subject sseauth.SSETicketSubject
		checker fakeRevocationChecker
		want    int
	}{
		"revoked minting token": {
			subject: sseauth.SSETicketSubject{UserID: 1, TokenHash: "revoked-hash", TokenAuth: true, Scopes: "read:user"},
			checker: fakeRevocationChecker{revokedTokens: map[string]bool{"revoked-hash": true}},
			want:    http.StatusUnauthorized,
		},
		"disabled user": {
			subject: sseauth.SSETicketSubject{UserID: 7},
			checker: fakeRevocationChecker{disabledUsers: map[int64]bool{7: true}},
			want:    http.StatusForbidden,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			revocationChecker = tc.checker
			manager := sseauth.NewSSETicketManager("session-secret")
			ticket, _, err := manager.Issue(tc.subject)
			require.NoError(t, err)

			notifHandler := &routes.NotificationHandler{Service: &mockRouterNotificationService{}}
			router := routerWithAuthAndNotifications(&routes.AuthHandler{SSETickets: manager}, notifHandler)

			req := httptest.NewRequest(http.MethodGet, "/api/notifications?ticket="+ticket, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			assert.Equal(t, tc.want, rec.Code)
		})
	}
}
