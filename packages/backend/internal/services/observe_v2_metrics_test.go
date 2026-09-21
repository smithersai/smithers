package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A real Prometheus-backed observer tests service seams without importing routes
// (which depend on services). Each test owns its collectors.
type observeV2Metrics struct {
	auth, lifecycle *prometheus.CounterVec
	landing         *prometheus.CounterVec
	active          *prometheus.GaugeVec
	suspend         prometheus.Histogram
}

func newObserveV2Metrics() *observeV2Metrics {
	return &observeV2Metrics{
		auth:      prometheus.NewCounterVec(prometheus.CounterOpts{Name: "test_auth_total", Help: "Auth outcomes"}, []string{"method", "result"}),
		lifecycle: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "test_lifecycle_total", Help: "Lifecycle outcomes"}, []string{"action", "result"}),
		landing:   prometheus.NewCounterVec(prometheus.CounterOpts{Name: "test_landing_total", Help: "Landing operations"}, []string{"operation"}),
		active:    prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "test_active", Help: "VMs"}, []string{"kind"}),
		suspend:   prometheus.NewHistogram(prometheus.HistogramOpts{Name: "test_suspend", Help: "Suspend duration"}),
	}
}
func (m *observeV2Metrics) ObserveAuthOperation(method, result string) {
	m.auth.WithLabelValues(method, result).Inc()
}
func (m *observeV2Metrics) ObserveWorkspaceLifecycle(action, result string) {
	m.lifecycle.WithLabelValues(action, result).Inc()
}
func (m *observeV2Metrics) ObserveLandingOperation(operation string) {
	m.landing.WithLabelValues(operation).Inc()
}
func (m *observeV2Metrics) ObserveSandboxVMCreate(string, string, float64) {}
func (m *observeV2Metrics) AddSandboxActiveVMs(kind string, n float64) {
	m.active.WithLabelValues(kind).Add(n)
}
func (m *observeV2Metrics) ObserveSandboxVMSuspend(seconds float64) { m.suspend.Observe(seconds) }

func TestObserveV2AuthFailureAndDenial(t *testing.T) {
	for _, tc := range []struct {
		name     string
		active   bool
		expected string
	}{
		{"disabled user", false, "denied"}, {"session database failure", true, "failure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newObserveV2Metrics()
			q := &mockAuthQuerier{
				consumeAuthNonceFn: func(context.Context, db.ConsumeAuthNonceParams) (int64, error) { return 1, nil },
				getUserByWalletAddressFn: func(context.Context, pgtype.Text) (db.User, error) {
					return db.User{ID: 1, IsActive: tc.active, ProhibitLogin: !tc.active}, nil
				},
				createAuthSessionFn: func(context.Context, db.CreateAuthSessionParams) (db.AuthSession, error) {
					return db.AuthSession{}, errors.New("database unavailable")
				},
			}
			s := NewAuthService(q, defaultAuthConfig(), mockKeyAuthVerifier{verifyFn: func(string, string, string) (string, string, error) {
				return "0x1234567890123456789012345678901234567890", "nonce", nil
			}}, nil, WithAuthMetrics(m))
			_, err := s.VerifyKeyAuth(context.Background(), "message", "signature")
			require.Error(t, err)
			require.Equal(t, 1.0, testutil.ToFloat64(m.auth.WithLabelValues("key", tc.expected)))
		})
	}
	m := newObserveV2Metrics()
	s := NewAuthService(nil, defaultAuthConfig(), nil, nil, WithAuthMetrics(m))
	_, err := s.CompleteGitHubOAuth(context.Background(), "code", "state", "verifier")
	require.Error(t, err)
	require.Equal(t, 1.0, testutil.ToFloat64(m.auth.WithLabelValues("github", "failure")))
}

