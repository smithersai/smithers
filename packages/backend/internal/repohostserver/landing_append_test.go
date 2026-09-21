package repohostserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

func TestLandingAppendCapabilityRouteAndExplicitMissingReceipt(t *testing.T) {
	for _, mode := range []string{"append", "legacy-route", "missing-payload", "missing-receipt"} {
		t.Run(mode, func(t *testing.T) {
			called := false
			mock := &mockFFI{landChangesFn: func(_ string, request repohost.LandRequest) (repohost.LandResult, error) {
				called = true
				require.NotNil(t, request.Append)
				if mode == "missing-receipt" {
					return repohost.LandResult{}, &repohostffi.Error{Code: "landing_receipt_missing", Message: "landing receipt not found"}
				}
				return repohost.LandResult{TargetBookmark: "main"}, nil
			}}
			srv := newTestServerWithMock(t, mock)
			payload := `{"change_ids":["tip"],"target_bookmark":"main","append":{"source_commit_id":"tip","source_base_commit_id":"base","description":"delivery"},"lookup_only":true}`
			route := "/repos/alice%3Ademo/land/append"
			if mode == "legacy-route" {
				route = "/repos/alice%3Ademo/land"
			}
			if mode == "missing-payload" {
				payload = `{"change_ids":["tip"],"target_bookmark":"main"}`
			}
			req := httptest.NewRequest(http.MethodPost, route, strings.NewReader(payload))
			req.Header.Set("Authorization", validAuth())
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			switch mode {
			case "append":
				require.Equal(t, 200, rec.Code)
				require.True(t, called)
			case "missing-receipt":
				require.Equal(t, 404, rec.Code)
				var body map[string]any
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				require.Equal(t, "landing_receipt_missing", body["code"])
			default:
				require.Equal(t, 400, rec.Code)
				require.False(t, called)
			}
		})
	}
}
