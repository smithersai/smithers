package services

import "testing"

func TestValidateSafeText(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{"plain", "hello world", false},
		{"empty", "", false},
		{"unicode ok", "héllo 🚀 世界", false},
		{"newlines and tabs ok", "line1\nline2\tend", false},
		{"nul byte", "bad\x00title", true},
		{"nul only", "\x00", true},
		{"invalid utf8 overlong", "bad\xc0\xae", true},
		{"invalid utf8 lone byte", "x\xff", true},
		{"invalid utf8 surrogate", "s\xed\xa0\x80", true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := validateSafeText("Issue", "title", tc.value)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected validation error for %q, got nil", tc.value)
				}
				if err.Status != 422 {
					t.Fatalf("expected 422 status, got %d", err.Status)
				}
				if len(err.Errors) != 1 || err.Errors[0].Field != "title" || err.Errors[0].Code != "invalid" {
					t.Fatalf("unexpected field error: %+v", err.Errors)
				}
			} else if err != nil {
				t.Fatalf("expected no error for %q, got %v", tc.value, err)
			}
		})
	}
}
