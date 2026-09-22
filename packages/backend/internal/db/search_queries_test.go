package db

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSearchRepositoriesFTS_MatchesNameDescriptionTopicsAndRanks(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "search-repos-owner")

	repoByName, err := q.CreateRepo(context.Background(), CreateRepoParams{
		UserID:          pgtype.Int8{Int64: ownerID, Valid: true},
		Name:            "auth-core",
		LowerName:       "auth-core",
		Description:     "identity service",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	repoByDesc, err := q.CreateRepo(context.Background(), CreateRepoParams{
		UserID:          pgtype.Int8{Int64: ownerID, Valid: true},
		Name:            "identity",
		LowerName:       "identity",
		Description:     "auth checks live here",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	repoByTopic, err := q.CreateRepo(context.Background(), CreateRepoParams{
		UserID:          pgtype.Int8{Int64: ownerID, Valid: true},
		Name:            "service-tools",
		LowerName:       "service-tools",
		Description:     "utilities",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	_, err = q.UpdateRepo(context.Background(), UpdateRepoParams{
		ID:                         repoByTopic.ID,
		Name:                       repoByTopic.Name,
		LowerName:                  repoByTopic.LowerName,
		Description:                repoByTopic.Description,
		IsPublic:                   repoByTopic.IsPublic,
		DefaultBookmark:            repoByTopic.DefaultBookmark,
		Topics:                     []string{"auth", "infra"},
		LandingQueueMode:           repoByTopic.LandingQueueMode,
		LandingQueueRequiredChecks: repoByTopic.LandingQueueRequiredChecks,
	})
	require.NoError(t, err)

	results, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{
		Query:      "auth",
		ViewerID:   ownerID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, results, 3)

	assert.Equal(t, repoByName.ID, results[0].ID)
	assert.Equal(t, repoByDesc.ID, results[1].ID)
	assert.Equal(t, repoByTopic.ID, results[2].ID)

	total, err := q.CountSearchRepositoriesFTS(context.Background(), CountSearchRepositoriesFTSParams{
		Query:    "auth",
		ViewerID: ownerID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
}

func TestSearchRepositoriesFTS_RespectsVisibility(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "search-visibility-owner")
	orgOwnerID := mustCreateUser(t, pool, "search-visibility-orgowner")
	memberNoTeamID := mustCreateUser(t, pool, "search-vis-member-noteam")
	memberWithTeamID := mustCreateUser(t, pool, "search-vis-member-team")
	outsiderID := mustCreateUser(t, pool, "search-visibility-outsider")

	// Public user-owned repo (visible to everyone)
	_, err := q.CreateRepo(context.Background(), CreateRepoParams{
		UserID:          pgtype.Int8{Int64: ownerID, Valid: true},
		Name:            "public-auth",
		LowerName:       "public-auth",
		Description:     "public auth repo",
		IsPublic:        true,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	// Private user-owned repo (visible only to owner)
	_, err = q.CreateRepo(context.Background(), CreateRepoParams{
		UserID:          pgtype.Int8{Int64: ownerID, Valid: true},
		Name:            "private-auth",
		LowerName:       "private-auth",
		Description:     "private auth repo",
		IsPublic:        false,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	// Create org with private repo
	org, err := q.CreateOrganization(context.Background(), CreateOrganizationParams{
		Name:        "search-visibility-org",
		LowerName:   "search-visibility-org",
		Description: "",
		Visibility:  "private",
	})
	require.NoError(t, err)

	// Org owner
	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         orgOwnerID,
		Role:           "owner",
	})
	require.NoError(t, err)

	// Org member without team
	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         memberNoTeamID,
		Role:           "member",
	})
	require.NoError(t, err)

	// Org member with team
	_, err = q.AddOrgMember(context.Background(), AddOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         memberWithTeamID,
		Role:           "member",
	})
	require.NoError(t, err)

	orgRepo, err := q.CreateOrgRepo(context.Background(), CreateOrgRepoParams{
		OrgID:           pgtype.Int8{Int64: org.ID, Valid: true},
		Name:            "org-auth",
		LowerName:       "org-auth",
		Description:     "org private auth repo",
		IsPublic:        false,
		DefaultBookmark: "main",
	})
	require.NoError(t, err)

	// Create team with repo assignment for memberWithTeamID
	team, err := q.CreateTeam(context.Background(), CreateTeamParams{
		OrganizationID: org.ID,
		Name:           "search-vis-team",
		LowerName:      "search-vis-team",
		Description:    "",
		Permission:     "read",
	})
	require.NoError(t, err)
	_, err = q.AddTeamMember(context.Background(), AddTeamMemberParams{
		TeamID: team.ID,
		UserID: memberWithTeamID,
	})
	require.NoError(t, err)
	_, err = q.AddTeamRepo(context.Background(), AddTeamRepoParams{
		TeamID:       team.ID,
		RepositoryID: orgRepo.ID,
	})
	require.NoError(t, err)

	// Anonymous: sees only public repos
	anonymous, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{
		Query:      "auth",
		ViewerID:   0,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"public-auth"}, repoNames(anonymous))

	// Repo owner: sees own public + private
	ownerResults, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{
		Query:      "auth",
		ViewerID:   ownerID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Contains(t, repoNames(ownerResults), "private-auth")
	assert.Contains(t, repoNames(ownerResults), "public-auth")

	// Org owner: sees org private repo via org ownership role
	orgOwnerResults, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{
		Query:      "auth",
		ViewerID:   orgOwnerID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Contains(t, repoNames(orgOwnerResults), "org-auth",
		"org owner should see private org repo")

	// Org member WITHOUT team: should NOT see private org repo
	memberNoTeamResults, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{
		Query:      "auth",
		ViewerID:   memberNoTeamID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.NotContains(t, repoNames(memberNoTeamResults), "org-auth",
		"org member without team should not see private org repo")
	assert.Contains(t, repoNames(memberNoTeamResults), "public-auth")

	// Org member WITH team+repo assignment: should see private org repo
	memberWithTeamResults, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{
		Query:      "auth",
		ViewerID:   memberWithTeamID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Contains(t, repoNames(memberWithTeamResults), "org-auth",
		"org member with team+repo assignment should see private org repo")

	// Outsider: sees only public repos
	outsiderResults, err := q.SearchRepositoriesFTS(context.Background(), SearchRepositoriesFTSParams{
		Query:      "auth",
		ViewerID:   outsiderID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"public-auth"}, repoNames(outsiderResults))
}

func TestSearchIssuesFTS_MatchesTitleBodyAndSupportsStateLabelFilters(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "search-issues-user")
	repoID := mustCreateRepo(t, pool, userID, "search-issues-repo")

	bugLabel, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "bug",
		Color:        "#ff0000",
		Description:  "",
	})
	require.NoError(t, err)

	enhancementLabel, err := q.CreateLabel(context.Background(), CreateLabelParams{
		RepositoryID: repoID,
		Name:         "enhancement",
		Color:        "#00ff00",
		Description:  "",
	})
	require.NoError(t, err)

	titleMatch, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "bug in auth middleware",
		Body:         "repro details",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	bodyMatch, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "unexpected behavior",
		Body:         "body mentions auth bug conditions",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	closedIssue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "bug already fixed",
		Body:         "closed issue",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	otherLabelIssue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "bug in docs",
		Body:         "",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: titleMatch.ID, LabelID: bugLabel.ID})
	require.NoError(t, err)
	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: bodyMatch.ID, LabelID: bugLabel.ID})
	require.NoError(t, err)
	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: closedIssue.ID, LabelID: bugLabel.ID})
	require.NoError(t, err)
	_, err = q.AddIssueLabel(context.Background(), AddIssueLabelParams{IssueID: otherLabelIssue.ID, LabelID: enhancementLabel.ID})
	require.NoError(t, err)

	_, err = pool.Exec(context.Background(), `UPDATE issues SET state = 'closed' WHERE id = $1`, closedIssue.ID)
	require.NoError(t, err)

	results, err := q.SearchIssuesFTS(context.Background(), SearchIssuesFTSParams{
		Query:       "bug auth",
		ViewerID:    userID,
		StateFilter: "open",
		LabelFilter: "bug",
		PageSize:    10,
		PageOffset:  0,
	})
	require.NoError(t, err)
	require.Len(t, results, 2)

	assert.Equal(t, titleMatch.ID, results[0].ID)
	assert.Equal(t, bodyMatch.ID, results[1].ID)

	total, err := q.CountSearchIssuesFTS(context.Background(), CountSearchIssuesFTSParams{
		Query:       "bug auth",
		ViewerID:    userID,
		StateFilter: "open",
		LabelFilter: "bug",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)
}

