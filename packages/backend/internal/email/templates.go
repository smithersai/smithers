package email

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"
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

// DigestItem represents a single notification in a digest email.
type DigestItem struct {
	Subject string
	Body    string
	URL     string
	Time    string
}

// DigestTemplateData holds the data for rendering a notification digest email.
type DigestTemplateData struct {
	Username       string
	Items          []DigestItem
	TotalCount     int
	SettingsURL    string
	UnsubscribeURL string
}

// SecurityAlertTemplateData holds the data for rendering a security alert email.
type SecurityAlertTemplateData struct {
	Username  string
	AlertType string // e.g. "new_login", "ssh_key_added", "token_created", "password_changed"
	Detail    string // e.g. "New sign-in from Chrome on macOS"
	IPAddress string
	Timestamp string
	ActionURL string // e.g. link to security settings
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

const digestHTMLTemplate = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #333; font-size: 24px;">Smithers</h1>
  </div>
  <h2 style="color: #333;">Notification Digest</h2>
  <p>Hi <strong>@{{.Username}}</strong>, here{{if eq .TotalCount 1}}'s your notification{{else}} are your {{.TotalCount}} notifications{{end}}:</p>
  {{range .Items}}
  <div style="background: #f6f8fa; border-left: 4px solid #6366f1; padding: 12px 16px; margin: 12px 0; border-radius: 4px;">
    <p style="margin: 0 0 4px 0; font-weight: 600;">{{.Subject}}</p>
    {{if .Body}}<p style="margin: 0 0 4px 0; color: #555;">{{.Body}}</p>{{end}}
    <p style="margin: 0; font-size: 12px; color: #888;">{{.Time}}{{if .URL}} &mdash; <a href="{{.URL}}" style="color: #6366f1; text-decoration: none;">View &rarr;</a>{{end}}</p>
  </div>
  {{end}}
  {{if .SettingsURL}}<p style="margin-top: 20px;"><a href="{{.SettingsURL}}" style="color: #6366f1; text-decoration: none;">Notification settings &rarr;</a></p>{{end}}
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">&copy; Smithers &mdash; jj-native code hosting</p>
  {{if .UnsubscribeURL}}<p style="color: #999; font-size: 12px;"><a href="{{.UnsubscribeURL}}" style="color: #999;">Unsubscribe</a> from digest emails.</p>{{end}}
</body>
</html>`

const digestTextTemplate = `Smithers — Notification Digest

Hi @{{.Username}}, here{{if eq .TotalCount 1}}'s your notification{{else}} are your {{.TotalCount}} notifications{{end}}:
{{range .Items}}
- {{.Subject}}
  {{if .Body}}{{.Body}}
  {{end}}{{.Time}}{{if .URL}} — {{.URL}}{{end}}
{{end}}
{{if .SettingsURL}}Notification settings: {{.SettingsURL}}{{end}}
{{if .UnsubscribeURL}}Unsubscribe: {{.UnsubscribeURL}}{{end}}
-- Smithers — jj-native code hosting`

const securityAlertHTMLTemplate = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #333; font-size: 24px;">Smithers</h1>
  </div>
  <h2 style="color: #d32f2f;">Security Alert</h2>
  <p>Hi <strong>@{{.Username}}</strong>, we detected the following activity on your account:</p>
  <div style="background: #fff3f3; border-left: 4px solid #d32f2f; padding: 12px 16px; margin: 20px 0; border-radius: 4px;">
    <p style="margin: 0 0 8px 0; font-weight: 600;">{{.Detail}}</p>
    {{if .IPAddress}}<p style="margin: 0 0 4px 0; color: #555; font-size: 14px;">IP Address: {{.IPAddress}}</p>{{end}}
    {{if .Timestamp}}<p style="margin: 0; color: #555; font-size: 14px;">Time: {{.Timestamp}}</p>{{end}}
  </div>
  {{if .ActionURL}}<p><a href="{{.ActionURL}}" style="color: #6366f1; text-decoration: none;">Review security settings &rarr;</a></p>{{end}}
  <p style="color: #666; font-size: 14px;">If this was you, no action is needed. If you did not perform this action, please secure your account immediately.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">&copy; Smithers &mdash; jj-native code hosting</p>
</body>
</html>`

const securityAlertTextTemplate = `Smithers — Security Alert

Hi @{{.Username}}, we detected the following activity on your account:

{{.Detail}}
{{if .IPAddress}}IP Address: {{.IPAddress}}{{end}}
{{if .Timestamp}}Time: {{.Timestamp}}{{end}}
{{if .ActionURL}}
Review security settings: {{.ActionURL}}
{{end}}
If this was you, no action is needed. If you did not perform this action, please secure your account immediately.

-- Smithers — jj-native code hosting`

var (
	parsedVerificationHTML  = template.Must(template.New("verification_html").Parse(verificationHTMLTemplate))
	parsedVerificationText  = template.Must(template.New("verification_text").Parse(verificationTextTemplate))
	parsedMentionHTML       = template.Must(template.New("mention_html").Parse(mentionHTMLTemplate))
	parsedMentionText       = template.Must(template.New("mention_text").Parse(mentionTextTemplate))
	parsedDigestHTML        = template.Must(template.New("digest_html").Parse(digestHTMLTemplate))
	parsedDigestText        = template.Must(template.New("digest_text").Parse(digestTextTemplate))
	parsedSecurityAlertHTML = template.Must(template.New("security_alert_html").Parse(securityAlertHTMLTemplate))
	parsedSecurityAlertText = template.Must(template.New("security_alert_text").Parse(securityAlertTextTemplate))
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

// RenderDigestEmail renders the notification digest email HTML and plain text bodies.
func RenderDigestEmail(data DigestTemplateData) (htmlBody string, textBody string, err error) {
	if len(data.Items) == 0 {
		return "", "", fmt.Errorf("email: digest requires at least one item")
	}
	if data.TotalCount == 0 {
		data.TotalCount = len(data.Items)
	}

	var htmlBuf bytes.Buffer
	if err := parsedDigestHTML.Execute(&htmlBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render digest HTML: %w", err)
	}

	var textBuf bytes.Buffer
	if err := parsedDigestText.Execute(&textBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render digest text: %w", err)
	}

	return htmlBuf.String(), strings.TrimSpace(textBuf.String()), nil
}

// RenderSecurityAlertEmail renders a security alert email HTML and plain text bodies.
func RenderSecurityAlertEmail(data SecurityAlertTemplateData) (htmlBody string, textBody string, err error) {
	if data.Detail == "" {
		return "", "", fmt.Errorf("email: security alert detail is required")
	}

	var htmlBuf bytes.Buffer
	if err := parsedSecurityAlertHTML.Execute(&htmlBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render security alert HTML: %w", err)
	}

	var textBuf bytes.Buffer
	if err := parsedSecurityAlertText.Execute(&textBuf, data); err != nil {
		return "", "", fmt.Errorf("email: render security alert text: %w", err)
	}

	return htmlBuf.String(), strings.TrimSpace(textBuf.String()), nil
}
