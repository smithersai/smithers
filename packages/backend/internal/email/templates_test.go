package email

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRenderVerificationEmail_IncludesSmithersBrandingAndVerifyURL(t *testing.T) {
	t.Parallel()

	html, text, err := RenderVerificationEmail(VerificationTemplateData{
		VerifyURL: "https://api.smithers.sh/user/emails/verify-token?token=abc123",
		Email:     "user@example.com",
	})

	require.NoError(t, err)

	// HTML assertions
	assert.Contains(t, html, "Smithers")
	assert.Contains(t, html, "Verify your email address")
	assert.Contains(t, html, "user@example.com")
	assert.Contains(t, html, "https://api.smithers.sh/user/emails/verify-token?token=abc123")
	assert.Contains(t, html, "Verify Email")
	assert.Contains(t, html, "jj-native code hosting")
	assert.Contains(t, html, "24 hours")

	// Text assertions
	assert.Contains(t, text, "Smithers")
	assert.Contains(t, text, "user@example.com")
	assert.Contains(t, text, "https://api.smithers.sh/user/emails/verify-token?token=abc123")
	assert.Contains(t, text, "24 hours")
}

func TestRenderVerificationEmail_RequiresVerifyURL(t *testing.T) {
	t.Parallel()

	_, _, err := RenderVerificationEmail(VerificationTemplateData{
		Email: "user@example.com",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "verify URL is required")
}

func TestRenderVerificationEmail_HTMLIsValidMarkup(t *testing.T) {
	t.Parallel()

	html, _, err := RenderVerificationEmail(VerificationTemplateData{
		VerifyURL: "https://smithers.sh/verify?token=xyz",
		Email:     "test@example.com",
	})

	require.NoError(t, err)
	assert.Contains(t, html, "<!DOCTYPE html>")
	assert.Contains(t, html, "</html>")
}

func TestRenderMentionEmail_IncludesSubjectAndSnippet(t *testing.T) {
	t.Parallel()

	html, text, err := RenderMentionEmail(MentionTemplateData{
		Username: "alice",
		Subject:  "Issue #42: Fix the login bug",
		Snippet:  "Hey @alice, can you take a look at this?",
		URL:      "https://smithers.sh/org/repo/issues/42",
	})

	require.NoError(t, err)

	// HTML assertions
	assert.Contains(t, html, "Smithers")
	assert.Contains(t, html, "You were mentioned")
	assert.Contains(t, html, "@alice")
	assert.Contains(t, html, "Issue #42: Fix the login bug")
	assert.Contains(t, html, "Hey @alice, can you take a look at this?")
	assert.Contains(t, html, "https://smithers.sh/org/repo/issues/42")
	assert.Contains(t, html, "jj-native code hosting")

	// Text assertions
	assert.Contains(t, text, "Smithers")
	assert.Contains(t, text, "@alice")
	assert.Contains(t, text, "Issue #42: Fix the login bug")
	assert.Contains(t, text, "Hey @alice, can you take a look at this?")
	assert.Contains(t, text, "https://smithers.sh/org/repo/issues/42")
}

func TestRenderMentionEmail_RequiresSubject(t *testing.T) {
	t.Parallel()

	_, _, err := RenderMentionEmail(MentionTemplateData{
		Username: "alice",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "mention subject is required")
}

func TestRenderMentionEmail_OptionalURL(t *testing.T) {
	t.Parallel()

	html, text, err := RenderMentionEmail(MentionTemplateData{
		Username: "bob",
		Subject:  "Comment on landing request",
		Snippet:  "Nice work @bob!",
		// No URL
	})

	require.NoError(t, err)
	assert.NotContains(t, html, "View on Smithers")
	assert.NotContains(t, text, "View on Smithers")
}

func TestRenderMentionEmail_HTMLEscapesInput(t *testing.T) {
	t.Parallel()

	html, _, err := RenderMentionEmail(MentionTemplateData{
		Username: "alice",
		Subject:  "Issue with <script>alert('xss')</script>",
		Snippet:  "Check this <b>bold</b> text",
	})

	require.NoError(t, err)
	// html/template should escape dangerous content
	assert.NotContains(t, html, "<script>")
	assert.Contains(t, html, "&lt;script&gt;")
}
