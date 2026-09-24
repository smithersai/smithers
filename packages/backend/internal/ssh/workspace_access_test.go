package ssh

import (
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestParseWorkspaceLogins(t *testing.T) {
	token := "abcdefghijklmnopqrstuvwxyz012345"
	want := WorkspaceAccess{SandboxID: "msb_1234-abcd", User: "developer", Token: token}

	got, ok := parseWorkspacePublicKeyLogin("msb_1234-abcd+developer:" + token)
	require.True(t, ok)
	assert.Equal(t, want, got)

	got, ok = parseWorkspacePasswordLogin("msb_1234-abcd+developer", token)
	require.True(t, ok)
	assert.Equal(t, want, got)

	for _, login := range []string{
		"bad/path+developer:" + token,
		"msb_1234+../../root:" + token,
		"msb_1234+developer:short",
		"msb_1234+developer:" + token + " whitespace",
	} {
		_, ok := parseWorkspacePublicKeyLogin(login)
		assert.False(t, ok, login)
	}
}
