package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestBilling_Cov_UserPortalRefreshAndErrors(t *testing.T) {
	t.Run("overview service error propagates", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{
			getUserOverviewFn: func(ctx context.Context, user *db.User) (services.BillingOverview, error) {
				return services.BillingOverview{}, pkgerrors.Forbidden("billing disabled")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/billing", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.GetUserBilling(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("user checkout rejects malformed and oversized bodies", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/billing/checkout", strings.NewReader(`{bad`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.PostUserCheckout(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/billing/checkout", strings.NewReader(`{"plan":"`+strings.Repeat("x", int(middleware.MaxRequestBodySize))+`"}`))
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()

		h.PostUserCheckout(rec, req)

		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	})

	t.Run("user portal and refresh success and service errors", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{
			createUserPortalFn: func(ctx context.Context, user *db.User) (services.BillingSessionResult, error) {
				assert.Equal(t, int64(7), user.ID)
				return services.BillingSessionResult{URL: "https://billing.stripe.com/p/session"}, nil
			},
			refreshUserFn: func(ctx context.Context, user *db.User) (services.BillingOverview, error) {
				assert.Equal(t, int64(7), user.ID)
				return services.BillingOverview{OwnerType: "user", PlanKey: "pro"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/billing/portal", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.PostUserPortal(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
		var session services.BillingSessionResult
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &session))
		assert.Contains(t, session.URL, "stripe.com")

		req = httptest.NewRequest(http.MethodPost, "/api/billing/refresh", nil)
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()
		h.PostUserRefresh(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var overview services.BillingOverview
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &overview))
		assert.Equal(t, "pro", overview.PlanKey)

		h = &BillingHandler{Service: &mockBillingRouteService{
			createUserPortalFn: func(ctx context.Context, user *db.User) (services.BillingSessionResult, error) {
				return services.BillingSessionResult{}, pkgerrors.BadRequest("customer missing")
			},
			refreshUserFn: func(ctx context.Context, user *db.User) (services.BillingOverview, error) {
				return services.BillingOverview{}, pkgerrors.Forbidden("cannot refresh")
			},
		}}
		req = httptest.NewRequest(http.MethodPost, "/api/billing/portal", nil)
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()
		h.PostUserPortal(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		req = httptest.NewRequest(http.MethodPost, "/api/billing/refresh", nil)
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()
		h.PostUserRefresh(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestBilling_Cov_OrgEndpoints(t *testing.T) {
	t.Run("missing org route param returns bad request", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/billing", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		h.GetOrgBilling(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("org checkout portal and refresh delegate with org name", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{
			createOrgCheckoutFn: func(ctx context.Context, actor *db.User, orgName, planKey, interval string) (services.BillingSessionResult, error) {
				assert.Equal(t, int64(7), actor.ID)
				assert.Equal(t, "acme", orgName)
				assert.Equal(t, "team", planKey)
				assert.Equal(t, "annual", interval)
				return services.BillingSessionResult{URL: "https://checkout.stripe.com/org"}, nil
			},
			createOrgPortalFn: func(ctx context.Context, actor *db.User, orgName string) (services.BillingSessionResult, error) {
				assert.Equal(t, "acme", orgName)
				return services.BillingSessionResult{URL: "https://billing.stripe.com/org"}, nil
			},
			refreshOrgFn: func(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error) {
				assert.Equal(t, "acme", orgName)
				return services.BillingOverview{OwnerType: "org", OwnerName: orgName, PlanKey: "team"}, nil
			},
		}}

		checkoutReq := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/billing/checkout", strings.NewReader(`{"plan":"team","interval":"annual"}`))
		checkoutReq = withRouteParams(checkoutReq, map[string]string{"org": "acme"})
		checkoutReq = withAuth(checkoutReq, 7, "alice")
		checkoutRec := httptest.NewRecorder()
		h.PostOrgCheckout(checkoutRec, checkoutReq)
		require.Equal(t, http.StatusCreated, checkoutRec.Code)

		portalReq := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/billing/portal", nil)
		portalReq = withRouteParams(portalReq, map[string]string{"org": "acme"})
		portalReq = withAuth(portalReq, 7, "alice")
		portalRec := httptest.NewRecorder()
		h.PostOrgPortal(portalRec, portalReq)
		require.Equal(t, http.StatusCreated, portalRec.Code)

		refreshReq := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/billing/refresh", nil)
		refreshReq = withRouteParams(refreshReq, map[string]string{"org": "acme"})
		refreshReq = withAuth(refreshReq, 7, "alice")
		refreshRec := httptest.NewRecorder()
		h.PostOrgRefresh(refreshRec, refreshReq)
		require.Equal(t, http.StatusOK, refreshRec.Code)
	})

	t.Run("org service errors propagate", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{
			getOrgOverviewFn: func(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error) {
				return services.BillingOverview{}, pkgerrors.Forbidden("not an owner")
			},
			createOrgCheckoutFn: func(ctx context.Context, actor *db.User, orgName, planKey, interval string) (services.BillingSessionResult, error) {
				return services.BillingSessionResult{}, pkgerrors.BadRequest("invalid plan")
			},
			createOrgPortalFn: func(ctx context.Context, actor *db.User, orgName string) (services.BillingSessionResult, error) {
				return services.BillingSessionResult{}, pkgerrors.BadRequest("customer missing")
			},
			refreshOrgFn: func(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error) {
				return services.BillingOverview{}, pkgerrors.Forbidden("not an owner")
			},
		}}
		for _, tc := range []struct {
			name   string
			method func(*BillingHandler, http.ResponseWriter, *http.Request)
			body   string
			want   int
		}{
			{"overview", (*BillingHandler).GetOrgBilling, "", http.StatusForbidden},
			{"checkout", (*BillingHandler).PostOrgCheckout, `{"plan":"bad"}`, http.StatusBadRequest},
			{"portal", (*BillingHandler).PostOrgPortal, "", http.StatusBadRequest},
			{"refresh", (*BillingHandler).PostOrgRefresh, "", http.StatusForbidden},
		} {
			t.Run(tc.name, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodPost, "/api/orgs/acme/billing", strings.NewReader(tc.body))
				req = withRouteParams(req, map[string]string{"org": "acme"})
				req = withAuth(req, 7, "alice")
				rec := httptest.NewRecorder()
				tc.method(h, rec, req)
				require.Equal(t, tc.want, rec.Code)
			})
		}
	})
}

