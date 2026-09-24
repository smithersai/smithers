package configsync

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseConfigFiles_RejectsWebhookEventsThatNeverFire(t *testing.T) {
	_, err := ParseConfigFiles(map[string][]byte{
		webhooksFilePath: []byte("webhooks:\n  - url: \"https://example.com/hook\"\n    events: [\"push\", \"release\"]\n"),
	})
	require.ErrorContains(t, err, "release")
}
