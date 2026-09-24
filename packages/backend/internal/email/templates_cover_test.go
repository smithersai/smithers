package email

import (
	"errors"
	"html/template"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTemplates_Cov_RenderExecuteErrors(t *testing.T) {
	tests := []struct {
		name    string
		replace func(templateExecutor) func()
		render  func() error
		wantErr string
	}{
		{
			name: "verification html",
			replace: func(tpl templateExecutor) func() {
				original := parsedVerificationHTML
				parsedVerificationHTML = tpl
				return func() { parsedVerificationHTML = original }
			},
			render: func() error {
				_, _, err := RenderVerificationEmail(VerificationTemplateData{
					VerifyURL: "https://smithers.sh/verify?token=abc",
					Email:     "user@example.com",
				})
				return err
			},
			wantErr: "email: render verification HTML",
		},
		{
			name: "verification text",
			replace: func(tpl templateExecutor) func() {
				original := parsedVerificationText
				parsedVerificationText = tpl
				return func() { parsedVerificationText = original }
			},
			render: func() error {
				_, _, err := RenderVerificationEmail(VerificationTemplateData{
					VerifyURL: "https://smithers.sh/verify?token=abc",
					Email:     "user@example.com",
				})
				return err
			},
			wantErr: "email: render verification text",
		},
		{
			name: "mention html",
			replace: func(tpl templateExecutor) func() {
				original := parsedMentionHTML
				parsedMentionHTML = tpl
				return func() { parsedMentionHTML = original }
			},
			render: func() error {
				_, _, err := RenderMentionEmail(MentionTemplateData{
					Username: "alice",
					Subject:  "Issue #42",
					Snippet:  "please review",
				})
				return err
			},
			wantErr: "email: render mention HTML",
		},
		{
			name: "mention text",
			replace: func(tpl templateExecutor) func() {
				original := parsedMentionText
				parsedMentionText = tpl
				return func() { parsedMentionText = original }
			},
			render: func() error {
				_, _, err := RenderMentionEmail(MentionTemplateData{
					Username: "alice",
					Subject:  "Issue #42",
					Snippet:  "please review",
				})
				return err
			},
			wantErr: "email: render mention text",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restore := tt.replace(templatesCovFailingTemplate())
			defer restore()

			err := tt.render()

			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
			assert.Contains(t, err.Error(), "boom")
		})
	}
}

func templatesCovFailingTemplate() *template.Template {
	return template.Must(template.New("failing").Funcs(template.FuncMap{
		"fail": func() (string, error) {
			return "", errors.New("boom")
		},
	}).Parse(`{{fail}}`))
}
