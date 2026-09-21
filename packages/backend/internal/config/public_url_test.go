package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolvePublicAPIOrigin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		apiBase  string
		fallback string
		want     string
	}{
		{name: "api base wins and strips route prefix", apiBase: " https://api.jjhub.test/api/ ", fallback: "https://jjhub.test", want: "https://api.jjhub.test"},
		{name: "api origin without prefix", apiBase: "https://api.jjhub.test/", fallback: "https://jjhub.test", want: "https://api.jjhub.test"},
		{name: "fallback", fallback: " https://jjhub.test/ ", want: "https://jjhub.test"},
		{name: "empty", want: ""},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, ResolvePublicAPIOrigin(tc.apiBase, tc.fallback))
		})
	}
}
