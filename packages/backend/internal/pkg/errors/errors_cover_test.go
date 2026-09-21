package errors

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestErrors_Cov_UnprocessableEntity(t *testing.T) {
	err := UnprocessableEntity("integrity check failed")

	assert.Equal(t, http.StatusUnprocessableEntity, err.Status)
	assert.Equal(t, "integrity check failed", err.Message)
	assert.Equal(t, "integrity check failed", err.Error())
	assert.Equal(t, CodeUnprocessableEntity, err.Code)
	assert.Equal(t, FaultUser, err.Fault)
	assert.Nil(t, err.Errors)
}