func TestBilling_Cov_StripeWebhookAndDecoder(t *testing.T) {
	t.Run("webhook forwards payload and maps service error", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{
			handleWebhookFn: func(ctx context.Context, payload []byte, signature string) error {
				assert.JSONEq(t, `{"type":"invoice.payment_failed"}`, string(payload))
				assert.Equal(t, "sig", signature)
				return pkgerrors.BadRequest("invalid stripe signature")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/billing/webhook", strings.NewReader(`{"type":"invoice.payment_failed"}`))
		req.Header.Set("Stripe-Signature", "sig")
		rec := httptest.NewRecorder()

		h.PostStripeWebhook(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("webhook body read errors are client errors", func(t *testing.T) {
		h := &BillingHandler{Service: &mockBillingRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/billing/webhook", nil)
		req.Body = billingCovErrReadCloser{}
		rec := httptest.NewRecorder()

		h.PostStripeWebhook(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("decode checkout request accepts empty body as zero value", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/billing/checkout", strings.NewReader(`{"plan":"pro","interval":"monthly"}`))
		rec := httptest.NewRecorder()
		var decoded billingCheckoutRequest
		apiErr := decodeBillingCheckoutRequest(rec, req, &decoded)
		require.Nil(t, apiErr)
		assert.Equal(t, "pro", decoded.Plan)
		assert.Equal(t, "monthly", decoded.Interval)
	})
}

type billingCovErrReadCloser struct{}

func (billingCovErrReadCloser) Read(p []byte) (int, error) { return 0, errors.New("read failed") }
func (billingCovErrReadCloser) Close() error               { return nil }
