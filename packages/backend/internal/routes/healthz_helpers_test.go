package routes

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type healthzTestStruct struct{}

func TestIsNilInterface_Matrix(t *testing.T) {
	t.Parallel()

	var nilBuffer *bytes.Buffer
	var nilReader io.Reader = nilBuffer
	var nilStruct *healthzTestStruct

	tests := []struct {
		name  string
		value interface{}
		want  bool
	}{
		{name: "nil_interface", value: nil, want: true},
		{name: "nil_pointer", value: nilStruct, want: true},
		{name: "typed_nil_interface_with_pointer", value: nilReader, want: true},
		{name: "non_nil_pointer", value: &healthzTestStruct{}, want: false},
		{name: "zero_struct", value: healthzTestStruct{}, want: false},
		{name: "string", value: "", want: false},
		{name: "nil_slice", value: []string(nil), want: false},
		{name: "nil_map", value: map[string]string(nil), want: false},
		{name: "nil_func", value: (func())(nil), want: false},
		{name: "number", value: 0, want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, isNilInterface(tc.value))
		})
	}
}

func TestDefaultRepoHostHealthCheck_StatusMatrix(t *testing.T) {
	t.Parallel()

	var status atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/health", r.URL.Path)
		w.WriteHeader(int(status.Load()))
	}))
	t.Cleanup(server.Close)

	caseCount := 0
	for code := 200; code <= 599; code++ {
		caseCount++
		status.Store(int64(code))

		err := defaultRepoHostHealthCheck(server.URL)
		if code >= 200 && code < 300 {
			require.NoErrorf(t, err, "status=%d", code)
			continue
		}

		require.Errorf(t, err, "status=%d", code)
		assert.Containsf(t, err.Error(), fmt.Sprintf("status %d", code), "status=%d", code)
	}

	assert.Equal(t, 400, caseCount)
}

func TestDefaultRepoHostHealthCheck_RequestErrors(t *testing.T) {
	t.Parallel()

	assert.Error(t, defaultRepoHostHealthCheck("://bad url"))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	server.Close()

	assert.Error(t, defaultRepoHostHealthCheck(server.URL))
}
