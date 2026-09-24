// Package httpapi exposes shared HTTP decoding, errors, pagination and audit context.
package httpapi

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"net/http"
)

func AdminUserAuditContext(r *http.Request) context.Context { return routes.AdminUserAuditContext(r) }
func CursorToPage(cursor string, limit int) int             { return routes.CursorToPage(cursor, limit) }
func DecodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	return routes.DecodeJSONBody(w, r, dst)
}
func DecodeOptionalJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	return routes.DecodeOptionalJSONBody(w, r, dst)
}
func ParsePagination(r *http.Request) (string, int, error) { return routes.ParsePagination(r) }
func SetPaginationHeaders(w http.ResponseWriter, r *http.Request, cursor any, limit, count int, total int64) {
	routes.SetPaginationHeaders(w, r, cursor, limit, count, total)
}
func WriteInternalError(w http.ResponseWriter, r *http.Request, message string, cause error) {
	routes.WriteInternalError(w, r, message, cause)
}
func WriteRouteError(w http.ResponseWriter, r *http.Request, err error) {
	routes.WriteRouteError(w, r, err)
}
