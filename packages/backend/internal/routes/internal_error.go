package routes

import (
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// writeInternalError logs the cause of a 500 and answers with the fixed,
// safe message. pkgerrors.WriteError never logs, so a handler that writes
// Internal directly loses the dependency that failed.
func writeInternalError(w http.ResponseWriter, r *http.Request, message string, cause error) {
	middleware.LoggerFromContext(r.Context()).Error(message,
		"method", r.Method, "path", r.URL.Path, "error", cause)
	pkgerrors.WriteError(w, pkgerrors.Internal(message))
}
