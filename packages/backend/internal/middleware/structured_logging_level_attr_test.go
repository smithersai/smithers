package middleware

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A caller attribute named "level" that is not a slog.Level must not panic the
// process-wide logger, and must not overwrite the record's severity.
func TestGCPHandler_NonLevelAttrNamedLevel(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(NewGCPJSONHandler(&buf, slog.LevelInfo))

	require.NotPanics(t, func() {
		logger.Warn("custom", slog.String("level", "custom"))
	})

	var entry map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
	assert.Equal(t, "WARNING", entry["severity"])
	assert.Equal(t, "custom", entry["level"])
}
