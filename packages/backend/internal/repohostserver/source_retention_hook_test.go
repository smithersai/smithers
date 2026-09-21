package repohostserver

import (
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"testing"
)

func TestImmutableSourceRetentionEmitsNoPushAutomation(t *testing.T) {
	sha := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	ref := repohost.WorkspaceSourceRef("0f8fad5b-d9cb-469f-a165-70867728950e", sha)
	before := map[string]string{"refs/heads/main": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	after := map[string]string{"refs/heads/main": before["refs/heads/main"], ref: sha}
	if got := pushHookPayloadsFromRefDiff(before, after, "owner", "repo", PushHookSender{}); len(got) != 0 {
		t.Fatalf("source retention emitted normal automation: %#v", got)
	}
}
