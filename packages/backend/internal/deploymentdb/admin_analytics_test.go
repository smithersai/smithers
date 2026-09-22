package deploymentdb

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestAnalyticsAllQueriesEmpty(t *testing.T) {
	q, _ := newQueries(t)
	ctx := context.Background()
	end := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	start := end.Truncate(24*time.Hour).AddDate(0, 0, -6)
	for _, includeSynthetic := range []bool{false, true} {
		t.Run("AnalyticsActivation", func(t *testing.T) {
			result, err := q.AnalyticsActivation(ctx, includeSynthetic)
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsAgents", func(t *testing.T) {
			result, err := q.AnalyticsAgents(ctx, AnalyticsAgentsParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsAgentsByStatus", func(t *testing.T) {
			result, err := q.AnalyticsAgentsByStatus(ctx, AnalyticsAgentsByStatusParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsGoldenSnapshots", func(t *testing.T) {
			result, err := q.AnalyticsGoldenSnapshots(ctx, AnalyticsGoldenSnapshotsParams{RangeStart: start, RangeEnd: end})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsImportFailures", func(t *testing.T) {
			result, err := q.AnalyticsImportFailures(ctx, AnalyticsImportFailuresParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsImportsByStatus", func(t *testing.T) {
			result, err := q.AnalyticsImportsByStatus(ctx, AnalyticsImportsByStatusParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsImportsFailedByStage", func(t *testing.T) {
			result, err := q.AnalyticsImportsFailedByStage(ctx, AnalyticsImportsFailedByStageParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsLanding", func(t *testing.T) {
			result, err := q.AnalyticsLanding(ctx, AnalyticsLandingParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsLandingByState", func(t *testing.T) {
			result, err := q.AnalyticsLandingByState(ctx, AnalyticsLandingByStateParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsLandingCycle", func(t *testing.T) {
			result, err := q.AnalyticsLandingCycle(ctx, AnalyticsLandingCycleParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsRepos", func(t *testing.T) {
			result, err := q.AnalyticsRepos(ctx, AnalyticsReposParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsSignupsByDay", func(t *testing.T) {
			result, err := q.AnalyticsSignupsByDay(ctx, AnalyticsSignupsByDayParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Len(t, result, 7)
			require.Equal(t, "2026-09-07", result[0].Day)
			require.Equal(t, "2026-09-13", result[6].Day)
			for _, day := range result {
				require.Zero(t, day.Count)
			}
		})
		t.Run("AnalyticsStuckAgents", func(t *testing.T) {
			result, err := q.AnalyticsStuckAgents(ctx, AnalyticsStuckAgentsParams{RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsTopRepos", func(t *testing.T) {
			result, err := q.AnalyticsTopRepos(ctx, AnalyticsTopReposParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsUsers", func(t *testing.T) {
			result, err := q.AnalyticsUsers(ctx, AnalyticsUsersParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsWorkspaceBoot", func(t *testing.T) {
			result, err := q.AnalyticsWorkspaceBoot(ctx, AnalyticsWorkspaceBootParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsWorkspaceFailures", func(t *testing.T) {
			result, err := q.AnalyticsWorkspaceFailures(ctx, AnalyticsWorkspaceFailuresParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
		t.Run("AnalyticsWorkspacesActive", func(t *testing.T) {
			result, err := q.AnalyticsWorkspacesActive(ctx, includeSynthetic)
			require.NoError(t, err)
			require.Zero(t, result)
		})
		t.Run("AnalyticsWorkspacesByDay", func(t *testing.T) {
			result, err := q.AnalyticsWorkspacesByDay(ctx, AnalyticsWorkspacesByDayParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Len(t, result, 7)
			require.Equal(t, "2026-09-07", result[0].Day)
			require.Equal(t, "2026-09-13", result[6].Day)
			for _, day := range result {
				require.Zero(t, day.Count)
			}
		})
		t.Run("AnalyticsWorkspacesByKindStatus", func(t *testing.T) {
			result, err := q.AnalyticsWorkspacesByKindStatus(ctx, AnalyticsWorkspacesByKindStatusParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: includeSynthetic})
			require.NoError(t, err)
			require.Empty(t, result)
		})
	}
}

func TestAnalyticsOwnershipAndDefinitions(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	end := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	start := end.Truncate(24*time.Hour).AddDate(0, 0, -6)
	recent := end.Add(-48 * time.Hour)
	old := end.AddDate(0, 0, -60)
	human := mustCreateUser(t, tx, "analytics-human")
	second := mustCreateUser(t, tx, "analytics-second")
	synthetic := mustCreateUser(t, tx, "analytics-synthetic")
	_, err := tx.Exec(ctx, "UPDATE users SET created_at=$1", recent)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "UPDATE users SET created_at=$1 WHERE id=$2", old, human)
	require.NoError(t, err)
	updated, err := q.AdminSetUserSynthetic(ctx, AdminSetUserSyntheticParams{LowerUsername: "analytics-synthetic", Synthetic: true})
	require.NoError(t, err)
	require.True(t, updated.IsSynthetic)
	repo := mustCreateRepo(t, tx, human, "human-repo")
	synRepo := mustCreateRepo(t, tx, synthetic, "synthetic-repo")
	var orgID, orgRepo int64
	err = tx.QueryRow(ctx, "INSERT INTO organizations (name,lower_name) VALUES ('analytics-org','analytics-org') RETURNING id").Scan(&orgID)
	require.NoError(t, err)
	err = tx.QueryRow(ctx, "INSERT INTO repositories (org_id, name, lower_name) VALUES ($1, 'org-repo', 'org-repo') RETURNING id", orgID).Scan(&orgRepo)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "UPDATE repositories SET created_at=$1", recent)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "INSERT INTO oauth_accounts (user_id,provider,provider_user_id) VALUES ($1,'github','h'),($1,'github','h2'),($2,'github','s'),($3,'other','other')", human, synthetic, second)
	require.NoError(t, err)
	// Both human and synthetic workspaces deliberately share the human repository.
	_, err = tx.Exec(ctx, `INSERT INTO workspaces (repository_id,user_id,is_fork,status,created_at,started_at,last_activity_at)
 VALUES ($1,$2,true,'running',$4,$4::timestamptz+interval '10 seconds',$5),
 ($1,$2,true,'stopped',$4,$4::timestamptz+interval '30 seconds',$5),
 ($1,$3,true,'running',$4,$4::timestamptz+interval '100 seconds',$5),
 ($1,$2,true,'running',$6,$6::timestamptz+interval '1 second',$5)`, repo, human, synthetic, recent, end.Add(-time.Hour), old)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO workspaces (repository_id,user_id,is_fork,status,created_at,last_activity_at)
 VALUES ($1,$2,true,'failed',$4,$4),($1,$3,true,'failed',$4,$4)`, repo, human, synthetic, recent)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO auth_sessions (session_key,user_id,username,expires_at,created_at)
 VALUES (gen_random_uuid(),$1,'analytics-second',$2::timestamptz+interval '1 day',$2::timestamptz-interval '1 hour')`, second, end)
	require.NoError(t, err)
	const completed = "00000000-0000-4000-8000-000000000001"
	const stuck = "00000000-0000-4000-8000-000000000002"
	_, err = tx.Exec(ctx, `INSERT INTO agent_sessions (id,repository_id,user_id,status,created_at,started_at,finished_at)
 VALUES ($1,$2,$3,'completed',$5,$5::timestamptz+interval '1 minute',$5::timestamptz+interval '3 minutes'),
 ($6,$2,$3,'active',$7,NULL,NULL),
 ('00000000-0000-4000-8000-000000000003',$2,$4,'active',$5,NULL,NULL),
 ('00000000-0000-4000-8000-000000000004',$2,$3,'active',$8::timestamptz-interval '2 hours',$8::timestamptz-interval '1 hour',NULL),
 ('00000000-0000-4000-8000-000000000005',$2,$3,'active',$8::timestamptz-interval '2 hours',NULL,NULL)`, completed, repo, human, synthetic, recent, stuck, old, end)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO landing_requests (repository_id,number,title,author_id,target_bookmark,state,agent_authored,author_agent_session_id,created_at,merged_at)
 VALUES ($1,1,'human merged',$2,'main','merged',true,$5,$4,$4::timestamptz+interval '1 hour'),
 ($1,2,'human open',$2,'main','open',true,$5,$4,NULL),
 ($1,3,'synthetic',$3,'main','merged',true,NULL,$4,$4::timestamptz+interval '3 hours'),
 ($1,4,'older merged',$2,'main','merged',false,NULL,$6,$4)`, repo, human, synthetic, recent, completed, old)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO changes (repository_id,change_id) VALUES ($1,'analytics-change')`, repo)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO change_revisions (repository_id,change_id,seq,commit_id,source,agent_session_id)
 VALUES ($1,'analytics-change',1,'commit-1','agent',$2),($1,'analytics-change',2,'commit-2','agent',$2),
 ($1,'analytics-change',3,'commit-3','push','00000000-0000-4000-8000-000000000004')`, repo, completed)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO import_jobs (user_id,github_owner,github_repo,status,stage,error,created_at)
 VALUES ($1,'owner','repo','failed','cloning_github','github repository not found',$3),
 ($2,'owner','repo','failed','creating_repo','synthetic failure',$3),
 ($1,'owner','repo','ready','provisioning_workspace','',$3)`, human, synthetic, recent)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO sandbox_golden_snapshots (kind,status,created_at) VALUES ('workspace','failed',$1)`, recent)
	require.NoError(t, err)
	for _, include := range []bool{false, true} {
		users, err := q.AnalyticsUsers(ctx, AnalyticsUsersParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		require.Equal(t, int64(3), users.Total)
		require.Equal(t, int64(2), users.Human)
		require.Equal(t, int64(1), users.Synthetic)
		wantActive, wantNew := int64(2), int64(1)
		if include {
			wantActive = 3
			wantNew = 2
		}
		require.Equal(t, wantActive, users.ActiveInRange)
		require.Equal(t, wantNew, users.NewInRange)
		signups, err := q.AnalyticsSignupsByDay(ctx, AnalyticsSignupsByDayParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		require.Len(t, signups, 7)
		require.Equal(t, wantNew, signups[4].Count)
		activation, err := q.AnalyticsActivation(ctx, include)
		require.NoError(t, err)
		wantActivated := int64(1)
		if include {
			wantActivated = 2
		}
		require.Equal(t, wantActivated, activation.GithubConnected)
		require.Equal(t, wantActivated, activation.WorkspaceBooted)
		require.Equal(t, wantActivated, activation.FirstLandingMerged)
		days, err := q.AnalyticsWorkspacesByDay(ctx, AnalyticsWorkspacesByDayParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		require.Len(t, days, 7)
		wantCount, wantSynthetic := int64(3), int64(0)
		if include {
			wantCount = 5
			wantSynthetic = 2
		}
		require.Equal(t, wantCount, days[4].Count)
		require.Equal(t, wantSynthetic, days[4].SyntheticCount)
		active, err := q.AnalyticsWorkspacesActive(ctx, include)
		require.NoError(t, err)
		wantRunning := int64(2)
		if include {
			wantRunning = 3
		}
		require.Equal(t, wantRunning, active)
		boot, err := q.AnalyticsWorkspaceBoot(ctx, AnalyticsWorkspaceBootParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		p50, p95 := 20.0, 29.0
		if include {
			p50 = 30
			p95 = 93
		}
		require.InDelta(t, p50, boot.BootP50Seconds, 0.001)
		require.InDelta(t, p95, boot.BootP95Seconds, 0.001)
		failures, err := q.AnalyticsWorkspaceFailures(ctx, AnalyticsWorkspaceFailuresParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		require.Len(t, failures, 1)
		require.Equal(t, wantActivated, failures[0].Count)
		require.Equal(t, "provisioning_failed", failures[0].Code)
		agents, err := q.AnalyticsAgents(ctx, AnalyticsAgentsParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		wantSessions := int64(3)
		if include {
			wantSessions = 4
		}
		require.Equal(t, wantSessions, agents.SessionsTotal)
		require.Equal(t, 120.0, agents.DurationP50Seconds)
		require.Equal(t, int64(1), agents.WithRevisions)
		require.Equal(t, int64(1), agents.WithLandingRequest)
		require.Equal(t, int64(1), agents.Merged)
		stuckRows, err := q.AnalyticsStuckAgents(ctx, AnalyticsStuckAgentsParams{RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		wantStuck := 2
		if include {
			wantStuck = 3
		}
		require.Len(t, stuckRows, wantStuck)
		require.Equal(t, stuck, stuckRows[0].ID)
		require.Equal(t, int64(60*24*3600), stuckRows[0].AgeSeconds)
		landing, err := q.AnalyticsLanding(ctx, AnalyticsLandingParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		rate := 0.5
		if include {
			rate = 2.0 / 3
		}
		require.InDelta(t, rate, landing.MergeRate, 0.0001)
		require.Equal(t, wantActivated, landing.AgentAuthoredMerged)
		cycle, err := q.AnalyticsLandingCycle(ctx, AnalyticsLandingCycleParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		wantCycle := (3600.0 + 58*86400) / 2
		if include {
			wantCycle = 10800
		}
		require.Equal(t, wantCycle, cycle)
		stages, err := q.AnalyticsImportsFailedByStage(ctx, AnalyticsImportsFailedByStageParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		require.Len(t, stages, int(wantActivated))
		require.Equal(t, "cloning_github", stages[0].Stage)
		repos, err := q.AnalyticsRepos(ctx, AnalyticsReposParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		wantRepos := int64(2)
		if include {
			wantRepos = 3
		}
		require.Equal(t, wantRepos, repos.Total)
		require.Equal(t, wantRepos, repos.CreatedInRange)
		top, err := q.AnalyticsTopRepos(ctx, AnalyticsTopReposParams{RangeStart: start, RangeEnd: end, IncludeSynthetic: include})
		require.NoError(t, err)
		require.Len(t, top, int(wantRepos))
		require.Equal(t, "human-repo", top[0].Name)
		require.Equal(t, wantCount, top[0].Workspaces)
		require.Equal(t, wantSessions, top[0].AgentSessions)
		snapshots, err := q.AnalyticsGoldenSnapshots(ctx, AnalyticsGoldenSnapshotsParams{RangeStart: start, RangeEnd: end})
		require.NoError(t, err)
		require.Len(t, snapshots, 1)
	}
	_ = synRepo
	_ = orgRepo
}

func TestAnalyticsUTCDayBoundaries(t *testing.T) {
	q, tx := newQueries(t)
	ctx := context.Background()
	_, err := tx.Exec(ctx, "SET LOCAL TIME ZONE 'America/Los_Angeles'")
	require.NoError(t, err)
	start := time.Date(2026, 3, 7, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name    string
		created time.Time
	}{
		{"boundary-before", start.Add(-time.Nanosecond * 1000)},
		{"boundary-start", start},
		{"boundary-end", end},
	} {
		id := mustCreateUser(t, tx, tc.name)
		_, err := tx.Exec(ctx, "UPDATE users SET created_at=$1 WHERE id=$2", tc.created, id)
		require.NoError(t, err)
	}
	result, err := q.AnalyticsSignupsByDay(ctx, AnalyticsSignupsByDayParams{RangeStart: start, RangeEnd: end})
	require.NoError(t, err)
	require.Len(t, result, 7)
	require.Equal(t, "2026-03-07", result[0].Day)
	require.Equal(t, int64(1), result[0].Count)
	for _, day := range result[1:] {
		require.Zero(t, day.Count)
	}
}
