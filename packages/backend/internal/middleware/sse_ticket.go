package middleware

import (
	"context"
	stdErrors "errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sseauth"
)

// SSETicketPrincipal describes the identity and authority granted by a
// validated SSE ticket. Tickets minted by fine-grained tokens carry the
// minting token's scopes so ticket auth cannot escalate past them.
type SSETicketPrincipal struct {
	User        *db.User
	IsTokenAuth bool
	RawScopes   string
	TokenHash   string
}

// SSETicketValidator is the interface for validating SSE tickets.
type SSETicketValidator interface {
	ValidateTicket(ctx context.Context, rawTicket string) (*SSETicketPrincipal, error)
}

type sseTicketValidatorChain struct {
	validators []SSETicketValidator
}

// NewSSETicketValidatorChain returns a validator that accepts tickets from any
// configured backend, preserving compatibility while clients migrate.
func NewSSETicketValidatorChain(validators ...SSETicketValidator) SSETicketValidator {
	filtered := make([]SSETicketValidator, 0, len(validators))
	for _, validator := range validators {
		if validator != nil {
			filtered = append(filtered, validator)
		}
	}
	return &sseTicketValidatorChain{validators: filtered}
}

func (v *sseTicketValidatorChain) ValidateTicket(ctx context.Context, rawTicket string) (*SSETicketPrincipal, error) {
	var lastErr error
	for _, validator := range v.validators {
		principal, err := validator.ValidateTicket(ctx, rawTicket)
		if err == nil {
			return principal, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.Unauthorized("invalid SSE ticket")
}

// SSETicketUserLoader loads users referenced by HMAC SSE tickets.
type SSETicketUserLoader interface {
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

// SSETicketManagerValidator adapts the HMAC ticket manager to request middleware.
type SSETicketManagerValidator struct {
	manager *sseauth.SSETicketManager
	users   SSETicketUserLoader
}

// NewSSETicketManagerValidator returns a validator for short-lived HMAC SSE tickets.
func NewSSETicketManagerValidator(manager *sseauth.SSETicketManager, users SSETicketUserLoader) *SSETicketManagerValidator {
	return &SSETicketManagerValidator{
		manager: manager,
		users:   users,
	}
}

func (v *SSETicketManagerValidator) ValidateTicket(ctx context.Context, rawTicket string) (*SSETicketPrincipal, error) {
	if v == nil || v.manager == nil {
		return nil, errors.Unauthorized("invalid SSE ticket")
	}

	subject, err := v.manager.ValidateAndConsume(rawTicket)
	if err != nil {
		return nil, errors.Unauthorized("invalid or expired SSE ticket")
	}

	principal := &SSETicketPrincipal{
		IsTokenAuth: subject.TokenAuth,
		RawScopes:   subject.Scopes,
		TokenHash:   subject.TokenHash,
	}

	if v.users == nil {
		principal.User = &db.User{ID: subject.UserID}
		return principal, nil
	}

	user, err := v.users.GetUserByID(ctx, subject.UserID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, errors.Unauthorized("invalid or expired SSE ticket")
		}
		return nil, errors.Internal("failed to load SSE ticket user").WithCause(err)
	}
	if user.ProhibitLogin {
		return nil, errors.Forbidden("account is suspended")
	}

	principal.User = &user
	return principal, nil
}

// SSETicketMetrics holds Prometheus metrics for SSE ticket operations.
type SSETicketMetrics struct {
	TicketsValidated *prometheus.CounterVec
}

// SSETicketAuth returns middleware that checks for a ?ticket= query parameter
// and validates it as a short-lived SSE authentication ticket.
//
// If no ticket parameter is present, the request continues to the next handler
// unchanged (allowing AuthLoader to handle cookie/token auth as usual).
//
// If a ticket is present and valid, the user is injected into the request context.
// If a ticket is present but invalid, a 401 Unauthorized response is returned.
func SSETicketAuth(validator SSETicketValidator, metrics *SSETicketMetrics, boundaries ...identity.OwnerAuthorizer) func(http.Handler) http.Handler {
	var ownerBoundary identity.OwnerAuthorizer
	if len(boundaries) > 0 {
		ownerBoundary = boundaries[0]
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ticket := r.URL.Query().Get("ticket")
			if ticket == "" {
				next.ServeHTTP(w, r)
				return
			}

			principal, err := validator.ValidateTicket(r.Context(), ticket)
			if err != nil {
				if metrics != nil && metrics.TicketsValidated != nil {
					var label string
					apiErr, ok := err.(*errors.APIError)
					if ok && apiErr.Status == http.StatusForbidden {
						label = "suspended"
					} else {
						label = "invalid"
					}
					metrics.TicketsValidated.WithLabelValues(label).Inc()
				}
				errors.WriteError(w, errors.Unauthorized("invalid or expired SSE ticket"))
				return
			}
			if principal == nil || principal.User == nil {
				if metrics != nil && metrics.TicketsValidated != nil {
					metrics.TicketsValidated.WithLabelValues("invalid").Inc()
				}
				errors.WriteError(w, errors.Unauthorized("invalid or expired SSE ticket"))
				return
			}
			if ownerBoundary != nil {
				if err := ownerBoundary.AuthorizeOwner(r.Context(), principal.User.ID); err != nil {
					if metrics != nil && metrics.TicketsValidated != nil {
						metrics.TicketsValidated.WithLabelValues("wrong_owner").Inc()
					}
					errors.WriteError(w, err)
					return
				}
			}

			if metrics != nil && metrics.TicketsValidated != nil {
				metrics.TicketsValidated.WithLabelValues("success").Inc()
			}

			// Inject the ticket's principal into the request context. Tickets
			// minted by session auth behave like session auth (no scope
			// restrictions); tickets minted by fine-grained tokens keep the
			// minting token's scopes so RequireScope still applies.
			authInfo := &AuthInfo{
				User:        principal.User,
				IsTokenAuth: principal.IsTokenAuth,
				TokenHash:   principal.TokenHash,
				RawScopes:   principal.RawScopes,
				Scopes:      ScopeSet{},
			}
			if principal.IsTokenAuth {
				authInfo.Scopes = ParseTokenScopes(principal.RawScopes)
			}
			ctx := ContextWithAuthInfo(r.Context(), authInfo)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
