package routes

import (
	"context"
	"net/http"
)

func AdminUserAuditContext(r *http.Request) context.Context { return adminUserAuditContext(r) }
func CursorToPage(cursor string, limit int) int             { return cursorToPage(cursor, limit) }
func DecodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeJSONBody(w, r, dst)
}
func DecodeOptionalJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeOptionalJSONBody(w, r, dst)
}
func ParsePagination(r *http.Request) (string, int, error) { return parsePagination(r) }
func SetPaginationHeaders(w http.ResponseWriter, r *http.Request, cursor any, limit, count int, total int64) {
	setPaginationHeaders(w, r, cursor, limit, count, total)
}
func WriteInternalError(w http.ResponseWriter, r *http.Request, message string, cause error) {
	writeInternalError(w, r, message, cause)
}
func WriteRouteError(w http.ResponseWriter, r *http.Request, err error) { writeRouteError(w, r, err) }
