package compose

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestServerShutdownTimeoutParsesConfiguredDuration(t *testing.T) {
	timeout, err := serverShutdownTimeout(config.ServerConfig{ShutdownTimeout: "45s"})
	require.NoError(t, err)
	assert.Equal(t, 45*time.Second, timeout)
}

func TestServerShutdownTimeoutRejectsInvalidDuration(t *testing.T) {
	_, err := serverShutdownTimeout(config.ServerConfig{ShutdownTimeout: "0s"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "server.shutdown_timeout must be > 0")

	_, err = serverShutdownTimeout(config.ServerConfig{ShutdownTimeout: "soon"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "server.shutdown_timeout is invalid")
}

func TestLFSVerifyTimeoutReservesWriteHeadroom(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 595*time.Second, lfsVerifyTimeout(&config.Config{
		Server: config.ServerConfig{WriteTimeoutSecs: 600},
	}))
	assert.Equal(t, 25*time.Second, lfsVerifyTimeout(&config.Config{
		Server: config.ServerConfig{WriteTimeoutSecs: 30},
	}))
	assert.Equal(t, 500*time.Millisecond, lfsVerifyTimeout(&config.Config{
		Server: config.ServerConfig{WriteTimeoutSecs: 1},
	}))
	assert.Equal(t, defaultLFSVerifyJSONTimeout, lfsVerifyTimeout(&config.Config{}))
}

func TestInFlightRequestTrackerShutdownStats(t *testing.T) {
	tracker := newInFlightRequestTracker()
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})

	handler := tracker.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))

	go func() {
		defer close(done)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/slow", nil))
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}

	inFlight := tracker.BeginShutdown()
	assert.Equal(t, int64(1), inFlight)

	drained, killed, activeRemaining := tracker.Snapshot()
	assert.Equal(t, int64(0), drained)
	assert.Equal(t, int64(1), killed)
	assert.Equal(t, int64(1), activeRemaining)

	close(release)

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("request did not finish")
	}

	drained, killed, activeRemaining = tracker.Snapshot()
	assert.Equal(t, int64(1), drained)
	assert.Equal(t, int64(0), killed)
	assert.Equal(t, int64(0), activeRemaining)
}
