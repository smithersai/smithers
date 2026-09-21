package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBilling_Z_MissingAuthAndOrgBranches(t *testing.T) {
	handler := &BillingHandler{Service: &mockBillingRouteService{}}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
	}{
		{"user checkout", handler.PostUserCheckout, `{"plan":"pro"}`},
		{"user portal", handler.PostUserPortal, ""},
		{"user refresh", handler.PostUserRefresh, ""},
		{"org checkout", handler.PostOrgCheckout, `{"plan":"team"}`},
		{"org portal", handler.PostOrgPortal, ""},
		{"org refresh", handler.PostOrgRefresh, ""},
	} {
		t.Run("missing auth "+tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/billing", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}

	for _, tc := range []struct {
		name   string
		method func(http.ResponseWriter, *http.Request)
		body   string
	}{
		{"checkout", handler.PostOrgCheckout, `{"plan":"team"}`},
		{"portal", handler.PostOrgPortal, ""},
		{"refresh", handler.PostOrgRefresh, ""},
	} {
		t.Run("missing org "+tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/orgs//billing", strings.NewReader(tc.body))
			req = withAuth(req, 7, "alice")
			rec := httptest.NewRecorder()

			tc.method(rec, req)

			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestBilling_Z_OrgCheckoutDecodeAndGenericReadError(t *testing.T) {
	handler := &BillingHandler{Service: &mockBillingRouteService{}}
	req := httptest.NewRequest(http.MethodPost, "/orgs/acme/billing/checkout", strings.NewReader(`{`))
	req = withRouteParams(req, map[string]string{"org": "acme"})
	req = withAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	handler.PostOrgCheckout(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)

	req = httptest.NewRequest(http.MethodPost, "/billing/checkout", nil)
	req.Body = billingCovErrReadCloser{}
	rec = httptest.NewRecorder()
	var decoded billingCheckoutRequest

	apiErr := decodeBillingCheckoutRequest(rec, req, &decoded)

	require.NotNil(t, apiErr)
	require.Equal(t, http.StatusBadRequest, apiErr.Status)
	require.Equal(t, "invalid request body", apiErr.Message)
}
