package worker

import (
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestCloneArgs(t *testing.T) {
	for _, tc := range []struct {
		name string
		spec sandbox.GitRepositorySpec
		want []string
	}{
		{
			name: "default clone is shallow",
			spec: sandbox.GitRepositorySpec{},
			want: []string{"clone", "--depth", "200", "--", "https://host/o/r.git", "/workspace"},
		},
		{
			name: "revision still selects the branch",
			spec: sandbox.GitRepositorySpec{Rev: "main"},
			want: []string{"clone", "--depth", "200", "--branch", "main", "--", "https://host/o/r.git", "/workspace"},
		},
		{
			name: "explicit depth overrides the default",
			spec: sandbox.GitRepositorySpec{Depth: 1},
			want: []string{"clone", "--depth", "1", "--", "https://host/o/r.git", "/workspace"},
		},
		{
			name: "opted-out repository clones every commit",
			spec: sandbox.GitRepositorySpec{Depth: sandbox.FullCloneDepth},
			want: []string{"clone", "--", "https://host/o/r.git", "/workspace"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := cloneArgs(tc.spec, "https://host/o/r.git", "/workspace")
			if strings.Join(got, " ") != strings.Join(tc.want, " ") {
				t.Fatalf("cloneArgs = %q, want %q", got, tc.want)
			}
		})
	}
}
