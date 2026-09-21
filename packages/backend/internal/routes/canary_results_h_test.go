package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCanaryResults_H_UnavailableAndDecodeBranches(t *testing.T) {
	t.Run("nil handler", func(t *testing.T) {
		var h *CanaryReportHandler
		rec := httptest.NewRecorder()

		h.PostResults(rec, httptest.NewRequest(http.MethodPost, "/canary/results", strings.NewReader(`{}`)))

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("invalid json", func(t *testing.T) {
		h := &CanaryReportHandler{Store: &canaryResultsCovStore{}}
		rec := httptest.NewRecorder()

		h.PostResults(rec, httptest.NewRequest(http.MethodPost, "/canary/results", strings.NewReader(`{`)))

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
