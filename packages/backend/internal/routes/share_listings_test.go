package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const routeShareListingID = "2dd9630b-d96d-4d30-90b0-075ec7b06382"

type fakeShareListingRouteService struct {
	listing db.ShareListing
	page    services.ShareListingPage
	err     error

	published services.PublishShareListingInput
	actorID   int64
	event     string
	deleted   string
}

func (f *fakeShareListingRouteService) Publish(_ context.Context, actorID int64, in services.PublishShareListingInput) (db.ShareListing, error) {
	f.actorID, f.published = actorID, in
	return f.listing, f.err
}

func (f *fakeShareListingRouteService) Unpublish(_ context.Context, actorID int64, listingID string) error {
	f.actorID, f.deleted = actorID, listingID
	return f.err
}

func (f *fakeShareListingRouteService) Get(_ context.Context, listingID string) (db.ShareListing, error) {
	f.deleted = listingID
	return f.listing, f.err
}

func (f *fakeShareListingRouteService) List(_ context.Context, _ services.ShareListingQuery) (services.ShareListingPage, error) {
	return f.page, f.err
}

func (f *fakeShareListingRouteService) ListForOwner(_ context.Context, actorID int64, _ services.ShareListingQuery) (services.ShareListingPage, error) {
	f.actorID = actorID
	return f.page, f.err
}

func (f *fakeShareListingRouteService) RecordEvent(_ context.Context, actorID int64, listingID, eventType string) (services.ShareListingEventResult, error) {
	f.actorID, f.deleted, f.event = actorID, listingID, eventType
	return services.ShareListingEventResult{Counted: true, InstallCount: 3, UseCount: 9}, f.err
}

func routeShareListingFixture() db.ShareListing {
	published := time.Date(2026, 8, 5, 20, 15, 0, 0, time.UTC)
	return db.ShareListing{
		ID:              routeShareListingID,
		Kind:            "connector",
		Name:            "PagerDuty Alerts",
		Slug:            "pagerduty-alerts",
		Description:     "Routes incident alerts",
		OwnerUserID:     42,
		SourceRepoOwner: "smithers-ai",
		SourceRepoName:  "connectors",
		SourcePath:      "pagerduty/connector.json",
		ContentSnapshot: `{"name":"pagerduty","credentials":{"source":"user-secret-store"}}`,
		PublishedAt:     published,
		UpdatedAt:       published,
		UseCount:        9,
		InstallCount:    3,
	}
}

