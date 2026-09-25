package smitherscli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sync"
	"testing"
)

// fakeIssueLabelAssigneeServer models the API's issue label and assignee
// semantics: PATCH /issues/{n} replaces the label and assignee sets it is
// given, and POST /issues/{n}/labels appends to the label set.
type fakeIssueLabelAssigneeServer struct {
	mu        sync.Mutex
	title     string
	labels    []string
	assignees []string
}

func (f *fakeIssueLabelAssigneeServer) issueJSON() map[string]any {
	labels := make([]map[string]any, 0, len(f.labels))
	for _, name := range f.labels {
		labels = append(labels, map[string]any{"name": name})
	}
	assignees := make([]map[string]any, 0, len(f.assignees))
	for _, login := range f.assignees {
		assignees = append(assignees, map[string]any{"login": login})
	}
	return map[string]any{"number": 7, "title": f.title, "state": "open", "labels": labels, "assignees": assignees}
}

func (f *fakeIssueLabelAssigneeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues/7":
	case r.Method == http.MethodPatch && r.URL.Path == "/api/repos/alice/demo/issues/7":
		var body struct {
			Title     *string   `json:"title"`
			Labels    *[]string `json:"labels"`
			Assignees *[]string `json:"assignees"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if body.Title != nil {
			f.title = *body.Title
		}
		if body.Labels != nil {
			f.labels = append([]string(nil), (*body.Labels)...)
		}
		if body.Assignees != nil {
			f.assignees = append([]string(nil), (*body.Assignees)...)
		}
	case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/issues/7/labels":
		var body struct {
			Labels []string `json:"labels"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		for _, name := range body.Labels {
			if !slices.Contains(f.labels, name) {
				f.labels = append(f.labels, name)
			}
		}
		labels := make([]map[string]any, 0, len(f.labels))
		for _, name := range f.labels {
			labels = append(labels, map[string]any{"name": name})
		}
		_ = json.NewEncoder(w).Encode(labels)
		return
	default:
		http.Error(w, fmt.Sprintf(`{"message":"unexpected %s %s"}`, r.Method, r.URL.Path), http.StatusNotFound)
		return
	}
	_ = json.NewEncoder(w).Encode(f.issueJSON())
}

func TestIssueEditLabelAndAssigneeAddWithoutDroppingExisting(t *testing.T) {
	fake := &fakeIssueLabelAssigneeServer{
		title:     "Crash on launch",
		labels:    []string{"triage"},
		assignees: []string{"alice"},
	}
	server := httptest.NewServer(fake)
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	out := commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"edit", "7", "--repo", "alice/demo", "--title", "Crash on boot", "--label", "bug", "--assignee", "bob"})

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if want := []string{"triage", "bug"}; !reflect.DeepEqual(fake.labels, want) {
		t.Fatalf("labels after edit = %v, want %v", fake.labels, want)
	}
	if want := []string{"alice", "bob"}; !reflect.DeepEqual(fake.assignees, want) {
		t.Fatalf("assignees after edit = %v, want %v", fake.assignees, want)
	}
	if fake.title != "Crash on boot" {
		t.Fatalf("title after edit = %q", fake.title)
	}
	if want := "Updated issue #7: Crash on boot\n"; out != want {
		t.Fatalf("edit output = %q, want %q", out, want)
	}
}

func TestIssueEditAssigneeAlreadyAssignedIsNoop(t *testing.T) {
	fake := &fakeIssueLabelAssigneeServer{title: "Crash", assignees: []string{"alice", "bob"}}
	server := httptest.NewServer(fake)
	defer server.Close()
	commandsIssueWikiWorkflowCovSetConfig(t, server.URL)

	commandsIssueWikiWorkflowCovServe(t, issueCommand(), []string{"edit", "7", "--repo", "alice/demo", "--assignee", "Bob"})

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if want := []string{"alice", "bob"}; !reflect.DeepEqual(fake.assignees, want) {
		t.Fatalf("assignees after edit = %v, want %v", fake.assignees, want)
	}
}