func TestObserveV2WorkspaceLifecycle(t *testing.T) {
	for _, tc := range []struct {
		action string
		call   func(*WorkspaceService) error
	}{
		{"suspend", func(s *WorkspaceService) error {
			return s.suspendWorkspace(context.Background(), sampleDBWorkspace("ws-metrics"))
		}},
		{"resume", func(s *WorkspaceService) error {
			ws := sampleDBWorkspace("ws-metrics")
			ws.Status = "suspended"
			_, err := s.resumeWorkspaceVM(context.Background(), ws)
			return err
		}},
		{"stop", func(s *WorkspaceService) error {
			return s.destroyWorkspace(context.Background(), sampleDBWorkspace("ws-metrics"))
		}},
		{"fail", func(s *WorkspaceService) error {
			_, err := s.failWorkspace(context.Background(), sampleDBWorkspace("ws-metrics"), errors.New("boot failed"))
			return err
		}},
	} {
		t.Run(tc.action, func(t *testing.T) {
			m := newObserveV2Metrics()
			s := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}), WithWorkspaceSandboxMetrics(m))
			require.NoError(t, tc.call(s))
			require.Equal(t, 1.0, testutil.ToFloat64(m.lifecycle.WithLabelValues(tc.action, "success")))
			if tc.action == "suspend" {
				metric := &dto.Metric{}
				require.NoError(t, m.suspend.Write(metric))
				require.EqualValues(t, 1, metric.GetHistogram().GetSampleCount())
			}
		})
	}
	m := newObserveV2Metrics()
	s := newWorkspaceServiceForTests(nil, WithWorkspaceSandboxMetrics(m))
	_, err := s.CreateAgentWorkspace(context.Background(), CreateAgentWorkspaceInput{})
	require.Error(t, err)
	require.Equal(t, 1.0, testutil.ToFloat64(m.lifecycle.WithLabelValues("create", "failure")))
}

func TestObserveV2FailedAgentCreateCleanupDoesNotDecrement(t *testing.T) {
	for _, status := range []string{"pending", "failed", "done", "running"} {
		t.Run(status, func(t *testing.T) {
			m := newObserveV2Metrics()
			if status == "running" {
				m.AddSandboxActiveVMs("agent", 1)
			}
			deleted := false
			svc := &AgentService{
				sandboxMetrics: m,
				sandbox:        &mockSandboxVMClient{deleteVMFn: func(context.Context, string) error { deleted = true; return nil }},
				dispatchQ: &mockAgentDispatchQuerier{
					getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
						return db.WorkflowTask{ID: 33, WorkflowRunID: 900, WorkflowStepID: 44, Status: status, VmID: pgtype.Text{String: "vm-create-failed", Valid: true}}, nil
					},
					getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
						return db.WorkflowRun{ID: 900, Status: "failed"}, nil
					},
				},
			}
			svc.updateAgentWorkflowTerminalState(context.Background(), db.AgentSession{ID: "55555555-5555-5555-5555-555555555555", WorkflowRunID: pgtype.Int8{Int64: 900, Valid: true}}, "failed", "create failed")
			require.True(t, deleted)
			require.Zero(t, testutil.ToFloat64(m.active.WithLabelValues("agent")))
		})
	}
}

func TestObserveV2AgentWorkspaceNotDoubleCounted(t *testing.T) {
	m := newObserveV2Metrics()
	dispatch := &agentDispatch{svc: &AgentService{sandboxMetrics: m}, ctx: context.Background(), workspaceID: "workspace"}
	dispatch.recordSuccess()
	require.Zero(t, testutil.ToFloat64(m.active.WithLabelValues("agent")))
	dispatch.workspaceID = ""
	dispatch.recordSuccess()
	require.Equal(t, 1.0, testutil.ToFloat64(m.active.WithLabelValues("agent")))
}

func TestObserveV2WorkspaceForkCountsOneStart(t *testing.T) {
	m := newObserveV2Metrics()
	source := sampleDBWorkspace("source")
	q := &workspaceZRegistrarQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return source, nil
		},
	}}
	s := newWorkspaceServiceForTests(q, WithWorkspaceSandboxMetrics(m), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	workspace := sampleDBWorkspace("derived")
	workspace.IsFork = true
	workspace.VmID = ""
	got, err := s.createWorkspaceVM(context.Background(), workspace, CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo"})
	require.NoError(t, err)
	require.Equal(t, "vm-fork-123", got.VmID)
	require.Equal(t, 1.0, testutil.ToFloat64(m.lifecycle.WithLabelValues("start", "success")))
}
