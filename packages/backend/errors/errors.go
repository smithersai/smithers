// Package errors exposes the canonical product error and HTTP serialization contract.
package errors

import (
	impl "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"net/http"
)

type APIError = impl.APIError
type FieldError = impl.FieldError
type Code = impl.Code
type Fault = impl.Fault

const (
	CodeServiceUnavailable = impl.CodeServiceUnavailable
	CodePreviewUnavailable = impl.CodePreviewUnavailable
	CodeConflict           = impl.CodeConflict
	CodeNotFound           = impl.CodeNotFound
	CodeHostLeaseLost      = impl.CodeHostLeaseLost
	FaultInfra             = impl.FaultInfra
	FaultUser              = impl.FaultUser
)

func New(code Code, msg string) *APIError                    { return impl.New(code, msg) }
func ValidationFailed(fields ...FieldError) *APIError        { return impl.ValidationFailed(fields...) }
func WriteError(w http.ResponseWriter, err *APIError)        { impl.WriteError(w, err) }
func WriteJSON(w http.ResponseWriter, status int, value any) { impl.WriteJSON(w, status, value) }
func BadRequest(message string) *APIError                    { return impl.BadRequest(message) }
func Conflict(message string) *APIError                      { return impl.Conflict(message) }
func Forbidden(message string) *APIError                     { return impl.Forbidden(message) }
func Internal(message string) *APIError                      { return impl.Internal(message) }
func NotFound(message string) *APIError                      { return impl.NotFound(message) }
func RequestEntityTooLarge(message string) *APIError         { return impl.RequestEntityTooLarge(message) }
func Unauthorized(message string) *APIError                  { return impl.Unauthorized(message) }

func MarshalDocument() ([]byte, error) { return impl.MarshalDocument() }