func TestSearchUsersFTS_MatchesUsernameAndDisplayName(t *testing.T) {
	q, _ := newQueries(t)

	_, err := q.CreateUser(context.Background(), CreateUserParams{
		Username:      "alice",
		LowerUsername: "alice",
		Email:         pgtype.Text{String: "alice@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "alice@example.com", Valid: true},
		DisplayName:   "Alice A.",
	})
	require.NoError(t, err)

	_, err = q.CreateUser(context.Background(), CreateUserParams{
		Username:      "spectator",
		LowerUsername: "spectator",
		Email:         pgtype.Text{String: "spectator@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "spectator@example.com", Valid: true},
		DisplayName:   "Alice Cooper",
	})
	require.NoError(t, err)

	_, err = q.CreateUser(context.Background(), CreateUserParams{
		Username:      "bob",
		LowerUsername: "bob",
		Email:         pgtype.Text{String: "bob@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "bob@example.com", Valid: true},
		DisplayName:   "Bobby",
	})
	require.NoError(t, err)

	results, err := q.SearchUsersFTS(context.Background(), SearchUsersFTSParams{
		Query:      "alice",
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, results, 2)

	assert.Equal(t, "alice", strings.ToLower(results[0].Username))
	assert.Equal(t, "spectator", strings.ToLower(results[1].Username))

	total, err := q.CountSearchUsersFTS(context.Background(), "alice")
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)

	prefixResults, err := q.SearchUsersFTS(context.Background(), SearchUsersFTSParams{
		Query:      "spect",
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, prefixResults, 1)
	assert.Equal(t, "spectator", strings.ToLower(prefixResults[0].Username))

	prefixTotal, err := q.CountSearchUsersFTS(context.Background(), "spect")
	require.NoError(t, err)
	assert.Equal(t, int64(1), prefixTotal)
}

func TestSearchVectorTriggers_UpdateOnInsertAndUpdate(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "search-trigger-user")
	repoID := mustCreateRepo(t, pool, userID, "search-trigger-repo")

	issue, err := q.CreateIssue(context.Background(), CreateIssueParams{
		RepositoryID: repoID,
		Title:        "old issue title",
		Body:         "issue body",
		AuthorID:     userID,
		MilestoneID:  pgtype.Int8{},
	})
	require.NoError(t, err)

	var repoVectorBefore string
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM repositories WHERE id = $1`, repoID).Scan(&repoVectorBefore)
	require.NoError(t, err)
	assert.Contains(t, repoVectorBefore, "search")

	var issueVectorBefore string
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM issues WHERE id = $1`, issue.ID).Scan(&issueVectorBefore)
	require.NoError(t, err)
	assert.Contains(t, issueVectorBefore, "old")

	var userVectorBefore string
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM users WHERE id = $1`, userID).Scan(&userVectorBefore)
	require.NoError(t, err)
	assert.Contains(t, userVectorBefore, "search")

	_, err = pool.Exec(context.Background(), `UPDATE repositories SET description = 'fresh repository text' WHERE id = $1`, repoID)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE issues SET title = 'fresh issue title', body = 'fresh issue body' WHERE id = $1`, issue.ID)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE users SET display_name = 'Fresh Display Name' WHERE id = $1`, userID)
	require.NoError(t, err)

	var repoVectorAfter string
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM repositories WHERE id = $1`, repoID).Scan(&repoVectorAfter)
	require.NoError(t, err)
	assert.Contains(t, repoVectorAfter, "fresh")
	assert.NotContains(t, repoVectorAfter, "old")

	var issueVectorAfter string
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM issues WHERE id = $1`, issue.ID).Scan(&issueVectorAfter)
	require.NoError(t, err)
	assert.Contains(t, issueVectorAfter, "fresh")
	assert.NotContains(t, issueVectorAfter, "old")

	var userVectorAfter string
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM users WHERE id = $1`, userID).Scan(&userVectorAfter)
	require.NoError(t, err)
	assert.Contains(t, userVectorAfter, "fresh")
}

