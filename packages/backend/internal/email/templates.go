package email

import (
	"bytes"
	"fmt"
	"html/template"
	"io"
	"strings"
	texttemplate "text/template"
)

// VerificationTemplateData holds the data for rendering a verification email.
type VerificationTemplateData struct {
	VerifyURL string
	Email     string
}

// MentionTemplateData holds the data for rendering a mention notification email.
type MentionTemplateData struct {
	Username string
	Subject  string
	Snippet  string
	URL      string
}

const verificationHTMLTemplate = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #333; font-size: 24px;">Smithers</h1>
  </div>
  <h2 style="color: #333;">Verify your email address</h2>
  <p>Click the button below to verify <strong>{{.Email}}</strong> on Smithers:</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{.VerifyURL}}" style="background-color: #6366f1; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600;">Verify Email</a>
  </div>
  <p style="color: #666; font-size: 14px;">Or copy and paste this URL into your browser:</p>
  <p style="color: #666; font-size: 14px; word-break: break-all;">{{.VerifyURL}}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">This link expires in 24 hours. If you did not request this verification, you can safely ignore this email.</p>
  <p style="color: #999; font-size: 12px;">&copy; Smithers &mdash; jj-native code hosting</p>
</body>
</html>`

const verificationTextTemplate = `Smithers — Verify your email address

Click the link below to verify {{.Email}} on Smithers:

{{.VerifyURL}}

This link expires in 24 hours. If you did not request this verification, you can safely ignore this email.

-- Smithers — jj-native code hosting`

const mentionHTMLTemplate = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #333; font-size: 24px;">Smithers</h1>
  </div>
  <h2 style="color: #333;">You were mentioned</h2>
  <p>Hi <strong>@{{.Username}}</strong>, you were mentioned in:</p>
  <div style="background: #f6f8fa; border-left: 4px solid #6366f1; padding: 12px 16px; margin: 20px 0; border-radius: 4px;">
    <p style="margin: 0 0 8px 0; font-weight: 600;">{{.Subject}}</p>
    <p style="margin: 0; color: #555;">{{.Snippet}}</p>
  </div>
  {{if .URL}}<p><a href="{{.URL}}" style="color: #6366f1; text-decoration: none;">View on Smithers &rarr;</a></p>{{end}}
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">&copy; Smithers &mdash; jj-native code hosting</p>
</body>
</html>`

const mentionTextTemplate = `Smithers — You were mentioned

Hi @{{.Username}}, you were mentioned in:

{{.Subject}}

{{.Snippet}}
{{if .URL}}
View on Smithers: {{.URL}}
{{end}}
-- Smithers — jj-native code hosting`

// HTML parts use html/template for contextual escaping. Plain-text parts use
// text/template: HTML escaping there would show entities to the reader and
// break multi-parameter URLs.
type templateExecutor interface {
	Execute(w io.Writer, data any) error
}

var (
	parsedVerificationHTML templateExecutor = template.Must(template.New("verification_html").Parse(verificationHTMLTemplate))
	parsedVerificationText templateExecutor = texttemplate.Must(texttemplate.New("verification_text").Parse(verificationTextTemplate))
	parsedMentionHTML      templateExecutor = template.Must(template.New("mention_html").Parse(mentionHTMLTemplate))
	parsedMentionText      templateExecutor = texttemplate.Must(texttemplate.New("mention_text").Parse(mentionTextTemplate))
)

// RenderVerificationEmail renders the verification email HTML and plain text bodies.
func RenderVerificationEmail(data VerificationTemplateData) (htmlBody string, textBody string, err error) {
	if data.VerifyURL == "" {
		return "", "", fmt.Errorf("email: verify URL is required")
	}

	var htmlBuf bytes.Buffer
	if err := parsedVerificationHTML.Execute(&htmlBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render verification HTML: %w", err)
	}

	var textBuf bytes.Buffer
	if err := parsedVerificationText.Execute(&textBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render verification text: %w", err)
	}

	return htmlBuf.String(), strings.TrimSpace(textBuf.String()), nil
}

// RenderMentionEmail renders the mention notification email HTML and plain text bodies.
func RenderMentionEmail(data MentionTemplateData) (htmlBody string, textBody string, err error) {
	if data.Subject == "" {
		return "", "", fmt.Errorf("email: mention subject is required")
	}

	var htmlBuf bytes.Buffer
	if err := parsedMentionHTML.Execute(&htmlBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render mention HTML: %w", err)
	}

	var textBuf bytes.Buffer
	if err := parsedMentionText.Execute(&textBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render mention text: %w", err)
	}

	return htmlBuf.String(), strings.TrimSpace(textBuf.String()), nil
}
