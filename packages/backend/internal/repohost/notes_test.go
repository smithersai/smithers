package repohost

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func notesPacket(s string) string { return fmt.Sprintf("%04x%s", len(s)+4, s) }
func notesAdvertisement(lines ...string) string {
	var out strings.Builder
	out.WriteString(notesPacket("# service=git-upload-pack\n") + "0000")
	for _, line := range lines {
		out.WriteString(notesPacket(line))
	}
	out.WriteString("0000")
	return out.String()
}

func TestClient_ListNotesRefs(t *testing.T) {
	sha := strings.Repeat("a", 40)
	for _, tc := range []struct {
		name, data string
		count      int
		bad        bool
	}{
		{"notes alongside heads and private retention refs", notesAdvertisement(sha+" HEAD\x00multi_ack\n", sha+" refs/heads/mythical\n", sha+" refs/notes/mythical\n", sha+" refs/smithers/workspaces/private/head\n"), 1, false},
		{"no notes", notesAdvertisement(sha + " refs/heads/main\n"), 0, false},
		{"empty repository", notesAdvertisement(), 0, false},
		{"truncated", notesAdvertisement()[:20], 0, true},
		{"bad oid", notesAdvertisement("bogus refs/notes/mythical\n"), 0, true},
		{"duplicate", notesAdvertisement(sha+" refs/notes/mythical\n", sha+" refs/notes/mythical\n"), 0, true},
		{"over byte cap", strings.Repeat("x", maxNotesAdvertisementBytes+1), 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/repos/alice/demo/git/info-refs", r.URL.Path)
				require.Equal(t, "git-upload-pack", r.URL.Query().Get("service"))
				require.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
				_, _ = w.Write([]byte(tc.data))
			}))
			defer server.Close()
			refs, err := NewClient(&StaticStorageSetResolver{URL: server.URL}, "secret").ListNotesRefs(context.Background(), "alice", "demo")
			if tc.bad {
				require.Error(t, err)
				if tc.name == "over byte cap" {
					require.ErrorContains(t, err, "ref advertisement exceeds")
				}
				require.Nil(t, refs)
				return
			}
			require.NoError(t, err)
			require.Len(t, refs, tc.count)
			if tc.count > 0 {
				require.Equal(t, NotesRef{Ref: "refs/notes/mythical", SHA: sha}, refs[0])
			}
		})
	}
}

func TestNotesRefCountBound(t *testing.T) {
	lines := make([]string, MaxNotesRefs+1)
	for i := range lines {
		lines[i] = strings.Repeat("a", 40) + fmt.Sprintf(" refs/notes/n%d\n", i)
	}
	refs, err := parseNotesAdvertisement([]byte(notesAdvertisement(lines[:MaxNotesRefs]...)))
	require.NoError(t, err)
	require.Len(t, refs, MaxNotesRefs)
	refs, err = parseNotesAdvertisement([]byte(notesAdvertisement(lines...)))
	require.ErrorContains(t, err, "notes refs exceed")
	require.Nil(t, refs)
}