func serveShareListingRoute(h *ShareListingHandler, req *http.Request, actorID int64, authenticated bool) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	if authenticated {
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
					User:        &db.User{ID: actorID, Username: "publisher"},
					IsTokenAuth: false,
				})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
	}
	h.Mount(router, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestShareListingRoutes_PublicListAndDetailNeedNoAuth(t *testing.T) {
	listing := routeShareListingFixture()
	fake := &fakeShareListingRouteService{
		listing: listing,
		page: services.ShareListingPage{
			Listings: []db.ShareListing{listing}, Total: 1, Page: 1, PerPage: 25,
		},
	}
	h := NewShareListingHandler(fake)

	listReq := httptest.NewRequest(http.MethodGet, "/api/share/listings?kind=connector&page=1", nil)
	listRec := serveShareListingRoute(h, listReq, 0, false)
	require.Equal(t, http.StatusOK, listRec.Code, listRec.Body.String())
	var listBody struct {
		Listings []shareListingJSON `json:"listings"`
		Total    int64              `json:"total"`
		Page     int                `json:"page"`
		HasMore  bool               `json:"hasMore"`
	}
	require.NoError(t, json.Unmarshal(listRec.Body.Bytes(), &listBody))
	require.Len(t, listBody.Listings, 1)
	assert.Equal(t, listing.ContentSnapshot, listBody.Listings[0].ContentSnapshot)
	assert.Equal(t, int64(9), listBody.Listings[0].UseCount)
	assert.Equal(t, int64(3), listBody.Listings[0].InstallCount)
	assert.Equal(t, int64(1), listBody.Total)
	assert.False(t, listBody.HasMore)

	detailReq := httptest.NewRequest(http.MethodGet, "/api/share/listings/"+routeShareListingID, nil)
	detailRec := serveShareListingRoute(h, detailReq, 0, false)
	require.Equal(t, http.StatusOK, detailRec.Code, detailRec.Body.String())
	var detail shareListingJSON
	require.NoError(t, json.Unmarshal(detailRec.Body.Bytes(), &detail))
	assert.Equal(t, routeShareListingID, detail.ListingID)
	assert.Equal(t, listing.ContentSnapshot, detail.ContentSnapshot)
	assert.Equal(t, "smithers-ai", detail.SourceRepo.Owner)
	assert.Equal(t, "connectors", detail.SourceRepo.Name)
}

func TestShareListingRoutes_PublishAndMineRequireAuth(t *testing.T) {
	listing := routeShareListingFixture()
	fake := &fakeShareListingRouteService{
		listing: listing,
		page: services.ShareListingPage{
			Listings: []db.ShareListing{listing}, Total: 1, Page: 1, PerPage: 25,
		},
	}
	h := NewShareListingHandler(fake)
	payload := `{
		"kind":"connector",
		"name":"PagerDuty Alerts",
		"description":"Routes incident alerts",
		"sourceRepo":{"owner":"smithers-ai","name":"connectors"},
		"sourcePath":"pagerduty/connector.json",
		"contentSnapshot":"{\"name\":\"pagerduty\"}"
	}`

	unauthReq := httptest.NewRequest(http.MethodPost, "/api/share/listings", strings.NewReader(payload))
	unauthRec := serveShareListingRoute(h, unauthReq, 0, false)
	assert.Equal(t, http.StatusUnauthorized, unauthRec.Code)

	authReq := httptest.NewRequest(http.MethodPost, "/api/share/listings", strings.NewReader(payload))
	authRec := serveShareListingRoute(h, authReq, 42, true)
	require.Equal(t, http.StatusCreated, authRec.Code, authRec.Body.String())
	assert.Equal(t, int64(42), fake.actorID)
	assert.Equal(t, "connector", fake.published.Kind)
	assert.Equal(t, "smithers-ai", fake.published.SourceRepoOwner)
	assert.Equal(t, `{"name":"pagerduty"}`, fake.published.ContentSnapshot)

	mineReq := httptest.NewRequest(http.MethodGet, "/api/share/my/listings", nil)
	mineRec := serveShareListingRoute(h, mineReq, 42, true)
	require.Equal(t, http.StatusOK, mineRec.Code, mineRec.Body.String())
	assert.Contains(t, mineRec.Body.String(), `"installCount":3`)
	assert.Contains(t, mineRec.Body.String(), `"contentSnapshot"`)
}

func TestShareListingRoutes_OwnershipErrorAndEventWireStatus(t *testing.T) {
	listing := routeShareListingFixture()
	fake := &fakeShareListingRouteService{listing: listing, err: pkgerrors.Forbidden("only the listing owner can unpublish it")}
	h := NewShareListingHandler(fake)

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/share/listings/"+routeShareListingID, nil)
	deleteRec := serveShareListingRoute(h, deleteReq, 99, true)
	require.Equal(t, http.StatusForbidden, deleteRec.Code, deleteRec.Body.String())
	assert.Equal(t, routeShareListingID, fake.deleted)
	assert.Equal(t, int64(99), fake.actorID)

	fake.err = nil
	eventReq := httptest.NewRequest(http.MethodPost, "/api/share/listings/"+routeShareListingID+"/events", strings.NewReader(`{"type":"run"}`))
	eventRec := serveShareListingRoute(h, eventReq, 7, true)
	require.Equal(t, http.StatusAccepted, eventRec.Code, eventRec.Body.String())
	assert.Equal(t, "run", fake.event)
	assert.JSONEq(t, `{"counted":true,"installCount":3,"useCount":9}`, eventRec.Body.String())
}
