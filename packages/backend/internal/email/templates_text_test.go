package email

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTextBodiesAreNotHTMLEscaped(t *testing.T) {
	_, text, err := RenderMentionEmail(MentionTemplateData{
		Username: "o'neil",
		Subject:  `Fix <bug> & "stuff"`,
		Snippet:  "a < b",
		URL:      "https://x/a?b=1&c=2",
	})
	require.NoError(t, err)
	require.Contains(t, text, "@o'neil")
	require.Contains(t, text, `Fix <bug> & "stuff"`)
	require.Contains(t, text, "https://x/a?b=1&c=2")
	require.NotContains(t, text, "&amp;")

	_, text, err = RenderVerificationEmail(VerificationTemplateData{VerifyURL: "https://x/v?t=1&u=2", Email: "o'neil@x.com"})
	require.NoError(t, err)
	require.Contains(t, text, "https://x/v?t=1&u=2")
	require.Contains(t, text, "o'neil@x.com")
}
