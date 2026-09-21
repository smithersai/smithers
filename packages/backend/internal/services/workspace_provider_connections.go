package services

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// workspaceProviderBinding is operation-scoped. Only egress carries credentials;
// environment and files contain public account metadata and placeholders.
type workspaceProviderBinding struct {
	environment AgentEnvironmentProvisioningConfig
	egress      *sandbox.EgressProxyPolicy
	files       map[string]sandbox.SandboxFile
}

func (s *WorkspaceService) resolveWorkspaceProviderBindings(ctx context.Context, workspace db.Workspace) (*workspaceProviderBinding, error) {
	binding := &workspaceProviderBinding{files: map[string]sandbox.SandboxFile{}}
	var err error
	binding.egress, err = s.workspaceEgressProxy(ctx, workspace.RepositoryID)
	if err != nil {
		return nil, err
	}
	if s.agentEnvironment != nil {
		binding.environment, err = s.agentEnvironment.LoadForProvisioning(ctx, workspace.RepositoryID)
		if err != nil {
			return nil, pkgerrors.Internal("load agent environment for workspace setup")
		}
	}
	// Copy slices before adding runtime values; providers may cache their config.
	binding.environment.Env = slices.Clone(binding.environment.Env)
	binding.environment.ProxyBound = slices.Clone(binding.environment.ProxyBound)
	// Choose from repository runtime credentials before adding subscriptions
	// or platform fallbacks. A setup-only secret is deliberately not usable by
	// a long-running coding host and still shadows the same provider fallback.
	model := workspaceCodingModel(binding.availableProviderNames(), "")
	if s.providerConnections != nil && workspace.Kind != "agent" {
		for _, provider := range []string{ProviderConnectionProviderCodex, ProviderConnectionProviderClaude} {
			// Explicit repository-admin API-key secrets win over subscriptions, which
			// in turn replace platform credentials. Check the repository config, not
			// the merged proxy policy, so a platform key cannot mask a subscription.
			key := "OPENAI_API_KEY"
			if provider == ProviderConnectionProviderClaude {
				key = "ANTHROPIC_API_KEY"
			}
			if workspaceDeclaresProvider(binding.environment, key) {
				continue
			}
			resolved, err := s.providerConnections.ResolveForRun(ctx, workspace.UserID, workspace.RepositoryID, provider)
			if err != nil {
				return nil, pkgerrors.Internal("resolve workspace provider connection")
			}
			if resolved == nil {
				continue
			}
			switch provider {
			case ProviderConnectionProviderCodex:
				binding.bind(CodexProxySecret(resolved.AccessToken))
				binding.setEnv("CODEX_HOME", codexHomeGuestPath)
				binding.setEnv("SMITHERS_OPENAI_AUTH", "chatgpt")
				binding.files[codexAuthGuestPath] = sandbox.SandboxFile{Content: string(CodexGuestAuthJSON(resolved.AccountID, resolved.AccountEmail, resolved.Plan, time.Now()))}
			case ProviderConnectionProviderClaude:
				binding.egress.Secrets = slices.DeleteFunc(slices.Clone(binding.egress.Secrets), func(secret sandbox.EgressProxySecret) bool { return secret.Name == key })
				binding.environment.Env = slices.DeleteFunc(binding.environment.Env, func(v AgentEnvironmentVariable) bool { return v.Name == key })
				binding.environment.ProxyBound = slices.DeleteFunc(binding.environment.ProxyBound, func(name string) bool { return name == key })
				for _, secret := range ClaudeProxySecrets(resolved.AccessToken) {
					binding.bind(secret)
				}
			}
		}
	}
	if s.providerBootstrap && workspace.RepositoryID > 0 && workspace.UserID > 0 && workspace.Kind != "agent" {
		if model == "" {
			model = workspaceCodingModel(binding.availableProviderNames(), "")
		}
		for _, key := range AgentProviderCredentialEnvNames {
			if workspaceDeclaresProvider(binding.environment, key) {
				continue
			}
			if secret, ok := ProviderCredentialEgressSecret(key, s.platformProviderEnv[key]); ok {
				binding.bind(secret)
			}
		}
		if model == "" {
			model = workspaceCodingModel(binding.availableProviderNames(), s.codingDefaultModel)
		}
		present := slices.ContainsFunc(binding.environment.Env, func(v AgentEnvironmentVariable) bool { return v.Name == "SMITHERS_CODING_IMPLEMENT_MODEL" })
		// Preserve an unavailable explicit deployment pin as a blank model, so
		// old-box fallback cannot silently switch to a different provider.
		if !present && (model != "" || s.codingDefaultModel != "") {
			binding.setEnv("SMITHERS_CODING_IMPLEMENT_MODEL", model)
		}
	}
	if err := binding.egress.Validate(); err != nil {
		return nil, pkgerrors.Internal("invalid workspace provider binding")
	}
	return binding, nil
}

func workspaceProviderFamily(name string) []string {
	switch name {
	case "OPENAI_API_KEY", "OPENAI_CODEX_ACCESS_TOKEN":
		return []string{"OPENAI_API_KEY", "OPENAI_CODEX_ACCESS_TOKEN"}
	case "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN":
		return []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"}
	default:
		return []string{name}
	}
}

func workspaceDeclaresProvider(config AgentEnvironmentProvisioningConfig, key string) bool {
	for _, name := range workspaceProviderFamily(key) {
		if _, ok := config.Secrets[name]; ok {
			return true
		}
		if slices.Contains(config.ProxyBound, name) || slices.ContainsFunc(config.Env, func(v AgentEnvironmentVariable) bool { return v.Name == name }) {
			return true
		}
	}
	return false
}

