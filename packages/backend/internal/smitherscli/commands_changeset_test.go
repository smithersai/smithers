package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

// TestChangesetCreateSendsEveryMember drives `changeset create` through the
// real CLI and asserts the API receives every --member, whether repeated or
// comma-separated. Dropping one silently pins fewer repositories than the
// user asked the atomic changeset to land.
func TestChangesetCreateSendsEveryMember(t *testing.T) {
	for _, tc := range []struct {
		name string
		argv []string
		want []map[string]string
	}{
		{
			name: "repeated",
			argv: []string{"create", "--org", "acme", "--member", "api=abc", "--member", "web=def"},
			want: []map[string]string{{"repo": "api", "change_id": "abc"}, {"repo": "web", "change_id": "def"}},
		},
		{
			name: "comma-separated",
			argv: []string{"create", "--org", "acme", "--member", "api=abc, web=def"},
			want: []map[string]string{{"repo": "api", "change_id": "abc"}, {"repo": "web", "change_id": "def"}},
		},
		{
			name: "repeated and comma-separated",
			argv: []string{"create", "--org", "acme", "--member", "api=abc,web=def", "--member", "docs=ghi"},
			want: []map[string]string{{"repo": "api", "change_id": "abc"}, {"repo": "web", "change_id": "def"}, {"repo": "docs", "change_id": "ghi"}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got struct {
				Members []map[string]string `json:"members"`
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/orgs/acme/changesets" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
					w.WriteHeader(http.StatusNotFound)
					return
				}
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Errorf("decode body: %v", err)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"id":7,"state":"open","superproject":"acme/.superproject","members":[]}`)
			}))
			defer server.Close()
			commandsHTTPCovSetConfig(t, server.URL)

			out := commandsHTTPCovServe(t, changesetCommand(), tc.argv)
			if !strings.Contains(out, "Created changeset #7") {
				t.Fatalf("output = %q", out)
			}
			if !reflect.DeepEqual(got.Members, tc.want) {
				t.Fatalf("members sent = %v, want %v", got.Members, tc.want)
			}
		})
	}
}

func TestChangesetCreateRequiresAMember(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
	}))
	defer server.Close()
	commandsHTTPCovSetConfig(t, server.URL)

	var stdout bytes.Buffer
	err := changesetCommand().ServeWithOptions([]string{"create", "--org", "acme"}, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), "--member") {
		t.Fatalf("create without --member error = %v stdout=%s", err, stdout.String())
	}
}

func TestParseChangesetMembersRejectsMalformedEntries(t *testing.T) {
	for _, values := range [][]string{nil, {""}, {" , "}, {"api"}, {"=abc"}, {"api=abc", "web="}} {
		if _, err := parseChangesetMembers(values); err == nil {
			t.Errorf("parseChangesetMembers(%q) accepted malformed input", values)
		}
	}
}
