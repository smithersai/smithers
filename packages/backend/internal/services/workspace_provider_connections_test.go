package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type workspaceProviderResolver struct {
	connections          map[string]*ResolvedProviderConnection
	calls                []string
	userID, repositoryID int64
	err                  error
}

func (r *workspaceProviderResolver) ResolveForRun(_ context.Context, userID, repositoryID int64, provider string) (*ResolvedProviderConnection, error) {
	r.calls = append(r.calls, provider)
	r.userID, r.repositoryID = userID, repositoryID
	return r.connections[provider], r.err
}

func TestWorkspaceProviderConnectionsProvisioning(t *testing.T) {
	for _, kind := range []string{"container", "vm"} {
		for _, path := range []string{"create", "snapshot", "fork", "resume"} {
			for _, provider := range []string{ProviderConnectionProviderCodex, ProviderConnectionProviderClaude, "both", "none", "platform"} {
				t.Run(kind+"/"+path+"/"+provider, func(t *testing.T) {
					ctx := context.Background()
					workspace := sampleDBWorkspace("ws-byok")
					workspace.Kind = kind
					workspace.UserID = 42
					resolver := &workspaceProviderResolver{connections: map[string]*ResolvedProviderConnection{}}
					if provider != "none" && provider != "platform" {
						for _, p := range []string{ProviderConnectionProviderCodex, ProviderConnectionProviderClaude} {
							if provider == p || provider == "both" {
								resolver.connections[p] = &ResolvedProviderConnection{Provider: p, AccessToken: "subscription-token-" + p, AccountID: "account-123"}
							}
						}
					}
					var policy *sandbox.EgressProxyPolicy
					files := map[string]string{}
					var commands []string
					captureFiles := func(staged map[string]sandbox.SandboxFile) {
						for path, file := range staged {
							files[path] = file.Content
						}
					}
					client := &mockWorkspaceSandboxVMClient{
						createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
							policy = req.EgressProxy
							captureFiles(req.Files)
							services, err := json.Marshal(req.Init)
							require.NoError(t, err)
							assert.NotContains(t, string(services), "subscription-token-")
							return sandbox.CreateResult{ID: "vm-byok"}, nil
						},
						forkVMFn: func(_ context.Context, _ string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
							policy = req.EgressProxy
							captureFiles(req.Files)
							return sandbox.CreateResult{ID: "vm-byok"}, nil
						},
						startVMFn: func(_ context.Context, _ string, req sandbox.StartRequest) (sandbox.StartResult, error) {
							policy = req.EgressProxy
							return sandbox.StartResult{ID: "vm-byok"}, nil
						},
						writeFileFn: func(_ context.Context, _, path string, req sandbox.WriteFileRequest) error {
							files[path] = req.Content
							return nil
						},
						execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
							commands = append(commands, req.Command)
							status := int32(0)
							return sandbox.ExecResult{StatusCode: &status}, nil
						},
					}
					options := []WorkspaceServiceOption{WithWorkspaceSandboxClient(client), WithWorkspaceEnvironmentImages(&stubEnvironmentImageResolver{image: nixTestImage(kind)})}
					if provider == "platform" {
						options = append(options, WithWorkspaceProviderBootstrap(map[string]string{"CEREBRAS_API_KEY": "platform-private-cerebras"}, ""))
					} else {
						options = append(options, WithWorkspaceProviderConnections(resolver))
					}
					service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, options...)
					var err error
					switch path {
					case "create":
						_, err = service.createWorkspaceVM(ctx, workspace, CreateWorkspaceSessionInput{UserID: 999})
					case "snapshot":
						_, err = service.createWorkspaceVMFromSnapshot(ctx, workspace, db.WorkspaceSnapshot{ID: "snapshot", SnapshotID: "disk"})
					case "fork":
						source := workspace
						source.ID = "source"
						source.VmID = "vm-source"
						_, err = service.forkWorkspaceVM(ctx, workspace, source)
					case "resume":
						workspace.VmID = "vm-byok"
						_, err = service.resumeWorkspaceVM(ctx, workspace)
					}
					require.NoError(t, err)
					if provider == "platform" {
						assert.Empty(t, resolver.calls)
					} else {
						assert.Equal(t, []string{ProviderConnectionProviderCodex, ProviderConnectionProviderClaude}, resolver.calls)
						assert.Equal(t, workspace.UserID, resolver.userID, "credentials belong to the workspace owner, not the caller")
						assert.Equal(t, workspace.RepositoryID, resolver.repositoryID)
					}
					require.NotNil(t, policy)
					profile := files[workspaceAgentEnvironmentProfilePath]
					if provider == "platform" {
						secret, _ := ProviderCredentialEgressSecret("CEREBRAS_API_KEY", "platform-private-cerebras")
						assert.Contains(t, policy.Secrets, secret)
						assert.Contains(t, profile, "export CEREBRAS_API_KEY='"+sandbox.EgressProxyPlaceholder("CEREBRAS_API_KEY")+"'")
						assert.Contains(t, profile, "export SMITHERS_CODING_IMPLEMENT_MODEL='cerebras:gpt-oss-120b'")
					}
					if resolver.connections[ProviderConnectionProviderCodex] != nil {
						assert.Contains(t, policy.Secrets, CodexProxySecret("subscription-token-codex"))
						assert.Contains(t, profile, "export CODEX_HOME='"+codexHomeGuestPath+"'")
						assert.Contains(t, profile, "export SMITHERS_OPENAI_AUTH='chatgpt'")
						var auth map[string]any
						require.NoError(t, json.Unmarshal([]byte(files[codexAuthGuestPath]), &auth))
						assert.Equal(t, "chatgpt", auth["auth_mode"])
						assert.Equal(t, sandbox.EgressProxyPlaceholder(codexAccessTokenEnvName), auth["tokens"].(map[string]any)["access_token"])
						assert.Contains(t, strings.Join(commands, "\n"), "chown 'developer:developer' '"+codexHomeGuestPath+"' '"+codexAuthGuestPath+"'")
					} else {
						assert.NotContains(t, files, codexAuthGuestPath)
						assert.NotContains(t, profile, "CODEX_HOME")
					}
					if resolver.connections[ProviderConnectionProviderClaude] != nil {
						for _, secret := range ClaudeProxySecrets("subscription-token-claude") {
							assert.Contains(t, policy.Secrets, secret)
							assert.Contains(t, profile, "export "+secret.Name+"='"+sandbox.EgressProxyPlaceholder(secret.Name)+"'")
						}
						assert.NotContains(t, policy.SecretNames(), "ANTHROPIC_API_KEY")
					}
					if provider == "none" {
						assert.Empty(t, policy.Secrets)
					}
					for path, content := range files {
						assert.NotContains(t, content, "subscription-token-", path)
						assert.NotContains(t, content, "platform-private-", path)
					}
					assert.NotContains(t, strings.Join(commands, "\n"), "subscription-token-")
					assert.NotContains(t, strings.Join(commands, "\n"), "platform-private-")
				})
			}
		}
	}
}