func TestSearchCodeFTS_MatchesFilePathAndContent(t *testing.T) {
	q, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "code-search-owner")
	repoID := mustCreateRepo(t, pool, ownerID, "code-search-repo")

	// Insert code search documents.
	_, err := q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repoID,
		FilePath:     "internal/auth/middleware.go",
		Content:      "func TokenAuth(next http.Handler) http.Handler { verifyBearerToken(r) }",
	})
	require.NoError(t, err)
	_, err = q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repoID,
		FilePath:     "internal/routes/user.go",
		Content:      "func handleGetUser(w http.ResponseWriter, r *http.Request) {}",
	})
	require.NoError(t, err)
	_, err = q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repoID,
		FilePath:     "README.md",
		Content:      "This is a readme file with no relevant content.",
	})
	require.NoError(t, err)

	results, err := q.SearchCodeFTS(context.Background(), SearchCodeFTSParams{
		Query:      "TokenAuth",
		ViewerID:   ownerID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	assert.Equal(t, "internal/auth/middleware.go", results[0].FilePath)
	assert.Contains(t, string(results[0].Snippet), "TokenAuth")

	count, err := q.CountSearchCodeFTS(context.Background(), CountSearchCodeFTSParams{
		Query:    "TokenAuth",
		ViewerID: ownerID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)

	// Search by content keyword that appears in a different file.
	handleResults, err := q.SearchCodeFTS(context.Background(), SearchCodeFTSParams{
		Query:      "handleGetUser",
		ViewerID:   ownerID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, handleResults, 1)
	assert.Equal(t, "internal/routes/user.go", handleResults[0].FilePath)
}

func TestSearchCodeFTS_RespectsVisibility(t *testing.T) {
	q, pool := newQueries(t)

	ownerID := mustCreateUser(t, pool, "code-vis-owner")
	outsiderID := mustCreateUser(t, pool, "code-vis-outsider")

	publicRepoID := mustCreateRepo(t, pool, ownerID, "code-public-repo")
	_, err := q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: publicRepoID,
		FilePath:     "main.go",
		Content:      "func main() { startServer() }",
	})
	require.NoError(t, err)

	// Create a private repo.
	privateRepoID := mustCreateRepo(t, pool, ownerID, "code-private-repo")
	mustExec(t, pool, `UPDATE repositories SET is_public = FALSE WHERE id = $1`, privateRepoID)
	_, err = q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: privateRepoID,
		FilePath:     "secret.go",
		Content:      "func startServer() { listenAndServe() }",
	})
	require.NoError(t, err)

	// Owner can see both.
	ownerResults, err := q.SearchCodeFTS(context.Background(), SearchCodeFTSParams{
		Query:      "startServer",
		ViewerID:   ownerID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Len(t, ownerResults, 2)

	// Outsider can only see public.
	outsiderResults, err := q.SearchCodeFTS(context.Background(), SearchCodeFTSParams{
		Query:      "startServer",
		ViewerID:   outsiderID,
		PageSize:   10,
		PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Len(t, outsiderResults, 1)
	assert.Equal(t, publicRepoID, outsiderResults[0].RepositoryID)

	outsiderCount, err := q.CountSearchCodeFTS(context.Background(), CountSearchCodeFTSParams{
		Query:    "startServer",
		ViewerID: outsiderID,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), outsiderCount)
}

func TestUpsertCodeSearchDocument(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "upsert-code-owner")
	repoID := mustCreateRepo(t, pool, ownerID, "upsert-code-repo")

	// 1. Insert new document
	doc, err := q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repoID,
		FilePath:     "main.go",
		Content:      "package main",
	})
	require.NoError(t, err)
	assert.Equal(t, repoID, doc.RepositoryID)
	assert.Equal(t, "main.go", doc.FilePath)
	assert.Equal(t, "package main", doc.Content)

	// Check search_vector trigger populated it
	var searchVector string
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM code_search_documents WHERE id = $1`, doc.ID).Scan(&searchVector)
	require.NoError(t, err)
	assert.Contains(t, searchVector, "main")

	// 2. Update existing document
	docUpdated, err := q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repoID,
		FilePath:     "main.go",
		Content:      "package main\n\nfunc main() {}",
	})
	require.NoError(t, err)
	assert.Equal(t, doc.ID, docUpdated.ID)
	assert.Equal(t, "package main\n\nfunc main() {}", docUpdated.Content)
	assert.True(t, docUpdated.UpdatedAt.After(doc.UpdatedAt) || docUpdated.UpdatedAt.Equal(doc.UpdatedAt))

	// Verify search vector updated
	err = pool.QueryRow(context.Background(), `SELECT search_vector::text FROM code_search_documents WHERE id = $1`, doc.ID).Scan(&searchVector)
	require.NoError(t, err)
	assert.Contains(t, searchVector, "func")
}

func TestDeleteCodeSearchDocumentsByRepo(t *testing.T) {
	q, pool := newQueries(t)
	ownerID := mustCreateUser(t, pool, "delete-code-owner")
	repo1ID := mustCreateRepo(t, pool, ownerID, "delete-code-repo-1")
	repo2ID := mustCreateRepo(t, pool, ownerID, "delete-code-repo-2")

	// Insert into repo 1
	_, err := q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repo1ID,
		FilePath:     "a.go",
		Content:      "a",
	})
	require.NoError(t, err)
	_, err = q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repo1ID,
		FilePath:     "b.go",
		Content:      "b",
	})
	require.NoError(t, err)

	// Insert into repo 2
	_, err = q.UpsertCodeSearchDocument(context.Background(), UpsertCodeSearchDocumentParams{
		RepositoryID: repo2ID,
		FilePath:     "c.go",
		Content:      "c",
	})
	require.NoError(t, err)

	// Delete from repo 1
	deletedCount, err := q.DeleteCodeSearchDocumentsByRepo(context.Background(), repo1ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), deletedCount)

	// Verify repo 1 is empty
	var count1 int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM code_search_documents WHERE repository_id = $1`, repo1ID).Scan(&count1)
	require.NoError(t, err)
	assert.Equal(t, int64(0), count1)

	// Verify repo 2 is unaffected
	var count2 int64
	err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM code_search_documents WHERE repository_id = $1`, repo2ID).Scan(&count2)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count2)
}

func repoNames(rows []SearchRepositoriesFTSRow) []string {
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, row.Name)
	}
	return names
}
