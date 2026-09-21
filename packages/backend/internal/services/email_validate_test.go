package services

import "testing"

// validateEmail must reject RFC-5322 display-name / angle-addr forms, because the
// caller (AddEmail) stores the value verbatim as the recipient. mail.ParseAddress
// alone accepts "Name <a@b>" and "<a@b>", so a bare-address check is required.
func TestValidateEmailRejectsNonBareForms(t *testing.T) {
	for _, ok := range []string{"a@b.com", "user.name+tag@example.co"} {
		if err := validateEmail(ok); err != nil {
			t.Fatalf("valid bare address %q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"",
		"not-an-email",
		"john doe <john@x.com>",
		"<john@x.com>",
		"a@b.com, c@d.com",
	} {
		if err := validateEmail(bad); err == nil {
			t.Fatalf("non-bare / invalid address %q was accepted", bad)
		}
	}
}
