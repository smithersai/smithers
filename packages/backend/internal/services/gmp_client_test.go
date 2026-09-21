package services

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeGMPDoer struct {
	requests []*http.Request
	bodies   []string
	response *http.Response
	err      error
}

func (f *fakeGMPDoer) Do(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		body = string(raw)
	}
	f.requests = append(f.requests, req)
	f.bodies = append(f.bodies, body)
	if f.err != nil {
		return nil, f.err
	}
	return f.response, nil
}

func gmpResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{},
	}
}

const gmpMatrixBody = `{
  "status": "success",
  "data": {
    "resultType": "matrix",
    "result": [
      {
        "metric": {"__name__": "smithers_sse_active_connections", "pod": "api-1"},
        "values": [[1770000000, "3"], [1770000060, "4.5"]]
      },
      {
        "metric": {},
        "values": [[1770000000, "NaN"], [1770000060, "+Inf"], [1770000120, "7"]]
      }
    ]
  }
}`

func TestNewGMPClient(t *testing.T) {
	t.Parallel()

	t.Run("returns nil without a project id", func(t *testing.T) {
		t.Parallel()
		assert.Nil(t, NewGMPClient("  ", &fakeGMPDoer{}))
	})

	t.Run("returns nil without a doer", func(t *testing.T) {
		t.Parallel()
		assert.Nil(t, NewGMPClient("plue-prod-1771780303", nil))
	})

	t.Run("returns a client when configured", func(t *testing.T) {
		t.Parallel()
		assert.NotNil(t, NewGMPClient("plue-prod-1771780303", &fakeGMPDoer{}))
	})
}