func TestWorkspaceProviderConnectionsRepositorySecretPrecedence(t *testing.T) {
	for _, bound := range []bool{true, false} {
		t.Run(map[bool]string{true: "proxy", false: "setup"}[bound], func(t *testing.T) {
			env := &boundSecretsAgentEnvironmentProvider{}
			config := &env.config
			for _, key := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
				if bound {
					config.ProxyBound = append(config.ProxyBound, key)
					env.bound = append(env.bound, sandbox.EgressProxySecret{Name: key, Value: "repo-key", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}})
				} else {
					if config.Secrets == nil {
						config.Secrets = map[string]string{}
					}
					config.Secrets[key] = "repo-key"
				}
			}
			resolver := &workspaceProviderResolver{err: errors.New("must not resolve a shadowed subscription")}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceProviderConnections(resolver))
			binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-explicit"))
			require.NoError(t, err)
			assert.Empty(t, resolver.calls)
			assert.Equal(t, env.bound, binding.egress.Secrets)
			assert.Empty(t, binding.files)
			assert.Equal(t, *config, binding.environment)
		})
	}
}

func TestWorkspaceProviderConnectionsClaudeReplacesPlatformKey(t *testing.T) {
	// The production loader currently returns repo bindings only. Model a
	// platform policy separately from the explicit repository config.
	env := &boundSecretsAgentEnvironmentProvider{bound: []sandbox.EgressProxySecret{{Name: "ANTHROPIC_API_KEY", Value: "platform-key", Hosts: []string{claudeAPIHost}, MatchHeaders: []string{"x-api-key"}}}}
	resolver := &workspaceProviderResolver{connections: map[string]*ResolvedProviderConnection{ProviderConnectionProviderClaude: {Provider: ProviderConnectionProviderClaude, AccessToken: "subscription-token"}}}
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceProviderConnections(resolver))
	binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-platform"))
	require.NoError(t, err)
	assert.ElementsMatch(t, ClaudeProxySecrets("subscription-token"), binding.egress.Secrets)
	profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
	require.NoError(t, err)
	assert.NotContains(t, profile, "ANTHROPIC_API_KEY")
	assert.NotContains(t, profile, "platform-key")
	assert.NotContains(t, profile, "subscription-token")
}

