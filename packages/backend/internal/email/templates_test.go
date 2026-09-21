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

// --- Digest template tests ---

func TestRenderDigestEmail_IncludesItemsAndBranding(t *testing.T) {
	t.Parallel()

	html, text, err := RenderDigestEmail(DigestTemplateData{
		Username:   "alice",
		TotalCount: 3,
		Items: []DigestItem{
			{Subject: "New comment on LR #42", Body: "Great work!", URL: "https://smithers.sh/org/repo/lr/42", Time: "2 hours ago"},
			{Subject: "Issue assigned to you", Body: "", URL: "https://smithers.sh/org/repo/issues/7", Time: "3 hours ago"},
			{Subject: "Build passed", Body: "All checks green", URL: "", Time: "4 hours ago"},
		},
		SettingsURL:    "https://smithers.sh/settings/notifications",
		UnsubscribeURL: "https://smithers.sh/unsubscribe?token=xyz",
	})

	require.NoError(t, err)

	// HTML assertions
	assert.Contains(t, html, "Smithers")
	assert.Contains(t, html, "Notification Digest")
	assert.Contains(t, html, "@alice")
	assert.Contains(t, html, "3 notifications")
	assert.Contains(t, html, "New comment on LR #42")
	assert.Contains(t, html, "Great work!")
	assert.Contains(t, html, "Issue assigned to you")
	assert.Contains(t, html, "Build passed")
	assert.Contains(t, html, "Unsubscribe")
	assert.Contains(t, html, "Notification settings")
	assert.Contains(t, html, "jj-native code hosting")

	// Text assertions
	assert.Contains(t, text, "Smithers")
	assert.Contains(t, text, "@alice")
	assert.Contains(t, text, "New comment on LR #42")
	assert.Contains(t, text, "Issue assigned to you")
	assert.Contains(t, text, "Build passed")
}

func TestRenderDigestEmail_SingleItem(t *testing.T) {
	t.Parallel()

	html, _, err := RenderDigestEmail(DigestTemplateData{
		Username:   "bob",
		TotalCount: 1,
		Items: []DigestItem{
			{Subject: "You have a new follower", Time: "1 hour ago"},
		},
	})

	require.NoError(t, err)
	assert.Contains(t, html, "your notification")
	assert.NotContains(t, html, "notifications")
}

func TestRenderDigestEmail_RequiresItems(t *testing.T) {
	t.Parallel()

	_, _, err := RenderDigestEmail(DigestTemplateData{
		Username: "alice",
		Items:    []DigestItem{},
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "at least one item")
}

func TestRenderDigestEmail_DefaultsTotalCount(t *testing.T) {
	t.Parallel()

	html, _, err := RenderDigestEmail(DigestTemplateData{
		Username: "alice",
		Items: []DigestItem{
			{Subject: "Item 1", Time: "now"},
			{Subject: "Item 2", Time: "now"},
		},
	})

	require.NoError(t, err)
	assert.Contains(t, html, "2 notifications")
}

func TestRenderDigestEmail_HTMLIsValidMarkup(t *testing.T) {
	t.Parallel()

	html, _, err := RenderDigestEmail(DigestTemplateData{
		Username: "alice",
		Items: []DigestItem{
			{Subject: "Test", Time: "now"},
		},
	})

	require.NoError(t, err)
	assert.Contains(t, html, "<!DOCTYPE html>")
	assert.Contains(t, html, "</html>")
}

// --- Security alert template tests ---

func TestRenderSecurityAlertEmail_IncludesAlertDetails(t *testing.T) {
	t.Parallel()

	html, text, err := RenderSecurityAlertEmail(SecurityAlertTemplateData{
		Username:  "alice",
		AlertType: "new_login",
		Detail:    "New sign-in from Chrome on macOS",
		IPAddress: "203.0.113.42",
		Timestamp: "2026-03-11 14:30 UTC",
		ActionURL: "https://smithers.sh/settings/security",
	})

	require.NoError(t, err)

	// HTML assertions
	assert.Contains(t, html, "Smithers")
	assert.Contains(t, html, "Security Alert")
	assert.Contains(t, html, "@alice")
	assert.Contains(t, html, "New sign-in from Chrome on macOS")
	assert.Contains(t, html, "203.0.113.42")
	assert.Contains(t, html, "2026-03-11 14:30 UTC")
	assert.Contains(t, html, "Review security settings")
	assert.Contains(t, html, "jj-native code hosting")

	// Text assertions
	assert.Contains(t, text, "Smithers")
	assert.Contains(t, text, "Security Alert")
	assert.Contains(t, text, "@alice")
	assert.Contains(t, text, "New sign-in from Chrome on macOS")
	assert.Contains(t, text, "203.0.113.42")
}

func TestRenderSecurityAlertEmail_RequiresDetail(t *testing.T) {
	t.Parallel()

	_, _, err := RenderSecurityAlertEmail(SecurityAlertTemplateData{
		Username:  "alice",
		AlertType: "new_login",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "detail is required")
}

func TestRenderSecurityAlertEmail_OptionalFields(t *testing.T) {
	t.Parallel()

	html, text, err := RenderSecurityAlertEmail(SecurityAlertTemplateData{
		Username: "bob",
		Detail:   "SSH key added to your account",
		// No IPAddress, Timestamp, or ActionURL
	})

	require.NoError(t, err)
	assert.Contains(t, html, "SSH key added to your account")
	assert.NotContains(t, html, "IP Address")
	assert.NotContains(t, text, "IP Address")
}

func TestRenderSecurityAlertEmail_HTMLEscapesInput(t *testing.T) {
	t.Parallel()

	html, _, err := RenderSecurityAlertEmail(SecurityAlertTemplateData{
		Username: "alice",
		Detail:   "Login from <script>alert('xss')</script>",
	})

	require.NoError(t, err)
	assert.NotContains(t, html, "<script>")
	assert.Contains(t, html, "&lt;script&gt;")
}

func TestRenderSecurityAlertEmail_HTMLIsValidMarkup(t *testing.T) {
	t.Parallel()

	html, _, err := RenderSecurityAlertEmail(SecurityAlertTemplateData{
		Username: "alice",
		Detail:   "Token created",
	})

	require.NoError(t, err)
	assert.Contains(t, html, "<!DOCTYPE html>")
	assert.Contains(t, html, "</html>")
}