func TestGMPClient_QueryRange(t *testing.T) {
	t.Parallel()

	start := time.Unix(1770000000, 0).UTC()
	end := start.Add(time.Hour)

	t.Run("posts the query to the project's prometheus endpoint", func(t *testing.T) {
		t.Parallel()

		doer := &fakeGMPDoer{response: gmpResponse(http.StatusOK, gmpMatrixBody)}
		client := NewGMPClient("plue-prod-1771780303", doer, WithGMPEndpoint("https://monitoring.example/"))
		require.NotNil(t, client)

		_, err := client.QueryRange(context.Background(), `sum(up)`, start, end, 60*time.Second)
		require.NoError(t, err)

		require.Len(t, doer.requests, 1)
		req := doer.requests[0]
		assert.Equal(t, http.MethodPost, req.Method)
		assert.Equal(t,
			"https://monitoring.example/v1/projects/plue-prod-1771780303/location/global/prometheus/api/v1/query_range",
			req.URL.String())
		assert.Equal(t, "application/x-www-form-urlencoded", req.Header.Get("Content-Type"))

		form, err := url.ParseQuery(doer.bodies[0])
		require.NoError(t, err)
		assert.Equal(t, "sum(up)", form.Get("query"))
		assert.Equal(t, "1770000000", form.Get("start"))
		assert.Equal(t, "1770003600", form.Get("end"))
		assert.Equal(t, "60s", form.Get("step"))
	})

	t.Run("parses the matrix result and drops non-finite samples", func(t *testing.T) {
		t.Parallel()

		doer := &fakeGMPDoer{response: gmpResponse(http.StatusOK, gmpMatrixBody)}
		client := NewGMPClient("plue-prod-1771780303", doer)
		require.NotNil(t, client)

		series, err := client.QueryRange(context.Background(), `sum(up)`, start, end, 60*time.Second)
		require.NoError(t, err)
		require.Len(t, series, 2)

		assert.Equal(t, "api-1", series[0].Labels["pod"])
		require.Len(t, series[0].Points, 2)
		assert.Equal(t, int64(1770000000), series[0].Points[0].TimestampSeconds)
		assert.InDelta(t, 3.0, series[0].Points[0].Value, 1e-9)
		assert.InDelta(t, 4.5, series[0].Points[1].Value, 1e-9)

		assert.NotNil(t, series[1].Labels)
		require.Len(t, series[1].Points, 1, "NaN and +Inf samples are dropped")
		assert.InDelta(t, 7.0, series[1].Points[0].Value, 1e-9)
	})

	t.Run("returns an error for a non-200 upstream response", func(t *testing.T) {
		t.Parallel()

		doer := &fakeGMPDoer{response: gmpResponse(http.StatusForbidden, `{"error":"permission denied"}`)}
		client := NewGMPClient("plue-prod-1771780303", doer)
		require.NotNil(t, client)

		_, err := client.QueryRange(context.Background(), `sum(up)`, start, end, 60*time.Second)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "403")
		assert.Contains(t, err.Error(), "permission denied")
	})

	t.Run("returns an error when the envelope reports failure", func(t *testing.T) {
		t.Parallel()

		doer := &fakeGMPDoer{response: gmpResponse(http.StatusOK,
			`{"status":"error","errorType":"bad_data","error":"parse error"}`)}
		client := NewGMPClient("plue-prod-1771780303", doer)
		require.NotNil(t, client)

		_, err := client.QueryRange(context.Background(), `sum(up)`, start, end, 60*time.Second)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "parse error")
	})

	t.Run("propagates transport failures", func(t *testing.T) {
		t.Parallel()

		doer := &fakeGMPDoer{err: errors.New("dial tcp: connection refused")}
		client := NewGMPClient("plue-prod-1771780303", doer)
		require.NotNil(t, client)

		_, err := client.QueryRange(context.Background(), `sum(up)`, start, end, 60*time.Second)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "connection refused")
	})

	t.Run("rejects an empty query and a non-positive step", func(t *testing.T) {
		t.Parallel()

		doer := &fakeGMPDoer{response: gmpResponse(http.StatusOK, gmpMatrixBody)}
		client := NewGMPClient("plue-prod-1771780303", doer)
		require.NotNil(t, client)

		_, err := client.QueryRange(context.Background(), "  ", start, end, 60*time.Second)
		require.Error(t, err)

		_, err = client.QueryRange(context.Background(), `sum(up)`, start, end, 0)
		require.Error(t, err)

		assert.Empty(t, doer.requests, "invalid arguments never reach the backend")
	})

	t.Run("a nil client reports the backend as unconfigured", func(t *testing.T) {
		t.Parallel()

		var client *GMPClient
		_, err := client.QueryRange(context.Background(), `sum(up)`, start, end, 60*time.Second)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "not configured")
	})
}

func TestMetricPointJSON(t *testing.T) {
	t.Parallel()

	t.Run("marshals as [unix_seconds, value]", func(t *testing.T) {
		t.Parallel()

		encoded, err := MetricPoint{TimestampSeconds: 1770000000, Value: 1.5}.MarshalJSON()
		require.NoError(t, err)
		assert.Equal(t, "[1770000000,1.5]", string(encoded))
	})

	t.Run("unmarshals the prometheus string encoding", func(t *testing.T) {
		t.Parallel()

		var point MetricPoint
		require.NoError(t, point.UnmarshalJSON([]byte(`[1770000000.5,"2.25"]`)))
		assert.Equal(t, int64(1770000000), point.TimestampSeconds)
		assert.InDelta(t, 2.25, point.Value, 1e-9)
	})

	t.Run("unmarshals a numeric value", func(t *testing.T) {
		t.Parallel()

		var point MetricPoint
		require.NoError(t, point.UnmarshalJSON([]byte(`[1770000000,3]`)))
		assert.InDelta(t, 3.0, point.Value, 1e-9)
	})

	t.Run("rejects a malformed sample", func(t *testing.T) {
		t.Parallel()

		var point MetricPoint
		require.Error(t, point.UnmarshalJSON([]byte(`[1770000000]`)))
		require.Error(t, point.UnmarshalJSON([]byte(`[1770000000,"abc"]`)))
	})
}
