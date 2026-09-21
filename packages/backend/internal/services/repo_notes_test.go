package services

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestRepoService_NotesRefs(t *testing.T) {
	sha := strings.Repeat("a", 40)
	for _, tc := range []struct {
		name                string
		public, notes, fail bool
		viewer              *db.User
	}{
		{name: "public notes", public: true, notes: true},
		{name: "no notes", public: true},
		{name: "host failure", public: true, fail: true},
		{name: "private anonymous", notes: true},
		{name: "private non reader", notes: true, viewer: &db.User{ID: 999}},
		{name: "private owner", notes: true, viewer: &db.User{ID: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repository := testRepo(func(r *db.Repository) { r.IsPublic = tc.public; r.UserID.Int64 = 1; r.UserID.Valid = true })
			q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return repository, nil
			}}
			called := false
			rh := &mockRepoHostClient{listNotesRefsFn: func(_ context.Context, owner, repo string) ([]repohost.NotesRef, error) {
				called = true
				require.Equal(t, "alice", owner)
				require.Equal(t, "demo", repo)
				if tc.fail {
					return nil, fmt.Errorf("host unavailable")
				}
				if tc.notes {
					return []repohost.NotesRef{{Ref: "refs/notes/mythical", SHA: sha}}, nil
				}
				return []repohost.NotesRef{}, nil
			}}
			svc := NewRepoService(q, rh, "s1")
			refs, err := svc.ListGitRefs(context.Background(), tc.viewer, "alice", "demo")
			if !tc.public && (tc.viewer == nil || tc.viewer.ID != 1) {
				require.Equal(t, errors.Forbidden("permission denied"), err)
				require.False(t, called)
				_, contentErr := svc.GetRepoContents(context.Background(), tc.viewer, "alice", "demo", sha, "ab/cd")
				require.Equal(t, err, contentErr)
				return
			}
			require.True(t, called)
			if tc.fail {
				require.ErrorContains(t, err, "failed to list notes refs")
				return
			}
			require.NoError(t, err)
			if tc.notes {
				require.Equal(t, []GitRef{{Ref: "refs/notes/mythical", Object: GitRefObject{SHA: sha, Type: "commit"}}}, refs)
			} else {
				require.Empty(t, refs)
				require.NotNil(t, refs)
			}
		})
	}
}

func TestRepoService_ReadNoteBySHA(t *testing.T) {
	sha := strings.Repeat("a", 40)
	repository := testRepo(func(r *db.Repository) { r.IsPublic = true })
	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	rh := &mockRepoHostClient{getFileAtChangeFn: func(_ context.Context, owner, repo, ref, path string) (repohost.FileContent, error) {
		require.Equal(t, sha, ref)
		require.Equal(t, "ab/cd", path)
		return repohost.FileContent{Path: path, Content: "story", Encoding: "utf8"}, nil
	}, listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
		t.Fatal("file read must not enumerate a tree")
		return nil, nil
	}}
	result, err := NewRepoService(q, rh, "s1").GetRepoContents(context.Background(), nil, "alice", "demo", sha, "ab/cd")
	require.NoError(t, err)
	require.Equal(t, "story", result.Content)
}

func TestRepoService_NotesSurviveBookmarkCap(t *testing.T) {
	repository := testRepo(func(r *db.Repository) { r.IsPublic = true })
	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	bookmarks := make([]repohost.Bookmark, bookmarkPageSize*bookmarkMaxPages+1)
	for i := range bookmarks {
		bookmarks[i] = repohost.Bookmark{Name: fmt.Sprint(i), TargetCommitID: strings.Repeat("b", 40)}
	}
	rh := &mockRepoHostClient{
		listBookmarksFn: paginatedBookmarksFn(bookmarks),
		listNotesRefsFn: func(context.Context, string, string) ([]repohost.NotesRef, error) {
			return []repohost.NotesRef{{Ref: "refs/notes/mythical", SHA: strings.Repeat("a", 40)}}, nil
		},
	}
	refs, err := NewRepoService(q, rh, "s1").ListGitRefs(context.Background(), nil, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, refs, bookmarkPageSize*bookmarkMaxPages+1)
	require.Equal(t, "refs/notes/mythical", refs[len(refs)-1].Ref)
}
