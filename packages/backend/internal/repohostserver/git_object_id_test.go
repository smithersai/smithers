package repohostserver

import "testing"

// Every value listGitRefs returns is used as a git revision or an update-ref
// target, so anything that is not a bare object id has to be rejected at the
// parse rather than handed to git as argv (run 11748).
func TestValidGitObjectID(t *testing.T) {
	valid := []string{
		"3698e5c6c03da66a35e328100725c179dfc95ce6",
		"0000000000000000000000000000000000000000",
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	}
	for _, id := range valid {
		if !validGitObjectID(id) {
			t.Fatalf("validGitObjectID(%q) = false, want true", id)
		}
	}

	invalid := []string{
		"",
		"main",
		"--upload-pack=touch /tmp/pwned",
		"3698e5c6c03da66a35e328100725c179dfc95ce",    // 39 characters
		"3698e5c6c03da66a35e328100725c179dfc95ce6f",  // 41 characters
		"3698E5C6C03DA66A35E328100725C179DFC95CE6",   // uppercase is not what git prints
		"thread '<unnamed>' (42240) panicked at cli", // the jj panic text from run 11748
	}
	for _, id := range invalid {
		if validGitObjectID(id) {
			t.Fatalf("validGitObjectID(%q) = true, want false", id)
		}
	}
}
