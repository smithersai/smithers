package services

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type storageSetCovQuerier struct {
	repo db.Repository
	err  error
	arg  db.GetRepoByOwnerAndLowerNameParams
}

func (q *storageSetCovQuerier) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	q.arg = arg
	return q.repo, q.err
}

func TestStorageSet_Cov_TemplateDerivation(t *testing.T) {
	got := BuildStorageSetResolverTemplate("https://user:pass@repo-host-s1.internal:8443/api", "s1")
	if got != "https://repo-host-%s.internal:8443/api" {
		t.Fatalf("template = %q", got)
	}
	for _, tc := range []struct {
		base   string
		active string
		want   string
	}{
		{"", "s1", ""},
		{"not a url", "s1", "not a url"},
		{"https://repo-host.internal", "s1", "https://repo-host.internal"},
		{"https://repo-host-s1.internal", "", "https://repo-host-s1.internal"},
	} {
		if got := BuildStorageSetResolverTemplate(tc.base, tc.active); got != tc.want {
			t.Fatalf("BuildStorageSetResolverTemplate(%q,%q) = %q, want %q", tc.base, tc.active, got, tc.want)
		}
	}
}

func TestStorageSet_Cov_ResolveURLBranches(t *testing.T) {
	q := &storageSetCovQuerier{repo: db.Repository{StorageSetID: "s2"}}
	resolver := NewDBStorageSetResolver(q, "https://repo-host-%s.internal")
	got, err := resolver.ResolveURL(context.Background(), "Alice", "Demo")
	if err != nil || got != "https://repo-host-s2.internal" || q.arg.Owner != "Alice" || q.arg.LowerName != "demo" {
		t.Fatalf("got=%q err=%v arg=%+v", got, err, q.arg)
	}

	q = &storageSetCovQuerier{repo: db.Repository{StorageSetID: "s2"}}
	got, err = NewDBStorageSetResolver(q, "https://static.internal").ResolveURL(context.Background(), "alice", "demo")
	if err != nil || got != "https://static.internal" {
		t.Fatalf("static got=%q err=%v", got, err)
	}

	for _, tc := range []struct {
		name string
		q    *storageSetCovQuerier
		tmpl string
		want string
	}{
		{name: "not found", q: &storageSetCovQuerier{err: pgx.ErrNoRows}, tmpl: "x", want: "not found"},
		{name: "lookup error", q: &storageSetCovQuerier{err: assertErr("db down")}, tmpl: "x", want: "failed to lookup"},
		{name: "missing storage", q: &storageSetCovQuerier{repo: db.Repository{}}, tmpl: "x", want: "no assigned storage set"},
		{name: "empty template", q: &storageSetCovQuerier{repo: db.Repository{StorageSetID: "s1"}}, tmpl: "", want: "template is empty"},
	} {
		_, err := NewDBStorageSetResolver(tc.q, tc.tmpl).ResolveURL(context.Background(), "alice", "demo")
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s err = %v, want %q", tc.name, err, tc.want)
		}
	}
}