func TestWorkspaceProviderConnectionsNoConnectionPreservesRequest(t *testing.T) {
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceProviderConnections(&workspaceProviderResolver{}))
	req, err := service.buildWorkspaceVMRequest(context.Background(), "", nil, 101, "container")
	require.NoError(t, err)
	before, err := json.Marshal(req)
	require.NoError(t, err)
	binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-none"))
	require.NoError(t, err)
	binding.apply(&req)
	after, err := json.Marshal(req)
	require.NoError(t, err)
	assert.JSONEq(t, string(before), string(after))
}

func TestWorkspaceProviderConnectionsResolutionFailurePreventsBoot(t *testing.T) {
	resolver := &workspaceProviderResolver{err: errors.New("secret-token-in-upstream-error")}
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceProviderConnections(resolver), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Fatal("must not boot")
			return sandbox.CreateResult{}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			t.Fatal("must not resume")
			return sandbox.StartResult{}, nil
		},
	}))
	workspace := sampleDBWorkspace("ws-failure")
	_, err := service.createWorkspaceVM(context.Background(), workspace, CreateWorkspaceSessionInput{})
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret-token")
	_, err = service.resumeWorkspaceVM(context.Background(), workspace)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret-token")
}

func TestWorkspaceProviderConnectionsPrecedenceIsPerProvider(t *testing.T) {
	for _, key := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
		t.Run(key, func(t *testing.T) {
			env := &boundSecretsAgentEnvironmentProvider{bound: []sandbox.EgressProxySecret{{Name: key, Value: "repo-key", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}}}
			env.config.ProxyBound = []string{key}
			resolver := &workspaceProviderResolver{connections: map[string]*ResolvedProviderConnection{
				ProviderConnectionProviderCodex:  {Provider: ProviderConnectionProviderCodex, AccessToken: "codex-token"},
				ProviderConnectionProviderClaude: {Provider: ProviderConnectionProviderClaude, AccessToken: "claude-token"},
			}}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceAgentEnvironment(env), WithWorkspaceProviderConnections(resolver))
			binding, err := service.resolveWorkspaceProviderBindings(context.Background(), sampleDBWorkspace("ws-precedence"))
			require.NoError(t, err)
			assert.Contains(t, binding.egress.Secrets, env.bound[0])
			if key == "OPENAI_API_KEY" {
				assert.Equal(t, []string{ProviderConnectionProviderClaude}, resolver.calls)
				assert.NotContains(t, binding.files, codexAuthGuestPath)
				for _, secret := range ClaudeProxySecrets("claude-token") {
					assert.Contains(t, binding.egress.Secrets, secret)
				}
			} else {
				assert.Equal(t, []string{ProviderConnectionProviderCodex}, resolver.calls)
				assert.Contains(t, binding.egress.Secrets, CodexProxySecret("codex-token"))
				assert.Contains(t, binding.files, codexAuthGuestPath)
			}
		})
	}
}