func (b *workspaceProviderBinding) availableProviderNames() map[string]bool {
	names := map[string]bool{}
	for _, secret := range b.egress.Secrets {
		if secret.Value != sandbox.EgressProxyPlaceholder(secret.Name) && secret.Value != "[redacted]" && IsUsableProviderCredential(secret.Value) && slices.Contains(b.environment.ProxyBound, secret.Name) {
			names[secret.Name] = true
		}
	}
	for _, env := range b.environment.Env {
		if env.Value != sandbox.EgressProxyPlaceholder(env.Name) && IsUsableProviderCredential(env.Value) {
			names[env.Name] = true
		}
	}
	return names
}

// These defaults are already present in the current native model catalog and
// deployed app: DeferredTools/ReviewLint (Luna), ModelCatalog (Sonnet), and the
// Worker recommendation + Cerebras integration test (gpt-oss). A deployment can
// pin a different model without adding a repository setting. Never probe or
// silently retry a failed completion against a different provider.
var workspaceCodingModels = []struct {
	Provider, Model string
	Keys            []string
}{
	{"openai", "gpt-5.6-luna", []string{"OPENAI_CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"}},
	{"anthropic", "claude-sonnet-4-6", []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"}},
	{"cerebras", "gpt-oss-120b", []string{"CEREBRAS_API_KEY"}},
}

func workspaceCodingModel(available map[string]bool, preferred string) string {
	provider, model, pinned := strings.Cut(preferred, ":")
	if preferred != "" && !pinned {
		return ""
	}
	for _, choice := range workspaceCodingModels {
		if pinned && (provider != choice.Provider || strings.TrimSpace(model) == "" || strings.ContainsAny(model, " \t\r\n:")) {
			continue
		}
		for _, key := range choice.Keys {
			if available[key] {
				if pinned {
					return preferred
				}
				return choice.Provider + ":" + choice.Model
			}
		}
	}
	return ""
}

// A pre-existing box may already have authorized proxy placeholders but no
// model. Deriving just that public model is safe during host start: it neither
// replaces the live egress proxy nor restarts an existing coding host.
func workspaceCodingModelFallbackScript() string {
	lines := []string{"if [ -z \"${SMITHERS_CODING_IMPLEMENT_MODEL+x}\" ]; then"}
	for _, choice := range workspaceCodingModels {
		for _, key := range choice.Keys {
			lines = append(lines, "if [ -z \"${SMITHERS_CODING_IMPLEMENT_MODEL+x}\" ]; then case \"${"+key+"-}\" in ''|placeholder*|changeme*|change-me*|replace-me*|todo*|unset*|example*|'<'*'>') ;; *) export SMITHERS_CODING_IMPLEMENT_MODEL="+shellQuote(choice.Provider+":"+choice.Model)+";; esac; fi")
		}
	}
	return strings.Join(append(lines, "fi"), "\n")
}

func (b *workspaceProviderBinding) setEnv(name, value string) {
	b.environment.Env = slices.DeleteFunc(b.environment.Env, func(v AgentEnvironmentVariable) bool { return v.Name == name })
	b.environment.Env = append(b.environment.Env, AgentEnvironmentVariable{Name: name, Value: value})
}

func (b *workspaceProviderBinding) bind(secret sandbox.EgressProxySecret) {
	b.egress.Secrets = mergeEgressSecrets(b.egress.Secrets, []sandbox.EgressProxySecret{secret})
	b.environment.Env = slices.DeleteFunc(b.environment.Env, func(v AgentEnvironmentVariable) bool { return v.Name == secret.Name })
	if !slices.Contains(b.environment.ProxyBound, secret.Name) {
		b.environment.ProxyBound = append(b.environment.ProxyBound, secret.Name)
	}
}

func (b *workspaceProviderBinding) apply(req *sandbox.CreateRequest) {
	if b == nil {
		return
	}
	req.EgressProxy = b.egress
	if req.Files == nil {
		req.Files = map[string]sandbox.SandboxFile{}
	}
	for path, file := range b.files {
		req.Files[path] = file
	}
}

func (s *WorkspaceService) prepareWorkspaceProviderFiles(ctx context.Context, vmID string, binding *workspaceProviderBinding) error {
	if _, codex := binding.files[codexAuthGuestPath]; !codex {
		return nil
	}
	// SandboxFile has no owner field. Set ownership after the bootstrap creates
	// developer, before setup or the coding host runs. The shared Codex home is
	// under /root, so its ancestor needs search permission (but no directory listing).
	client, ok := s.sandbox.(workspaceAgentEnvironmentVMClient)
	if !ok {
		return pkgerrors.Internal("workspace provider file setup unavailable")
	}
	response, err := client.Execute(ctx, vmID, sandbox.ExecRequest{
		Command:   "chmod o+x /root && chown " + shellQuote(defaultWorkspaceUser+":"+defaultWorkspaceUser) + " " + shellQuote(codexHomeGuestPath) + " " + shellQuote(codexAuthGuestPath) + " && chmod 700 " + shellQuote(codexHomeGuestPath) + " && chmod 600 " + shellQuote(codexAuthGuestPath),
		TimeoutMS: agentEnvironmentInt64Ptr(30_000),
	})
	if err != nil || !successfulExecStatus(response) {
		return pkgerrors.Internal("prepare workspace provider authentication")
	}
	return nil
}
