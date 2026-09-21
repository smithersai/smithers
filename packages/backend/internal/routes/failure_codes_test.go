package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestFailureCodesServesTheCheckedInArtifact(t *testing.T) {
	rec := httptest.NewRecorder()
	FailureCodes(rec, httptest.NewRequest(http.MethodGet, "/api/meta/failure-codes", nil))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "public, max-age=300", rec.Header().Get("Cache-Control"))

	onDisk, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "api", "failure-codes.json"))
	require.NoError(t, err)
	assert.Equal(t, string(onDisk), rec.Body.String(),
		"a deployment serves the same bytes the repository holds, so a canary "+
			"comparing digests detects a stale rollout and nothing else")
}

func TestFailureCodesDocumentIsUsable(t *testing.T) {
	rec := httptest.NewRecorder()
	FailureCodes(rec, httptest.NewRequest(http.MethodGet, "/api/meta/failure-codes", nil))

	var doc pkgerrors.Document
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &doc))
	assert.Equal(t, pkgerrors.DocumentSchemaVersion, doc.SchemaVersion)
	assert.NotEmpty(t, doc.Digest)
	assert.Len(t, doc.Codes, len(pkgerrors.Codes()))

	byCode := map[pkgerrors.Code]pkgerrors.CodeRecord{}
	for _, record := range doc.Codes {
		byCode[record.Code] = record
	}
	capacity, ok := byCode[pkgerrors.CodeNoCapacity]
	require.True(t, ok)
	assert.Equal(t, pkgerrors.FaultInfra, capacity.Fault)
	assert.Equal(t, http.StatusServiceUnavailable, capacity.Status)
}
