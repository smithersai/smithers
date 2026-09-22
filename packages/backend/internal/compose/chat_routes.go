package compose

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelhost"
)

// Chat streams a durable journal until the model leg terminates, so these
// routes deliberately live outside the ordinary API's 30-second JSON timeout.
func mountChatPublic(router chi.Router, runtime *chat.Runtime, queries *db.Queries, cfg *config.Config) {
	if runtime == nil {
		return
	}
	router.Group(func(r chi.Router) {
		r.Use(cors.Handler(apiCORSOptions(cfg)))
		r.Use(middleware.JSONAllowContentType("application/json"))
		r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
		r.Use(authLoader(queries, cfg.Auth))
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(middleware.RejectTenantProvisioning)
		}
		r.Use(apiCSRFMiddleware)
		r.Use(middleware.GlobalAPIRateLimit(queries))
		r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser))
		runtime.MountPublic(r)
	})
}

func mountModelPublic(router chi.Router, models modelhost.OwnerModels, queries *db.Queries, cfg *config.Config) {
	router.Group(func(r chi.Router) {
		r.Use(cors.Handler(apiCORSOptions(cfg)))
		r.Use(middleware.JSONAllowContentType("application/json"))
		r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
		r.Use(authLoader(queries, cfg.Auth))
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(middleware.RejectTenantProvisioning)
		}
		r.Use(apiCSRFMiddleware)
		r.Use(middleware.GlobalAPIRateLimit(queries))
		r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser))
		r.Get("/api/model/catalog", models.Catalog)
		r.Post("/api/model/credential", models.Credential)
		r.Get("/api/model/credential/receipt", models.CredentialReceipt)
		r.Get("/api/model/default", models.Default)
		r.Put("/api/model/default", models.SetDefault)
	})
}

func chatCallbackHandler(runtime *chat.Runtime) http.Handler {
	router := chi.NewRouter()
	runtime.MountProducerCallbacks(router)
	return router
}

// Hosted API replicas can receive capability-authenticated producer callbacks
// on their existing HTTPS listener. This lets isolated guests reach the journal
// through the deployment's public API address without a second exposed port.
func mountChatProducerOnSharedListener(router chi.Router, composition *chatComposition) {
	if composition != nil && composition.listener == nil {
		composition.runtime.MountProducerCallbacks(router)
	}
}
