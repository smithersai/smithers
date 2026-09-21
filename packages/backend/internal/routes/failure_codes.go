package routes

import (
	"net/http"
	"sync"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// failureCodesDocument is rendered once per process. The bytes are the same
// ones cmd/failurecodes writes into docs/failure-codes.json, because both go
// through pkgerrors.MarshalDocument — so a deployment's digest and the file's
// digest can only differ if the deployment is running older code, which is
// exactly what a canary wants to detect.
var failureCodesDocument = sync.OnceValues(pkgerrors.MarshalDocument)

// FailureCodes handles GET /api/meta/failure-codes.
//
// It is unauthenticated and read-only: the failure vocabulary is a published
// contract, not a secret, and other repositories generate code from it. It
// lives under /api/ so the OpenAPI generator documents it and the Cloudflare
// Worker proxies it like every other API route.
func FailureCodes(w http.ResponseWriter, r *http.Request) {
	payload, err := failureCodesDocument()
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("render failure codes: "+err.Error()))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}
