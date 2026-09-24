package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"net/http"
)

func makeAdminUser() *db.User { return &db.User{ID: 99, Username: "admin-user", IsAdmin: true} }
func withAdminContext(req *http.Request) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: makeAdminUser(), IsTokenAuth: true, Scopes: middleware.ParseTokenScopes("admin")}))
}
