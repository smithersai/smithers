package routes

import (
	"encoding/json"
	stderrors "errors"
	"io"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeJSONBodyWithMessage(w, r, dst, "invalid request body")
}

func decodeJSONBodyWithMessage(w http.ResponseWriter, r *http.Request, dst any, invalidMessage string) bool {
	if err := decodeJSONBodyError(w, r, dst); err != nil {
		writeJSONDecodeError(w, invalidMessage, err)
		return false
	}
	return true
}

func decodeOptionalJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeOptionalJSONBodyWithMessage(w, r, dst, "invalid request body")
}

func decodeOptionalJSONBodyWithMessage(w http.ResponseWriter, r *http.Request, dst any, invalidMessage string) bool {
	err := decodeJSONBodyError(w, r, dst)
	if err == nil || stderrors.Is(err, io.EOF) {
		return true
	}
	writeJSONDecodeError(w, invalidMessage, err)
	return false
}

func decodeJSONBodyError(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, middleware.MaxRequestBodySize)
	return json.NewDecoder(r.Body).Decode(dst)
}

func writeJSONDecodeError(w http.ResponseWriter, invalidMessage string, err error) {
	if middleware.IsMaxBytesError(err) {
		pkgerrors.WriteError(w, pkgerrors.RequestEntityTooLarge("request body too large"))
		return
	}
	pkgerrors.WriteError(w, pkgerrors.BadRequest(invalidMessage))
}
