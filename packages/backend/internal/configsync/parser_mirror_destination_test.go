package configsync

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The parser must accept and reject the same destinations the mirror runtime
// does, so a committed config cannot pass sync and fail at mirror time.
func TestParseConfigFiles_MirrorDestinationMatchesRuntime(t *testing.T) {
	parse := func(destination string) error {
		_, err := ParseConfigFiles(map[string][]byte{
			configFilePath: []byte("repository:\n  mirror:\n    enabled: true\n    destination: \"" + destination + "\"\n"),
		})
		return err
	}
	for _, ok := range []string{"owner/repo", "https://github.com/owner/repo", "https://github.com/owner/repo.git", "owner/.github"} {
		require.NoError(t, parse(ok), ok)
	}
	for _, bad := range []string{"https://gitlab.com/x/y", "file:///tmp", "http://github.com/owner/repo", "https://user@github.com/owner/repo", "owner", "a/b/c", "not-a-valid-url"} {
		require.ErrorContains(t, parse(bad), "repository.mirror.destination", bad)
	}
}
