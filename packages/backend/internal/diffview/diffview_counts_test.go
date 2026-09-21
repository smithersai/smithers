package diffview

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Added/removed content lines whose text itself starts with "++" or "--" render
// as "+++.."/"---.." in the unified diff and previously collided with the file-
// header prefix skip, undercounting additions/deletions.
func TestBuildUnifiedPatchCountsPlusPlusAndMinusMinusContent(t *testing.T) {
	_, add, del, err := buildUnifiedPatch(repohost.FileDiff{Path: "f.txt"}, "context\n", "context\n++double plus\n")
	if err != nil {
		t.Fatal(err)
	}
	if add != 1 || del != 0 {
		t.Fatalf("added line starting with '++': add=%d del=%d, want 1/0", add, del)
	}

	_, add2, del2, err := buildUnifiedPatch(repohost.FileDiff{Path: "f.txt"}, "context\n--double minus\n", "context\n")
	if err != nil {
		t.Fatal(err)
	}
	if add2 != 0 || del2 != 1 {
		t.Fatalf("removed line starting with '--': add=%d del=%d, want 0/1", add2, del2)
	}
}
