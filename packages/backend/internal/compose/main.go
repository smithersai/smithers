package compose

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/sdk/trace"

	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/configsync"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	runnerpool "github.com/smithersai/smithers/packages/backend/internal/runner"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/internal/sseauth"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// newRevocationBus is a test seam: run() tests capture the bus to prove its
// listener is stopped on every exit path before the pool closes.
var newRevocationBus = revocation.NewBus

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		exitFn(exitCodeFor(err))
	}
}

func Run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	return run(ctx, args, stdout, stderr)
}

// RunWithExporter uses a deployment-provided trace exporter while retaining
// the shared redaction and sampling pipeline.
func RunWithExporter(ctx context.Context, args []string, stdout, stderr io.Writer, exporter trace.SpanExporter) error {
	return RunWithOptions(ctx, args, stdout, stderr, Options{TraceExporter: exporter})
}

func RunWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, adapters Options) error {
	return runWithOptions(ctx, args, stdout, stderr, runOptions{Options: adapters})
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	return runWithOptions(ctx, args, stdout, stderr, runOptions{})
}

// Start assembles the same product routes and workers as Run, then hands the
// live handler to a host that owns its HTTP listener. The call remains active
// until ctx is cancelled and the shared workers have drained.
func Start(ctx context.Context, args []string, stdout, stderr io.Writer, ready func(http.Handler)) error {
	return StartWithExporter(ctx, args, stdout, stderr, nil, ready)
}

func StartWithExporter(ctx context.Context, args []string, stdout, stderr io.Writer, exporter trace.SpanExporter, ready func(http.Handler)) error {
	return StartWithOptions(ctx, args, stdout, stderr, Options{TraceExporter: exporter}, ready)
}

func StartWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, adapters Options, ready func(http.Handler)) error {
	if ready == nil {
		return errors.New("compose: ready callback is required")
	}
	return runWithOptions(ctx, args, stdout, stderr, runOptions{Options: adapters, externalHTTP: true, ready: ready})
}

// Options are the only deployment seams in the common product assembly.
type Options struct {
	Role          Role
	TraceExporter trace.SpanExporter
	Blobs         blob.Store
	AgentLogs     services.AgentLogStore
	Repository    *repohost.Client
}

// Role selects only process responsibilities. Every role assembles the same
// product services and route definitions; deployment adapters still determine
// storage and execution behavior.
type Role string

const (
	RoleLocal        Role = "local"
	RoleHostedAPI    Role = "hosted_api"
	RoleHostedWorker Role = "hosted_worker"
)

func (role Role) valid() bool {
	return role == "" || role == RoleLocal || role == RoleHostedAPI || role == RoleHostedWorker
}

func (role Role) hosted() bool         { return role == RoleHostedAPI || role == RoleHostedWorker }
func (role Role) workers() bool        { return role != RoleHostedAPI }
func (role Role) clusterWorkers() bool { return role == RoleHostedWorker }
func (role Role) servesHTTP() bool     { return role != RoleHostedWorker }

type runOptions struct {
	Options
	externalHTTP bool
	ready        func(http.Handler)
}

func runWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, options runOptions) error {
	if !options.Role.valid() {
		return fmt.Errorf("unknown backend role %q", options.Role)
	}
	_ = stdout
	// `smithers-backend migrate [apply|status]` is a server-free schema
	// migration path: it applies the embedded product baseline and exits (non-zero on
	// failure) WITHOUT booting the HTTP server or loading/validating the full
	// server config. Dispatch before the server flag set so a stray positional
	// can never silently boot the API. See migrate.go.
	if len(args) > 0 && args[0] == "migrate" {
		return runMigrate(ctx, args[1:], stdout, stderr)
	}
	fs := flag.NewFlagSet("smithers-server", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "Path to config file")
	if err := fs.Parse(args); err != nil {
		return &flagParseError{err}
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		// slog not yet initialized; use a minimal stderr logger for bootstrap failures.
		slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("failed to load config", "error", err)
		return err
	}
	if err := config.ValidateServerStartup(cfg); err != nil {
		slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("invalid startup config", "error", err)
		return err
	}
	if options.Blobs == nil {
		if err := validateProductionBlobStore(os.Getenv("SMITHERS_ENV"), cfg.Blob); err != nil {
			slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("invalid production blob config", "error", err)
			return err
		}
	}

	// Initialize structured JSON logger from config and set as global default.
	serverLogger := middleware.NewServerLogger(stderr, cfg.Observability.LogLevel)
	slog.SetDefault(serverLogger)
	shutdownTimeout, err := shutdownTimeoutFn(cfg.Server)
	if err != nil {
		slog.Error("invalid server shutdown timeout", "value", cfg.Server.ShutdownTimeout, "error", err)
		return err
	}

	// ctx is supplied by the caller (context.Background() in prod; a cancelable
	// context in tests to drive the graceful-shutdown path).

	// Log startup configuration summary so operators can quickly identify
	// misconfigurations from pod logs without digging through error chains.
	logStartupConfig(cfg)

	smithersMetrics := routes.NewSmithersMetrics()

	// Initialize OpenTelemetry
	var tp *trace.TracerProvider
	if options.TraceExporter != nil {
		tp, err = observability.InitWithExporter(ctx, cfg.Observability, options.TraceExporter)
	} else {
		tp, err = otelInit(ctx, cfg.Observability)
	}
	if err != nil {
		slog.Warn("failed to initialize OpenTelemetry", "error", err)
		// Continue without tracing - don't fail startup
	}
	if tp != nil {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := tp.Shutdown(shutdownCtx); err != nil {
				slog.Warn("error shutting down tracer provider", "error", err)
			}
		}()
	}

	pool, err := database.NewPool(ctx, cfg.Database, smithersMetrics)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		return err
	}
	defer pool.Close()
	slog.Info("connected to database")

	provisioningEnforced := false
	if options.Role.hosted() {
		provisioningEnforcementRequested := false
		if raw := strings.TrimSpace(os.Getenv("SMITHERS_REPOSITORY_PROVISIONING_ENFORCE")); raw != "" {
			provisioningEnforcementRequested, err = strconv.ParseBool(raw)
			if err != nil {
				return fmt.Errorf("parse SMITHERS_REPOSITORY_PROVISIONING_ENFORCE: %w", err)
			}
		}
		provisioningEnforced, err = services.ConfigureRepositoryProvisioningEnforcement(ctx, pool, provisioningEnforcementRequested)
		if err != nil {
			return err
		}
		if provisioningEnforced {
			slog.Info("repository provisioning insert fence is enforced")
		} else {
			slog.Error("REPOSITORY PROVISIONING LEGACY INSERT COMPATIBILITY IS ENABLED",
				"remediation", "drain old API pods, set SMITHERS_REPOSITORY_PROVISIONING_ENFORCE=true, and restart one API pod")
		}
		legacyMutationFences, fenceErr := services.ConfigureLegacyMutationFences(ctx, pool, provisioningEnforcementRequested)
		if fenceErr != nil {
			return fenceErr
		}
		if legacyMutationFences.RepositoryStorageEnforced && legacyMutationFences.ReleaseDeletionEnabled {
			slog.Info("post-drain repository storage and release deletion protocols are enforced")
		} else {
			slog.Error("LEGACY REPOSITORY STORAGE AND RELEASE DELETION COMPATIBILITY IS ENABLED",
				"remediation", "drain old API pods, set SMITHERS_REPOSITORY_PROVISIONING_ENFORCE=true, and restart one API pod")
		}
	}

	// Start background DB pool stats collector (reports every 15s).
	poolStatsCtx, poolStatsCancel := context.WithCancel(ctx)
	defer poolStatsCancel()
	database.StartPoolStatsCollector(poolStatsCtx, pool, smithersMetrics, 15*time.Second)

	queries := db.New(pool)
	var runnerStaleSweeper *runnerpool.RunnerPool
	runtimeMetricsStore := services.NewRuntimeMetricsStore(queries, pool)
	if options.Role.hosted() {
		// These gauges read runner_pool and other fleet state, which is absent
		// from the single-owner product schema.
		services.StartRuntimeMetricsCollector(poolStatsCtx, runtimeMetricsStore, smithersMetrics, 15*time.Second)
		smithersMetrics.MustRegister(routes.NewCanaryStatusCollector(queries))
		inventoryMetrics := routes.NewAdminRuntimeMetricsCollector(queries)
		smithersMetrics.MustRegister(inventoryMetrics)
		inventoryMetrics.Start(poolStatsCtx)
	}
	if options.Role.clusterWorkers() {
		runnerStaleSweeper = runnerpool.NewRunnerPool(queries, runnerpool.Config{HeartbeatTimeout: 2 * time.Minute})
	}
	// One shared broker multiplexes every SSE stream type (notifications,
	// workspaces, workflow-run logs, agent sessions, releases) over a SINGLE
	// pooled connection, so SSE clients no longer consume one pgxpool slot each.
	//
	// MaxStreamsPerUser is a per-pod ABUSE cap, not a product/UX limit. Because a
	// stream no longer pins a DB connection, each one costs only a small buffered
	// Go channel, so this can be generous. The cap now spans ALL of a user's SSE
	// stream types at once (before the migration, notifications/workspace/workflow/
	// release ran through the uncapped per-client path and only agent sessions were
	// capped, at 5). It is deliberately set well above the busiest realistic
	// first-party client: the multi dashboard opens on the order of a dozen
	// concurrent live streams (notifications + several workspaces + a run or two +
	// an agent session), and SSE reconnect churn can transiently double-count a
	// stream while the server has not yet observed the old TCP close and run the
	// deferred Unsubscribe. 100 leaves comfortable headroom for that overlap while
	// still stopping a single user from opening unbounded streams on one pod.
	// (Pair stays on the uncapped per-client path — see routes/pair.go — so keyless
	// viewers are unaffected by this cap.)
	sseBroker := sse.NewBroker(pool)
	smithersMetrics.MustRegister(sseBroker.MetricsCollectors()...)
	sseBroker.MaxStreamsPerUser = 100
	if err := startSSEBroker(sseBroker, ctx); err != nil {
		slog.Error("failed to start SSE broker", "error", err)
		return err
	}
	defer sseBroker.Stop()

	// Revocation fan-out: one durable event per revocation plus NOTIFY, a
	// per-request check in the auth chain, and termination of every live SSE
	// stream, terminal, relay, and sandbox proxy the revocation covers.
	revocationBus := newRevocationBus(pool, queries)
	// Own the listener lifetime even when production supplies Background().
	// Register the stop immediately after Start so it runs before pool.Close
	// on startup errors as well as normal shutdown.
	revocationBusCtx, cancelRevocationBus := context.WithCancel(ctx)
	if err := revocationBus.Start(revocationBusCtx); err != nil {
		cancelRevocationBus()
		slog.Error("failed to start revocation bus", "error", err)
		return err
	}
	stopRevocationBus := func() {
		stopRevocationListener(cancelRevocationBus, revocationBus, revocationBusStopTimeout)
	}
	defer stopRevocationBus()
	revocationPublisher := revocation.NewDBPublisher(queries, revocationBus)
	routes.SetRevocationSource(revocationBus)
	revocationChecker = revocationBus

	activeStorageSetID := strings.TrimSpace(os.Getenv("ACTIVE_STORAGE_SET"))
	if activeStorageSetID == "" {
		activeStorageSetID = services.DefaultStorageSetID
	}
	storageSetResolverTemplate := services.BuildStorageSetResolverTemplate(cfg.RepoHost.URL, activeStorageSetID)

	storageSetResolver := services.NewDBStorageSetResolver(queries, storageSetResolverTemplate)
	repoHostClient := options.Repository
	if repoHostClient == nil {
		repoHostClient = repohost.NewClient(storageSetResolver, cfg.RepoHost.AuthToken, smithersMetrics)
	}

	webhookDispatcher := webhooks.NewDispatcher(queries)
	// Complete the dispatcher before any service captures it.
	linearClient := auth.NewLinearClient(cfg.Auth.LinearClientID, cfg.Auth.LinearClientSecret, cfg.Auth.LinearRedirectURL)
	linearIntegrationSvc := services.NewLinearIntegrationService(queries, linearClient, cfg.Auth.SessionSecret)
	linearEnabled := strings.TrimSpace(cfg.Auth.LinearClientID) != "" && strings.TrimSpace(cfg.Auth.LinearClientSecret) != ""
	var linearSyncSvc *services.LinearSyncService
	if linearEnabled {
		linearSyncSvc = services.NewLinearSyncServiceWithPool(queries, linearIntegrationSvc, pool)
		webhookDispatcher = webhooks.NewLinearDispatcher(webhookDispatcher, linearSyncSvc)
	}
	sshAuthzService := services.NewSSHAuthorizationService(queries)
	gitHTTPProxyService := services.NewGitHTTPProxyService(
		queries,
		sshAuthzService,
		repoHostClient,
		services.WithGitHTTPRunnerTaskTokenSecret(os.Getenv("SMITHERS_AGENT_TOKEN")),
	)
	orgService := services.NewOrgServiceWithPool(queries, pool, services.WithOrgWebhookDispatcher(webhookDispatcher))
	keyAuthVerifier, githubClient, err := buildAuthProviders(cfg.Auth)
	if err != nil {
		slog.Error("invalid auth provider configuration", "error", err)
		return err
	}
	authService := services.NewAuthService(queries, cfg.Auth, keyAuthVerifier, githubClient,
		services.WithAuthMetrics(smithersMetrics),
		// GitHub App refresh tokens are single-use. Serialize refreshes for one
		// account across ALL replicas, not just across goroutines in this one.
		services.WithAuthGitHubRefreshLocker(services.NewPgGitHubRefreshLocker(pool)),
	)
	sseTicketManager := sseauth.NewSSETicketManager(cfg.Auth.SessionSecret)
	auth0Configured := strings.TrimSpace(cfg.Auth.Auth0Domain) != "" &&
		strings.TrimSpace(cfg.Auth.Auth0ClientID) != "" &&
		strings.TrimSpace(cfg.Auth.Auth0ClientSecret) != ""
	if auth0Configured {
		auth0Client := auth.NewAuth0Client(
			cfg.Auth.Auth0Domain,
			cfg.Auth.Auth0ClientID,
			cfg.Auth.Auth0ClientSecret,
			cfg.Auth.Auth0RedirectURL,
			cfg.Auth.Auth0Connection,
			cfg.Auth.GitHubAPIBaseURL,
		)
		authService.SetAuth0Client(auth0Client)
	}
	userService := services.NewUserService(queries)
	userDeviceService := services.NewUserDeviceService(queries)

	// Initialize email transport from config.
	emailTransport, err := newEmailTransport(cfg.Email)
	if err != nil {
		slog.Error("failed to initialize email transport", "error", err)
		return err
	}
	// Wrap transport with rate limiting.
	emailTransport = email.NewRateLimitedTransport(emailTransport, email.RateLimitConfig{
		MaxPerSecond:           cfg.Email.RateLimitPerSecond,
		MaxPerRecipientPerHour: cfg.Email.RateLimitPerRecipientPerHr,
	})
	emailFrom := cfg.Email.From
	if emailFrom == "" {
		emailFrom = cfg.Email.SMTPFrom
	}
	if emailFrom == "" {
		emailFrom = cfg.Email.SESFrom
	}
	emailService := services.NewEmailService(queries, emailTransport, services.EmailServiceConfig{
		BaseURL: cfg.Email.BaseURL,
		From:    emailFrom,
	})
	// Public base URL used by browser redirects, Microsandbox VMs, and API callbacks.
	publicBaseURL := strings.TrimRight(cfg.Email.BaseURL, "/")
	if publicBaseURL == "" {
		publicBaseURL = fmt.Sprintf("http://localhost%s", cfg.Server.Addr)
	}
	agentAPIBaseURL := publicBaseURL + "/api"
	if apiBaseURL := strings.TrimSpace(os.Getenv("SMITHERS_API_BASE_URL")); apiBaseURL != "" {
		agentAPIBaseURL = strings.TrimRight(apiBaseURL, "/")
		publicBaseURL = config.ResolvePublicAPIOrigin(agentAPIBaseURL, publicBaseURL)
	}

	var stripeBillingClient services.StripeBillingClient
	if stripeSecretKey := strings.TrimSpace(cfg.Billing.StripeSecretKey); stripeSecretKey != "" {
		stripeBillingClient = services.NewStripeBillingClient(stripeSecretKey)
	}
	billingService := services.NewBillingService(queries, stripeBillingClient, services.BillingServiceConfig{
		BaseURL:                  publicBaseURL,
		PortalReturnURL:          cfg.Billing.PortalReturnURL,
		CheckoutSuccessURL:       cfg.Billing.CheckoutSuccessURL,
		CheckoutCancelURL:        cfg.Billing.CheckoutCancelURL,
		StripeWebhookSecret:      cfg.Billing.StripeWebhookSecret,
		PersonalMonthlyPriceID:   cfg.Billing.PersonalMonthlyPriceID,
		PersonalAnnualPriceID:    cfg.Billing.PersonalAnnualPriceID,
		ProMonthlyPriceID:        cfg.Billing.ProMonthlyPriceID,
		ProAnnualPriceID:         cfg.Billing.ProAnnualPriceID,
		MaxMonthlyPriceID:        cfg.Billing.MaxMonthlyPriceID,
		MaxAnnualPriceID:         cfg.Billing.MaxAnnualPriceID,
		TeamMonthlyPriceID:       cfg.Billing.TeamMonthlyPriceID,
		TeamAnnualPriceID:        cfg.Billing.TeamAnnualPriceID,
		EnterpriseMonthlyPriceID: cfg.Billing.EnterpriseMonthlyPriceID,
		EnterpriseAnnualPriceID:  cfg.Billing.EnterpriseAnnualPriceID,
	}, services.WithBillingEmailSender(emailService))
	// Keep per-seat Stripe subscription quantities in sync with org membership.
	orgService.SetSeatReconciler(billingService.ReconcileOrgSeats)
	repoService := services.NewRepoServiceWithPool(
		queries,
		repoHostClient,
		activeStorageSetID,
		pool,
		services.WithRepoWebhookDispatcher(webhookDispatcher),
		services.WithRepoBillingPolicy(billingService),
	)
	if provisioningEnforced {
		repoService.EnableDurableProvisioning()
	}
	repositoryStorageReconciler := services.NewRepositoryStorageOperationReconciler(pool, repoHostClient)
	repositoryProvisioningReconciler := services.NewRepositoryProvisioningReconciler(pool, repoHostClient)
	repoOwnershipFence := services.NewRepoOwnershipFence(pool)
	sshKeyService := services.NewSSHKeyService(queries)
	deployKeyService := services.NewDeployKeyService(queries)
	labelService := services.NewLabelService(queries)

	searchService := services.NewSearchService(queries)
	notificationService := services.NewNotificationServiceWithPool(queries, pool)

	mentionService := services.NewMentionService(queries, notificationService, services.WithMentionEmailSender(emailService))
	commitStatusService := services.NewCommitStatusService(queries, services.WithCommitStatusWebhookDispatcher(webhookDispatcher))
	gitHubBudgetTracker := services.NewBudgetTracker()
	repoConnectionService := services.NewRepoConnectionService(pool)
	repoConnectionService.SetGitHubBudgetTracker(gitHubBudgetTracker)
	gitHubRepoListService := services.NewGitHubRepoListService(pool, repoConnectionService)
	// The continuously-synced GitHub mirror: registry + issue/PR/comment store.
	// The metadata proxy serves from it (live GitHub is the fallback), the App
	// webhooks keep it fresh, and github-sync reads its registry feed instead of
	// a static mapping. Its ref mirrorer is attached once the import service —
	// which owns the clone → repo-host → ImportRefs path — has been built.
	gitHubSyncedRepoService := services.NewGitHubSyncedRepoService(queries,
		// R5: sync draws from the same per-installation budget as the proxy.
		services.WithGitHubSyncedRepoBudget(gitHubBudgetTracker),
	)
	gitHubUserReposService := services.NewGitHubUserReposService(queries, authService,
		services.WithGitHubUserReposTokenRefresher(authService),
		services.WithGitHubUserReposSyncedStore(gitHubSyncedRepoService),
	)
	repoConnectionService.SetGitHubRepoAccessVerifier(gitHubUserReposService)
	// R2: backfills and the reconciliation sweep fetch with cached App
	// installation tokens whenever the registry row has an installation;
	// request-bound user tokens remain only the fallback for rows without one.
	gitHubSyncedRepoService.SetFetcherFactory(
		gitHubUserReposService.SyncedRepoInstallationFetcherFactory(repoConnectionService))
	gitHubCheckRunService := services.NewGitHubCheckRunService(repoConnectionService)
	webhookSecretCodec, err := newSecretCodec(cfg.Webhook.SecretEncryptionKey)
	if err != nil {
		slog.Error("failed to initialize webhook secret codec", "error", err)
		return err
	}
	agentEnvironmentService := services.NewAgentEnvironmentService(
		queries,
		webhookSecretCodec,
		services.WithAgentEnvironmentOwnershipGuard(repoOwnershipFence),
	)
	secretInjector := services.NewSecretInjector(queries, webhookSecretCodec)
	workflowParser := services.NewWorkflowParser()
	workflowSyncService := services.NewWorkflowSyncService(queries, repoHostClient, workflowParser)
	workflowRunService := services.NewWorkflowRunService(
		queries,
		services.WithWorkflowRunMetrics(smithersMetrics),
		services.WithWorkflowRunWebhookDispatcher(webhookDispatcher),
		services.WithWorkflowRunCommitStatusWriter(commitStatusService),
		services.WithWorkflowRunGitHubCheckRunService(gitHubCheckRunService),
		services.WithWorkflowRunGitHubInstallationResolver(repoConnectionService),
		services.WithWorkflowRunSecretInjector(secretInjector),
		services.WithWorkflowRunBillingPolicy(billingService),
		services.WithWorkflowRunDefinitionCommitLoader(workflowSyncService),
		services.WithWorkflowRunBookmarkCommitResolver(workflowSyncService),
	)

	auditService := services.NewAuditService(queries)
	configSyncService := configsync.NewService(queries, repoHostClient, webhookSecretCodec, auditService)

	landingOptions := []services.LandingServiceOption{
		services.WithLandingWebhookDispatcher(webhookDispatcher),
		services.WithLandingMentionService(mentionService),
		services.WithLandingNotificationService(notificationService),
	}
	if cfg.FeatureFlags.Workflows {
		landingOptions = append(landingOptions, services.WithLandingWorkflowRunService(workflowRunService))
	}
	landingOptions = append(landingOptions, services.WithLandingMetrics(smithersMetrics))
	landingService := services.NewLandingServiceWithPool(queries, repoHostClient, pool, landingOptions...)
	stackOptions := []services.StackServiceOption{
		services.WithStackGitHubInstallationResolver(repoConnectionService),
	}
	if cfg.FeatureFlags.Workflows {
		stackOptions = append(stackOptions, services.WithStackWorkflowRunDispatcher(workflowRunService))
	}
	stackService := services.NewStackServiceWithPool(queries, pool, stackOptions...)
	issueService := services.NewIssueService(queries,
		services.WithIssueWebhookDispatcher(webhookDispatcher),
		services.WithIssueMentionService(mentionService),
		services.WithIssueNotificationService(notificationService),
		services.WithIssueOwnershipGuard(repoOwnershipFence),
	)
	runnerOptions := []clusterservices.RunnerServiceOption{
		clusterservices.WithRunnerMetrics(smithersMetrics),
		clusterservices.WithRunnerWebhookDispatcher(webhookDispatcher),
		clusterservices.WithRunnerCommitStatusWriter(commitStatusService),
		clusterservices.WithRunnerGitHubCheckRunService(gitHubCheckRunService),
		clusterservices.WithRunnerGitHubInstallationResolver(repoConnectionService),
		clusterservices.WithRunnerSecretInjector(secretInjector),
	}
	if cfg.FeatureFlags.Workflows {
		runnerOptions = append(runnerOptions, clusterservices.WithRunnerWorkflowDispatcher(workflowRunService))
	}
	runnerService := clusterservices.NewRunnerService(queries, runnerOptions...)
	runnerAdminService := clusterservices.NewRunnerAdminService(queries)
	adminUserService := services.NewAdminUserService(queries,
		services.WithTokenCreator(authService),
		services.WithAdminAuditor(auditService),
	)
	adminOrgService := services.NewAdminOrgService(queries)
	adminRepoService := services.NewAdminRepoService(queries)
	webhookService := services.NewWebhookService(queries, webhookSecretCodec, services.WithWebhookOwnershipGuard(repoOwnershipFence))
	secretService := services.NewSecretService(queries, webhookSecretCodec, services.WithSecretOwnershipGuard(repoOwnershipFence))
	variableService := services.NewVariableService(queries)
	wikiService := services.NewWikiService(queries, webhookDispatcher, services.WithWikiCollaboration(queries, repoHostClient))

	workflowAPIService := services.NewWorkflowAPIService(queries, workflowRunService)

	blobConfig := cfg.Blob
	blobConfig.TransferBaseURL = publicBaseURL
	blobStore, gcsClient, expiryDuration, err := selectBlobStore(ctx, blobConfig, options.Blobs)
	if err != nil {
		slog.Error("failed to initialize blob store", "error", err)
		return err
	}
	if gcsClient != nil {
		defer func() { _ = gcsClient.Close() }()
	}
	if _, canPurge := blobStore.(blob.GenerationPurger); canPurge {
		legacyFinalKeyPurgeAllowed, gateErr := queries.IsLegacyFinalKeyPurgeAllowed(ctx)
		if gateErr != nil {
			return fmt.Errorf("load legacy final-key capability horizon: %w", gateErr)
		}
		fencedStore, fenceErr := blob.NewLegacyFinalKeyPurgeFencedStore(
			blobStore,
			func(gateCtx context.Context) (bool, error) {
				return queries.IsLegacyFinalKeyPurgeAllowed(gateCtx)
			},
		)
		if fenceErr != nil {
			return fmt.Errorf("initialize legacy final-key purge fence: %w", fenceErr)
		}
		blobStore = fencedStore
		if !legacyFinalKeyPurgeAllowed {
			slog.Error("FINAL-KEY BLOB PURGE IS FAIL-CLOSED FOR LEGACY UPLOAD CAPABILITIES",
				"remediation", "follow docs/runbooks/legacy-blob-upload-capability-drain.md after every legacy signer is drained")
		}
	}
	lfsVerifyTokenManager, err := lfsauth.NewManager(cfg.Auth.LFSSigningSecret)
	if err != nil {
		slog.Error("failed to initialize lfs verify credentials", "error", err)
		return err
	}

	lfsService := services.NewLFSService(
		queries,
		blobStore,
		expiryDuration,
		services.WithLFSBillingPolicy(billingService),
		services.WithLFSVerifyBaseURL(publicBaseURL),
		services.WithLFSVerifyTokenManager(lfsVerifyTokenManager),
	)
	workflowCacheTTL, err := time.ParseDuration(cfg.Blob.WorkflowCacheTTL)
	if err != nil {
		slog.Error("invalid blob.workflow_cache_ttl", "ttl", cfg.Blob.WorkflowCacheTTL, "error", err)
		return err
	}
	workflowCacheStore, ok := blobStore.(services.WorkflowCacheStore)
	if !ok {
		slog.Error("blob store does not implement workflow cache storage requirements")
		return errors.New("blob store does not implement workflow cache storage requirements")
	}
	workflowCacheService := services.NewWorkflowCacheService(queries, workflowCacheStore, services.WorkflowCacheConfig{
		Prefix:          cfg.Blob.WorkflowCachePrefix,
		SignedURLExpiry: expiryDuration,
		TTL:             workflowCacheTTL,
		RepoQuotaBytes:  cfg.Blob.WorkflowCacheRepoQuotaBytes,
		ArchiveMaxBytes: cfg.Blob.WorkflowCacheArchiveMaxBytes,
	}, services.WithWorkflowCacheBillingPolicy(billingService))
	workflowArtifactService := services.NewWorkflowArtifactService(
		queries,
		blobStore,
		expiryDuration,
		services.WithWorkflowArtifactWebhookDispatcher(webhookDispatcher),
		services.WithWorkflowArtifactWorkflowRunService(workflowRunService),
		services.WithWorkflowArtifactBillingPolicy(billingService),
	)

	issueEventService := services.NewIssueEventService(queries)

	var sandboxClient services.SandboxVMClient
	var workflowSandboxClient services.WorkflowSandboxVMClient
	var repoGatewaySandbox services.RepoGatewayVMClient
	var pairSandbox services.PairSandbox
	var goldenSnapshotSandbox services.GoldenSnapshotVMClient
	var orphanSandbox services.SandboxOrphanVMClient
	provider, err := buildSandboxProvider(cfg.Sandbox, smithersMetrics)
	if err != nil {
		return err
	}
	if provider != nil {
		sandboxClient = provider
		workflowSandboxClient = provider
		repoGatewaySandbox = provider
		pairSandbox = provider
		goldenSnapshotSandbox = provider
		orphanSandbox = provider
		if accessRevoker, ok := provider.(sandbox.AccessGrantRevoker); ok {
			unsubscribeAccessRevocations := revocationBus.Subscribe(revocation.NewAccessGrantHandler(ctx, accessRevoker))
			defer unsubscribeAccessRevocations()
		}
	}
	// Backstop for micro-VMs whose owning gateway/workspace row was cascade-
	// deleted with its repository: nothing else can see them, because every
	// other sweep starts from the row that is gone.
	sandboxOrphanReaper := services.NewSandboxOrphanReaper(queries, orphanSandbox, smithersMetrics)

	// Smithers Pair: realtime multiplayer pair-coding (shared doc + cursors +
	// one shared Codex model run in a Microsandbox sandbox). Key-gated, no repo.
	pairService := services.NewPairService(pool, pairSandbox, landingService)
	if err := ensurePairSchema(pairService, ctx); err != nil {
		slog.Warn("pair: ensure schema failed", "error", err)
	}
	pairHandler := routes.NewPairHandler(pairService, pool)

	// Initialize agent log store (GCS-backed when available, in-memory fallback).
	// Transcripts are retention-limited operational data: they belong in the
	// dedicated agent-logs bucket, not the versioned long-retention blobs bucket.
	agentLogStore := options.AgentLogs
	if agentLogStore == nil {
		agentLogStore = initializeAgentLogStore(gcsClient, cfg.Blob, blobStore)
	}

	agentSnapshotID := cfg.Sandbox.AgentSnapshotID
	// UsableProviderCredentials drops blanks AND the operator-seeded
	// "placeholder-pending-..." stand-ins Secret Manager holds until a real
	// credential is provisioned. Injecting a placeholder is worse than
	// injecting nothing: the VM`s model selector picks a provider by env-var
	// PRESENCE, so a placeholder ANTHROPIC_API_KEY beat the one credential
	// that was real and every model call 401ed in silence.
	agentProviderEnv := services.UsableProviderCredentials(map[string]string{
		"OPENROUTER_API_KEY": cfg.Sandbox.GatewayAgentOpenRouterAPIKey,
		"ANTHROPIC_API_KEY":  cfg.Sandbox.GatewayAgentAnthropicAPIKey,
		"OPENAI_API_KEY":     cfg.Sandbox.GatewayAgentOpenAIAPIKey,
		"CEREBRAS_API_KEY":   cfg.Sandbox.GatewayAgentCerebrasAPIKey,
	})
	if len(agentProviderEnv) == 0 {
		slog.Error("no usable AI-provider credential is configured; agent runs will be refused",
			"remediation", "seed a real value for one of plue-cerebras-api-key, plue-anthropic-api-key, plue-openai-api-key or plue-openrouter-api-key in Secret Manager")
	}
	changesetService := services.NewChangesetService(queries, repoHostClient, repoService, pool, services.WithChangesetLandingPolicy(landingService))
	// Bring-your-own subscriptions (RFD-003): connections are encrypted with
	// the same codec as agent-environment secrets and refreshed by a worker.
	providerConnectionService := services.NewProviderConnectionService(
		queries,
		webhookSecretCodec,
		services.NewHTTPProviderTokenRefresher(services.ProviderConnectionsConfig{
			ClaudeTokenURL: cfg.ProviderConnections.ClaudeTokenURL,
			ClaudeClientID: cfg.ProviderConnections.ClaudeClientID,
			CodexTokenURL:  cfg.ProviderConnections.CodexTokenURL,
			CodexClientID:  cfg.ProviderConnections.CodexClientID,
		}, nil),
		services.WithProviderConnectionAudit(auditService),
	)
	providerConnectionRefreshWorker := services.NewProviderConnectionRefreshWorker(providerConnectionService, time.Minute, slog.Default())
	neverStartedTimeout, _ := time.ParseDuration(cfg.Agents.NeverStartedTimeout)
	agentService := services.NewAgentServiceWithPool(queries, pool,
		services.WithAgentDispatchQuerier(queries),
		services.WithAgentNeverStartedTimeout(neverStartedTimeout),
		services.WithAgentChangesetMaterializer(changesetService),
		services.WithAgentLogStore(agentLogStore),
		services.WithAgentSecretService(secretService),
		services.WithAgentSecretInjector(secretInjector),
		services.WithAgentAPIBaseURL(agentAPIBaseURL),
		services.WithAgentGitBaseURL(publicBaseURL),
		services.WithAgentSandboxClient(sandboxClient),
		services.WithAgentSandboxConfig(services.AgentSandboxConfig{
			MemoryMB:     cfg.Sandbox.AgentMemoryMB,
			VCPUCount:    cfg.Sandbox.AgentVCPUCount,
			RootfsSizeMB: cfg.Sandbox.AgentRootfsSizeMB,
			MaxRuntime:   time.Duration(cfg.Sandbox.AgentMaxRuntimeSecs) * time.Second,
			IdleTimeout:  time.Duration(cfg.Sandbox.AgentIdleTimeoutSecs) * time.Second,
			ProviderEnv:  agentProviderEnv,
		}),
		services.WithAgentEnvironmentVariables(agentEnvironmentService),
		services.WithAgentEnvironmentBoundSecrets(agentEnvironmentService),
		services.WithAgentProviderConnections(providerConnectionService),
		services.WithAgentSandboxMetrics(smithersMetrics),
		services.WithAgentWorkflowMetrics(smithersMetrics),
		services.WithAgentSessionMetrics(smithersMetrics),
		services.WithAgentSnapshotID(agentSnapshotID),
		services.WithAgentBillingPolicy(billingService),
		// Fleet-wide capacity guard: cap concurrent agent sandboxes via a DB
		// COUNT of live agent sessions (correct across all API pods). 0 =
		// unlimited/disabled, so this no-ops until
		// SMITHERS_SANDBOX_AGENT_MAX_CONCURRENT is set. queries (*db.Queries)
		// supplies CountActiveAgentSessionVMs.
		services.WithAgentConcurrencyCap(queries, int(cfg.Sandbox.AgentMaxConcurrent)),
	)
	landingService.SetAgentTurnDispatcher(agentService)

	workspaceService := services.NewWorkspaceService(queries,
		services.WithWorkspaceCapabilityTransactions(pool),
		services.WithWorkspaceBillingPolicy(billingService),
		services.WithWorkspaceSandboxClient(sandboxClient),
		services.WithWorkspaceSourceReader(repoHostClient),
		services.WithWorkspaceSandboxMetrics(smithersMetrics),
		services.WithWorkspaceGitBaseURL(publicBaseURL),
		services.WithWorkspaceSSHHost(cfg.Sandbox.WorkspaceSSHHost),
		services.WithWorkspaceSSHDialHost(cfg.Sandbox.WorkspaceSSHDialHost),
		// Advertise the SSH gateway's host key so the terminal client
		// can pin it before credentials are sent. Same directory as the
		// SSH server reads at boot (cfg.SSH.HostKeyDir).
		services.WithWorkspaceSSHHostKeyDir(cfg.SSH.HostKeyDir),
		services.WithWorkspaceSandboxConfig(
			cfg.Sandbox.WorkspaceIdleTimeout,
			sandbox.PersistenceMode(cfg.Sandbox.WorkspacePersistence),
		),
		services.WithWorkspaceResources(cfg.Sandbox.WorkspaceMemoryMB, cfg.Sandbox.WorkspaceVCPUCount),
		services.WithWorkspaceAgentResources(cfg.Sandbox.AgentMemoryMB, cfg.Sandbox.AgentVCPUCount),
		services.WithWorkspaceDesktopResources(cfg.Sandbox.DesktopMemoryMB, cfg.Sandbox.DesktopVCPUCount),
		services.WithWorkspaceDesktopObserveText(cfg.Sandbox.DesktopObserveText),
		// Supply setup-only secrets and persistent nonsecret variables to fresh
		// repository workspace VMs; secrets exist only during the setup phase
		// and are stripped before the agent runs.
		services.WithWorkspaceAgentEnvironment(agentEnvironmentService),
		services.WithWorkspaceProviderConnections(providerConnectionService),
		services.WithWorkspaceProviderBootstrap(agentProviderEnv, cfg.Sandbox.WorkspaceCodingDefaultModel),
	)

	// Golden sandbox snapshot: the pre-baked toolchain image fresh
	// workspace/gateway VMs boot from. Baked in the background from the exact
	// workspace VM request; provisioning falls back to the bare base image
	// whenever no ready snapshot exists.
	goldenSnapshotService := services.NewGoldenSnapshotService(pool, goldenSnapshotSandbox, workspaceService.GoldenBakeVMRequest)
	services.WithWorkspaceGoldenSnapshots(goldenSnapshotService)(workspaceService)
	// NixOS environment images: the kind=vm/desktop compute path. Registering
	// an image bakes its closure-keyed golden snapshot from the same request
	// workspaces boot (NixBakeVMRequest), so the second boot clones a disk.
	environmentImageService := services.NewSandboxEnvironmentImageService(queries,
		services.WithSandboxEnvironmentImageGoldenSnapshots(goldenSnapshotService, workspaceService.NixBakeVMRequest))
	services.WithWorkspaceEnvironmentImages(environmentImageService)(workspaceService)
	// NixOS CI routing: a repository whose trigger commit declares
	// .smithers/environment.nix and has a registered kind=vm closure image runs
	// its CI in NixOS guests on the sandbox plane instead of the Debian runner
	// pool. Bound here because the image registry is constructed after the run
	// service.
	services.BindWorkflowRunEnvironmentRouting(workflowRunService, repoHostClient, environmentImageService)

	// Smithers Pair sessions: the server-authoritative pairing backend
	// (fork-and-swap, ACL ladder, roles, invites, per-link slugs, serial FIFO
	// queue with executor election, co-compose draft). Identity is the real
	// signed-in user; the paid-plan gate rides billingService and the fork rides
	// workspaceService. Invites deliver via emailTransport when configured and
	// degrade to invite-record-only ("email delivery unavailable") otherwise.
	pairSessionService := services.NewPairSessionService(
		db.New(pool),
		billingService,
		workspaceService,
		services.PairSessionServiceConfig{
			EmailFrom:     emailFrom,
			Transport:     emailTransport,
			InviteBaseURL: publicBaseURL,
			TxBeginner:    pool,
		},
	)
	pairSessionHandler := routes.NewPairSessionHandler(pairSessionService)

	// Repo gateway: durable per-user+repo `smithers gateway` control plane in a
	// Microsandbox VM (the 4th sandbox archetype). Degrades honestly (409) when
	// Microsandbox is not configured.
	repoGatewayService := services.NewRepoGatewayService(queries,
		services.WithRepoGatewayBillingPolicy(billingService),
		services.WithRepoGatewayWorkspaces(workspaceService),
		services.WithRepoGatewaySandboxClient(repoGatewaySandbox),
		services.WithRepoGatewaySandboxMetrics(smithersMetrics),
		services.WithRepoGatewaySecretCodec(webhookSecretCodec),
		services.WithRepoGatewayGitBaseURL(publicBaseURL),
		services.WithRepoGatewayGoldenSnapshots(goldenSnapshotService),
		// Cap concurrent gateway VMs against the same per-user active-sandbox
		// budget as workspaces (default 3), enforced only on the provision path
		// so resuming an existing gateway is never blocked.
		services.WithRepoGatewayConcurrencyCap(queries, perUserConcurrentSandboxCap),
		// Reaper-driven authorization sweep: tear down gateways whose user lost
		// write access, since the VM-local operator token is never re-checked
		// against Smithers permissions on use.
		services.WithRepoGatewayAccessRevocation(queries),
		// AI-provider seat for agent workflows on gateway VMs (Cerebras
		// supplier key, per-VM systemd env at provision time). Empty disables
		// the seat; gateways then honestly fail agent nodes for lack of a
		// provider instead of pretending one exists.
		services.WithRepoGatewayAgentSeat(cfg.Sandbox.GatewayAgentCerebrasAPIKey),
		services.WithRepoGatewayProviderEnv(agentProviderEnv),
		// Resume-time liveness probe through the preview ingress (the relay's
		// own upstream). Empty in local dev: no preview gateway exists there.
		services.WithRepoGatewayHealthProbe(cfg.Sandbox.GatewayHealthProbeBaseURL, nil),
		services.WithPreviewRelayToken(cfg.Sandbox.PreviewRelayToken),
	)
	services.WithWorkspaceCapabilityProbe(repoGatewayService.ProbeWorkspaceCapability)(workspaceService)
	if os.Getenv("SMITHERS_AGENT_CODING_DISPATCH") == "1" {
		services.WithAgentCodingGateway(repoGatewayService)(agentService)
	}
	gitHubImportService := services.NewGitHubImportService(
		pool,
		queries,
		queries,
		repoHostClient,
		authService,
		publicBaseURL,
		services.WithGitHubImportOrgs(queries),
		services.WithGitHubImportMetrics(smithersMetrics),
		services.WithGitHubImportBillingPolicy(billingService),
		services.WithGitHubImportStorageSet(activeStorageSetID),
		services.WithGitHubImportWorkspaceProvisioner(workspaceService),
		services.WithGitHubImportTokenRefresher(authService),
		services.WithGitHubImportInstallationTokens(repoConnectionService),
		services.WithGitHubImportSyncedRepos(gitHubSyncedRepoService),
	)
	gitHubSyncedRepoService.SetMirrorer(gitHubImportService)
	if provisioningEnforced {
		gitHubImportService.EnableDurableWorker()
	}

	landingWorker := services.NewLandingWorker(queries, repoHostClient,
		services.WithLandingWorkerMetrics(smithersMetrics),
		services.WithLandingWorkerWebhookDispatcher(webhookDispatcher),
		services.WithLandingWorkerTaskStore(services.NewPgxLandingTaskStore(pool)),
		services.WithLandingWorkerAutoLandProcessor(landingService),
	)
	cronSchedulerWorker := services.NewCronSchedulerWorker(queries, workflowRunService)
	workflowLogBudgetBackfiller := services.NewWorkflowLogBudgetBackfiller(queries)
	workflowSandboxSchedulerWorker := services.NewWorkflowSandboxSchedulerWorker(
		queries,
		workflowSandboxClient,
		services.WithWorkflowSandboxSchedulerAPIBaseURL(agentAPIBaseURL),
		services.WithWorkflowSandboxSchedulerGitBaseURL(publicBaseURL),
		services.WithWorkflowSandboxSchedulerSecretInjector(secretInjector),
		// NixOS CI: a sandbox-plane run with a rendered job graph runs each job
		// in its own kind=vm guest, built by the same code a workspace uses.
		services.WithWorkflowSandboxSchedulerCIGuests(workspaceService),
	)
	gitHubWebhookEventWorker := services.NewGitHubWebhookEventWorker(queries, workflowRunService)
	// Alert auto-remediation worker: drains alert_remediation_jobs and
	// dispatches the registered remediation workflow. Only runs when
	// SMITHERS_ALERT_REMEDIATION_REPOSITORY (owner/repo) or the legacy
	// SMITHERS_ALERT_REMEDIATION_REPOSITORY_ID identifies the repository
	// hosting .smithers/workflows/remediate.tsx.
	var alertRemediationWorker *clusterservices.AlertRemediationWorker
	if cfg.FeatureFlags.Workflows {
		if remediationRepo := resolveAlertRemediationRepository(ctx, queries); remediationRepo.ID > 0 {
			if alertRegistry, err := loadAlertRegistry(); err != nil {
				slog.Error("failed to load alert remediation registry; remediation worker disabled", "error", err)
			} else {
				alertRemediationWorker = clusterservices.NewAlertRemediationWorker(
					queries,
					workflowRunService,
					alertRegistry,
					remediationRepo.ID,
					remediationRepo.FullName,
				)
			}
		}
	}
	webhookWorker := webhook.NewWorker(
		queries,
		webhook.DefaultHTTPClient(),
		webhookSecretCodec,
		webhook.WithMetricsObserver(smithersMetrics),
	)
	authCleanupInterval, err := time.ParseDuration(cfg.Cleanup.AuthInterval)
	if err != nil {
		slog.Error("invalid cleanup.auth_interval", "interval", cfg.Cleanup.AuthInterval, "error", err)
		return err
	}
	authCleaner := cleanup.NewAuthCleaner(queries, authCleanupInterval)
	authCleaner.SetRevocationPublisher(revocationPublisher)
	workflowCacheCleanupInterval, err := time.ParseDuration(cfg.Cleanup.WorkflowCacheInterval)
	if err != nil {
		slog.Error("invalid cleanup.workflow_cache_interval", "interval", cfg.Cleanup.WorkflowCacheInterval, "error", err)
		return err
	}
	workflowCacheCleaner := cleanup.NewWorkflowCacheCleaner(workflowCacheService, workflowCacheCleanupInterval)
	workflowArtifactCleaner := cleanup.NewWorkflowArtifactCleaner(workflowArtifactService, 24*time.Hour, 250)

	storageDeletionCleaner := cleanup.NewStorageDeletionCleaner(pool, blobStore, time.Minute, 250)

	auditCleaner := cleanup.NewAuditCleaner(queries, 24*time.Hour, 90*24*time.Hour)
	egressAuditCleaner := cleanup.NewSandboxEgressAuditCleaner(queries, 24*time.Hour, cfg.Cleanup.SandboxEgressAuditRetentionDays)

	workspaceCleaner := cleanup.NewWorkspaceCleaner(workspaceService, 5*time.Minute)
	repoSyncService := services.NewRepoSyncService("", repoConnectionService)
	gitMirrorSyncService := services.NewGitMirrorSyncService(queries, services.WithGitMirrorCredentials(queries, gitHubUserReposService, publicBaseURL, repoConnectionService))

	repoHandler := &routes.RepoHandler{
		Service:               repoService,
		RepoConnectionService: repoConnectionService,
		RepoSyncService:       repoSyncService,
		SSHHost:               cfg.Server.SSHHost,
		AuditService:          auditService,
	}
	mirrorSyncHandler := &routes.GitMirrorSyncHandler{Service: gitMirrorSyncService}
	authHandler := &routes.AuthHandler{
		Service:      authService,
		AuthConfig:   cfg.Auth,
		AuditService: auditService,
		SSETickets:   sseTicketManager,
		// Login is a free warm of the per-user GitHub repo listing cache.
		RepoListingWarmer: gitHubUserReposService,
	}
	userHandler := &routes.UserHandler{
		TokenService:   authService,
		ProfileService: userService,
		SessionService: authService,
		EmailService:   emailService,
		DeviceService:  userDeviceService,
		AuditService:   auditService,
	}
	sshKeyHandler := &routes.SSHKeyHandler{
		Service:      sshKeyService,
		AuditService: auditService,
	}
	deployKeyHandler := &routes.DeployKeyHandler{
		Service:      deployKeyService,
		AuditService: auditService,
	}
	labelHandler := &routes.LabelHandler{
		Service: labelService,
	}

	orgHandler := &routes.OrgHandler{
		Service:      orgService,
		AuditService: auditService,
		SSHHost:      cfg.Server.SSHHost,
	}
	landingHandler := &routes.LandingHandler{
		Service: landingService,
	}
	changesetHandler := &routes.ChangesetHandler{
		Service: changesetService,
	}
	buildCacheHandler := &routes.BuildCacheHandler{
		Service: services.NewBuildCacheService(services.NewPgxBuildCacheStore(queries, pool), blobStore, cfg.Blob.BuildCacheArtifactMaxBytes),
	}
	stackHandler := &routes.StackHandler{
		Service: stackService,
	}
	searchHandler := &routes.SearchHandler{
		Service: searchService,
	}
	issueHandler := &routes.IssueHandler{
		Service: issueService,
	}
	issueHandler.LinearLink = services.NewLinearIssueLinkService(queries, linearIntegrationSvc, linearClient)

	gitHandler := &routes.GitSmartHandler{
		Service: gitHTTPProxyService,
		Metrics: smithersMetrics,
	}
	notificationHandler := &routes.NotificationHandler{
		Service: notificationService,
		Broker:  sseBroker,
		Metrics: smithersMetrics,
	}

	runnerHandler := &routes.RunnerHandler{
		Service: runnerService,
	}
	adminRunnerHandler := &routes.AdminRunnerHandler{
		Service: runnerAdminService,
	}
	adminUserHandler := &routes.AdminUserHandler{
		Service: adminUserService,
	}
	adminOrgHandler := &routes.AdminOrgHandler{
		Service: adminOrgService,
	}
	adminRepoHandler := &routes.AdminRepoHandler{
		Service: adminRepoService,
	}
	adminSystemHealthHandler := &routes.AdminSystemHealthHandler{
		DB: pool,
	}
	// The admin system console reads the same sources the runtime gauges do, plus
	// the incident and landing-queue aggregates, through one adapter.
	adminSystemConsoleStore := clusterservices.NewAdminSystemConsoleStore(queries)
	adminSystemStatusHandler := &routes.AdminSystemStatusHandler{
		Service: clusterservices.NewAdminSystemStatusService(clusterservices.AdminSystemStatusServiceConfig{
			DB:           pool,
			Runtime:      runtimeMetricsStore,
			Canaries:     queries,
			Sandboxes:    queries,
			LandingQueue: adminSystemConsoleStore,
			Incidents:    queries,
			SSE:          sseBroker,
		}),
	}
	adminSystemCanariesHandler := &routes.AdminSystemCanariesHandler{
		Store: queries,
	}
	adminSystemIncidentsHandler := &routes.AdminSystemIncidentsHandler{
		Service: clusterservices.NewAdminSystemIncidentsService(adminSystemConsoleStore),
	}
	adminSystemMetricsHandler := routes.NewAdminSystemMetricsHandler(cfg.MetricsQueryProjectID(), nil)
	if adminSystemMetricsHandler == nil {
		// No GCP project (or no credentials): mount a backend-less handler so the
		// endpoint answers 501 "metrics backend not configured" instead of 404,
		// which the admin UI reads as a missing route.
		slog.Warn("admin metrics query endpoint has no metrics backend",
			"remediation", "set SMITHERS_METRICS_PROJECT_ID (or blob.gcs_project) and grant roles/monitoring.viewer")
		adminSystemMetricsHandler = &routes.AdminSystemMetricsHandler{}
	}
	adminGitHubAppHandler := &routes.AdminGitHubAppHandler{
		Service: repoConnectionService,
	}
	adminAuditHandler := &routes.AdminAuditHandler{
		Queries: queries,
	}
	webhookHandler := &routes.WebhookHandler{
		Service: webhookService,
	}
	gitHubWebhookHandler := &routes.GitHubWebhookHandler{
		Service: services.NewGitHubWebhookService(pool, cfg.Webhook.GitHubAppSecret,
			services.WithGitHubWebhookSyncedRepos(gitHubSyncedRepoService)),
	}
	gitHubSyncedReposHandler := &routes.GitHubSyncedReposHandler{
		Service: gitHubSyncedRepoService,
	}
	providerConnectionHandler := &routes.ProviderConnectionHandler{Service: providerConnectionService}
	secretHandler := &routes.SecretHandler{
		Service:          secretService,
		AgentEnvironment: agentEnvironmentService,
	}
	variableHandler := &routes.VariableHandler{
		Service: variableService,
	}
	billingHandler := &routes.BillingHandler{
		Service: billingService,
	}
	protectedBookmarkHandler := &routes.ProtectedBookmarkHandler{
		Service: services.NewProtectedBookmarkService(queries),
	}
	commitStatusHandler := &routes.CommitStatusHandler{
		Service: commitStatusService,
	}
	lfsHandler := &routes.LFSHandler{
		Service: lfsService,
	}
	changeService := services.NewChangeService(
		queries,
		repoHostClient,
		pool,
		services.WithChangeConflictAgent(agentService),
	)
	changeRevertService := services.NewChangeRevertService(queries, repoHostClient, landingService, changesetService, changeService)
	changeOperationService := services.NewChangeOperationService(queries, repoHostClient, workspaceService, pool)
	jjVCSHandler := &routes.JJVCSHandler{
		RepoHost:           repoHostClient,
		RepoResolver:       queries,
		ChangeService:      changeService,
		FindingsService:    changeService,
		ConflictResolver:   changeService,
		ChangeReverter:     changeRevertService,
		ChangeSplitter:     changeService,
		ChangeOperations:   changeOperationService,
		WalkthroughService: changeService,
		Broker:             sseBroker,
		Metrics:            smithersMetrics,
		WebhookDispatcher:  webhookDispatcher,
	}
	agentInternalHandler := &routes.AgentInternalHandler{
		Service:      agentService,
		TokenQuerier: queries,
	}
	egressAuditService := services.NewSandboxEgressAuditService(queries)
	agentSessionHandler := &routes.AgentSessionHandler{
		Service:     agentService,
		EgressAudit: egressAuditService,
	}
	// Ticket 0110: approvals flow handler. Feature-gated on
	// cfg.FeatureFlags.ApprovalsFlowEnabled; when the flag is off the
	// handler returns 404 without calling into the service.
	// Ticket 0134: wire the AuditService into ApprovalsService so every
	// create/decide transition emits an immutable audit row.
	var approvalPushNotifier services.ApprovalPushNotifier
	if strings.EqualFold(os.Getenv("SMITHERS_APNS_ENABLED"), "true") || os.Getenv("SMITHERS_APNS_ENABLED") == "1" {
		approvalPushNotifier = services.NewApprovalPushDispatcher(
			poolStatsCtx,
			queries,
			services.NewLoggingAPNSClient(slog.Default()),
			0,
			slog.Default(),
		)
		slog.Info("APNS approval push logging client enabled")
	}
	approvalsService := services.NewApprovalsServiceWithAudit(
		queries,
		auditService,
		services.WithApprovalPushNotifier(approvalPushNotifier),
	)
	approvalsHandler := &routes.ApprovalsHandler{
		Service: approvalsService,
		Enabled: cfg.FeatureFlags.ApprovalsFlowEnabled,
	}
	branchLockHandler := &routes.BranchLockHandler{
		Service: services.NewBranchLockService(
			queries,
			services.WithBranchLockJoinAuthorizer(billingService),
			services.WithBranchLockNotifier(notificationService),
		),
	}
	agentSessionStreamHandler := &routes.AgentSessionStreamHandler{
		Service: agentService,
		Broker:  sseBroker,
		Metrics: smithersMetrics,
	}
	workspaceHandler := &routes.WorkspaceHandler{
		Service:           workspaceService,
		EgressAudit:       egressAuditService,
		Broker:            sseBroker,
		Metrics:           smithersMetrics,
		Desktop:           &routes.WorkspaceDesktopHandler{Service: workspaceService, RelayToken: cfg.Sandbox.PreviewRelayToken},
		EnvironmentImages: &routes.SandboxEnvironmentImageHandler{Service: environmentImageService},
	}
	// RFD-004: agent runs execute in kind=agent workspaces.
	agentService.SetWorkspaceBackend(workspaceService)
	workspaceInternalHandler := &routes.WorkspaceInternalHandler{
		Service: workspaceService,
	}
	repositoryJobService := services.NewRepositoryJobService(queries, repoGatewayService, pool)
	gitHubWebhookEventWorker.SetRepositoryJobs(repositoryJobService)
	repoGatewayHandler := &routes.RepoGatewayHandler{
		RepositoryJobs:  repositoryJobService,
		SourceRetention: services.NewRepositorySourceRetentionService(queries, repositoryJobService, gitHubImportService),
		Service:         repoGatewayService,
		RelayService:    repoGatewayService,
		RelayToken:      cfg.Sandbox.PreviewRelayToken,
		WikiPublisher:   services.NewGatewayWikiPublisher(repoGatewayService, queries, wikiService),
		PushTokens:      services.NewGatewayPushTokenService(repoGatewayService, queries, auditService),
	}

	// Anonymous sandboxes (../multi SPEC.md §3): signed-out open of the
	// allowlisted public repo. Boots from the same golden snapshot as
	// workspaces (GoldenBakeVMRequest is the repo-agnostic, secret-free base),
	// sized down to the agent-class caps, hard-deleted at TTL by its reaper.
	var anonSandboxVMClient services.AnonSandboxVMClient
	if provider != nil {
		anonSandboxVMClient = provider
	}
	anonSandboxService := services.NewAnonSandboxService(
		queries,
		anonSandboxVMClient,
		goldenSnapshotService,
		workspaceService.GoldenBakeVMRequest,
		services.AnonSandboxConfig{
			Enabled:       cfg.Sandbox.AnonEnabled,
			RepoAllowlist: cfg.Sandbox.AnonRepoAllowlist,
			TTL:           time.Duration(cfg.Sandbox.AnonTTLSecs) * time.Second,
			MaxConcurrent: cfg.Sandbox.AnonMaxConcurrent,
			MaxPerIP:      cfg.Sandbox.AnonMaxPerIP,
			MemSizeMB:     cfg.Sandbox.AgentMemoryMB,
			VCPUCount:     cfg.Sandbox.AgentVCPUCount,
			RootfsSizeMB:  cfg.Sandbox.AgentRootfsSizeMB,
		},
	)
	anonSandboxHandler := routes.NewAnonSandboxHandler(anonSandboxService)
	gitHubProxyHandler := &routes.GitHubProxyHandler{
		Service: services.NewGitHubProxyService(
			queries,
			repoConnectionService,
			services.WithGitHubProxyBudgetTracker(gitHubBudgetTracker),
		),
	}
	gitHubRepoListHandler := &routes.GitHubRepoListHandler{Service: gitHubRepoListService}
	gitHubUserReposHandler := &routes.GitHubUserReposHandler{Service: gitHubUserReposService}
	gitHubImportHandler := &routes.GitHubImportHandler{Service: gitHubImportService, Metrics: smithersMetrics}
	// Ticket 0132: per-user active-connection cap on terminal WebSockets,
	// with Prometheus hooks so operators can see current counts + rejects.
	// The ActiveCounter uses its scope string ("workspace_terminal_active")
	// as the "scope" label value for every rejection emission, so the
	// existing smithers_rate_limit_rejections_total CounterVec is shared
	// across all 429 sources.
	terminalActiveCounter := middleware.NewActiveCounter(
		"workspace_terminal_active",
		cfg.RateLimit.TerminalActiveMax,
		&middleware.ActiveCounterMetrics{
			Rejections: smithersMetrics.RateLimitRejectionsTotal,
			Gauge:      smithersMetrics.WorkspaceTerminalActiveConnections,
		},
	)
	workspaceTerminalHandler := &routes.WorkspaceTerminalHandler{
		Service:           workspaceService,
		Metrics:           smithersMetrics,
		AllowedOrigins:    apiAllowedOrigins(cfg),
		SessionCookieName: cfg.Auth.SessionCookieName,
		ActiveConnections: terminalActiveCounter,
	}
	telemetryHandler := &routes.TelemetryHandler{
		Metrics: smithersMetrics,
	}
	featureFlagHandler := &routes.FeatureFlagHandler{
		Config: cfg.FeatureFlags,
	}

	oauth2Service := services.NewOAuth2Service(queries)
	// AlphaAccess checker is used by the OAuth2 authorize endpoint to gate
	// code issuance behind the closed-alpha whitelist (ticket 0106). When
	// the closed-alpha gate is disabled (Community Edition / open builds),
	// the handler passes any authenticated user through.
	var oauth2AlphaAccess routes.OAuth2AlphaAccessChecker
	if queries != nil && cfg.Auth.ClosedAlphaEnabled {
		oauth2AlphaAccess = services.NewAlphaAccessService(queries)
	}
	devAutoAuthorizeUserID := int64(0)
	if strings.EqualFold(os.Getenv("SMITHERS_ENABLE_E2E_TEST_ROUTES"), "true") {
		devAutoAuthorizeUserID = 1
	}
	oauth2UpstreamAuthorizePath := "/api/auth/github"
	// If GitHub isn't configured but Auth0 is, route the browser detour
	// through Auth0 so /api/oauth2/authorize still completes end-to-end.
	if githubClient == nil && auth0Configured {
		oauth2UpstreamAuthorizePath = "/api/auth/auth0/authorize"
	}
	oauth2Handler := &routes.OAuth2Handler{
		Service:                  oauth2Service,
		AuditService:             auditService,
		Metrics:                  smithersMetrics,
		CookieSecure:             cfg.Auth.CookieSecure,
		AlphaAccess:              oauth2AlphaAccess,
		DevAutoAuthorizeUserID:   devAutoAuthorizeUserID,
		DevAutoAuthorizeClientID: services.FirstPartyClientID,
		UpstreamAuthorizePath:    oauth2UpstreamAuthorizePath,
	}

	// Linear integration (multi-tenant sync engine embedded in Go API).
	var linearHandler *routes.LinearIntegrationHandler
	if linearEnabled {
		linearHandler = &routes.LinearIntegrationHandler{
			Service:        linearIntegrationSvc,
			Sync:           linearSyncSvc,
			SyncOperations: linearSyncSvc,
			AuthConfig:     routes.NewLinearAuthConfig(cfg.Auth.CookieSecure),
			Repos:          queries,
		}
		slog.Info("linear integration enabled")
	}

	pushHookHandler := &routes.InternalPushHookHandler{
		RepoResolver:   queries,
		Dispatcher:     webhookDispatcher,
		ConfigSync:     configSyncService,
		SearchIndex:    services.NewSearchIndexer(queries, repoHostClient, pool),
		ChangeRecorder: changeService,
	}
	if cfg.FeatureFlags.Workflows {
		pushHookHandler.WorkflowSync = workflowSyncService
		pushHookHandler.WorkflowRun = workflowRunService
	}
	canaryReportHandler := &routes.CanaryReportHandler{
		Store: queries,
	}
	workflowHandler := &routes.WorkflowHandler{
		Service: workflowAPIService,
	}
	workflowCacheHandler := &routes.WorkflowCacheHandler{
		Service: workflowCacheService,
	}
	workflowArtifactHandler := &routes.WorkflowArtifactHandler{
		Service: workflowArtifactService,
	}

	issueEventHandler := &routes.IssueEventHandler{
		Service: issueEventService,
		Broker:  sseBroker,
	}

	authService.SetRevocationPublisher(revocationPublisher)
	oauth2Service.SetRevocationPublisher(revocationPublisher)
	adminUserService.SetRevocationPublisher(revocationPublisher)
	orgService.SetRevocationPublisher(revocationPublisher)
	pairSessionService.SetRevocationPublisher(revocationPublisher)
	repoGatewayService.SetRevocationPublisher(revocationPublisher)
	agentService.SetRevocationPublisher(revocationPublisher)
	repoService.SetRevocationPublisher(revocationPublisher)
	if !options.Role.hosted() {
		// These HTTP surfaces operate on fleet placement, runner, canary, or
		// durable import state excluded from the single-owner product schema.
		// The shared router already treats nil handlers as absent routes.
		runnerHandler = nil
		adminRunnerHandler = nil
		adminSystemStatusHandler = nil
		adminSystemCanariesHandler = nil
		adminSystemIncidentsHandler = nil
		adminSystemMetricsHandler = nil
		canaryReportHandler = nil
		repoGatewayHandler = nil
		gitHubImportHandler = nil
	}

	var r http.Handler = buildRouter(
		cfg,
		queries,
		pool,
		repoHandler,
		mirrorSyncHandler,
		authHandler,
		userHandler,
		sshKeyHandler,
		deployKeyHandler,
		labelHandler,

		orgHandler,
		landingHandler,
		changesetHandler,
		buildCacheHandler,
		stackHandler,
		searchHandler,
		issueHandler,

		wikiService,
		gitHandler,
		notificationHandler,
		pairHandler,
		pairSessionHandler,

		runnerHandler,
		adminRunnerHandler,
		adminUserHandler,
		adminOrgHandler,
		adminRepoHandler,
		adminSystemHealthHandler,
		adminSystemStatusHandler,
		adminSystemCanariesHandler,
		adminSystemIncidentsHandler,
		adminSystemMetricsHandler,
		adminGitHubAppHandler,
		adminAuditHandler,
		webhookHandler,
		secretHandler,
		providerConnectionHandler,
		variableHandler,
		billingHandler,
		protectedBookmarkHandler,
		commitStatusHandler,
		lfsHandler,
		jjVCSHandler,
		agentInternalHandler,
		agentSessionHandler,
		agentSessionStreamHandler,
		approvalsHandler,
		branchLockHandler,
		pushHookHandler,
		canaryReportHandler,
		workflowHandler,
		workflowCacheHandler,
		workflowArtifactHandler,

		issueEventHandler,
		workspaceHandler,
		workspaceInternalHandler,
		repoGatewayHandler,
		anonSandboxHandler,
		gitHubProxyHandler,
		gitHubRepoListHandler,
		gitHubUserReposHandler,
		gitHubSyncedReposHandler,
		gitHubImportHandler,
		workspaceTerminalHandler,
		telemetryHandler,
		featureFlagHandler,
		oauth2Handler,
		linearHandler,
		gitHubWebhookHandler,
		smithersMetrics,
		alertRemediationWorker != nil,
	)
	r = mountBlobTransferHandler(r, blobStore)

	requestTracker := newInFlightRequestTracker()
	handler := requestTracker.Wrap(r)
	srv := buildHTTPServer(cfg, handler)

	// Start landing worker in a background goroutine.
	workerCtx, workerCancel := context.WithCancel(ctx)
	defer workerCancel()
	var joinedWorkers []*joinedBackgroundWorker
	launchWorker := func(run func()) {
		joinedWorkers = append(joinedWorkers, startJoinedBackgroundWorker(run))
	}
	var wikiHistoryWorker *joinedBackgroundWorker
	if options.Role.workers() && cfg.FeatureFlags.Wiki {
		wikiHistoryWorker = startJoinedBackgroundWorker(func() { services.RunWikiHistory(workerCtx, pool, repoHostClient) })
	}
	if options.Role.workers() {
		launchWorker(func() { landingWorker.Start(workerCtx) })
		launchWorker(func() { providerConnectionRefreshWorker.Start(workerCtx) })
		launchWorker(func() { workflowLogBudgetBackfiller.Start(workerCtx) })
	}
	if options.Role.clusterWorkers() {
		launchWorker(func() { runnerStaleSweeper.RunStaleSweeper(workerCtx, 30*time.Second) })
	}
	var gitHubImportWorker *joinedBackgroundWorker
	if options.Role.clusterWorkers() && provisioningEnforced {
		gitHubImportWorker = startJoinedBackgroundWorker(func() {
			gitHubImportService.Start(workerCtx)
		})
	} else if options.Role.clusterWorkers() {
		slog.Error("durable GitHub import worker is disabled until repository provisioning enforcement is enabled")
	}
	if options.Role.workers() && cfg.FeatureFlags.Workflows {
		launchWorker(func() { cronSchedulerWorker.Start(workerCtx) })
		launchWorker(func() { gitHubWebhookEventWorker.Start(workerCtx) })
		launchWorker(func() { repositoryJobService.Start(workerCtx) })
		if options.Role.clusterWorkers() {
			launchWorker(func() { workflowSandboxSchedulerWorker.Start(workerCtx) })
		}
		if options.Role.clusterWorkers() && alertRemediationWorker != nil {
			launchWorker(func() { alertRemediationWorker.Start(workerCtx) })
		}
	}
	if options.Role.workers() {
		launchWorker(func() { webhookWorker.Start(workerCtx) })
	}
	// R3: the reconciliation backstop for the synced GitHub metadata store —
	// webhooks are hints; this sweep (oldest staleness first, adaptive
	// interval clamped 45s–8h, 14-strike hard fail) is the truth.
	if options.Role.workers() {
		launchWorker(func() { gitHubSyncedRepoService.StartReconciler(workerCtx) })
		launchWorker(func() { pairSessionService.StartStaleSweeper(workerCtx) })
		agentService.StartSessionReaper(workerCtx, time.Duration(cfg.Sandbox.AgentMaxRuntimeSecs)*time.Second)
		if cfg.Sandbox.AnonEnabled {
			anonSandboxService.StartReaper(workerCtx)
		}
		authCleaner.Start(workerCtx)
		workflowCacheCleaner.Start(workerCtx)
		workflowArtifactCleaner.Start(workerCtx)
		auditCleaner.Start(workerCtx)
		workspaceCleaner.Start(workerCtx)
	}
	if options.Role.clusterWorkers() {
		launchWorker(func() { repositoryStorageReconciler.Start(workerCtx) })
		launchWorker(func() { repositoryProvisioningReconciler.Start(workerCtx) })
		launchWorker(func() { repoGatewayService.StartReaper(workerCtx) })
		launchWorker(func() { sandboxOrphanReaper.Start(workerCtx) })
		storageDeletionCleaner.Start(workerCtx)
		egressAuditCleaner.Start(workerCtx)
		if cfg.Sandbox.GoldenSnapshotsEnabled {
			goldenSnapshotService.Start(workerCtx)
		}
	}

	// Backfill github_app_installation_repositories from live installation state
	// on boot. The table is otherwise written only by webhook events, so any
	// installation created before webhook wiring never appears and
	// GetGitHubAppStatus reports "not installed" for every repo. Non-blocking so a
	// slow/failed GitHub round-trip never delays serving; no-ops cleanly when app
	// credentials are unconfigured.
	if options.Role.workers() {
		launchWorker(func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("github_app.reconcile.boot_panic", "panic", r, "stack", string(debug.Stack()))
				}
			}()
			if err := repoConnectionService.ReconcileGitHubAppInstallations(workerCtx); err != nil {
				slog.Error("github_app.reconcile.boot_failed", "error", err)
			}
		})
	}

	// Register signals before listening so the first SIGTERM is never lost.
	sigCh := make(chan os.Signal, 1)
	if !options.externalHTTP && options.Role.servesHTTP() {
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		defer signal.Stop(sigCh)
	}

	// Graceful shutdown
	shutdownDone := make(chan struct{})
	abortShutdown := make(chan struct{})
	var shutdownFailure error // synchronized by shutdownDone closing
	go func() {
		defer close(shutdownDone)
		select {
		case <-sigCh:
		case <-ctx.Done():
		case <-abortShutdown:
		}
		if !options.externalHTTP && options.Role.servesHTTP() {
			signal.Stop(sigCh)
		}
		inFlightAtSIGTERM := requestTracker.BeginShutdown()
		slog.Info("shutting down", "shutdown_timeout", shutdownTimeout.String(), "in_flight_requests_at_sigterm", inFlightAtSIGTERM)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		shutdownErr := srv.Shutdown(shutdownCtx)
		if drainErr := requestTracker.WaitForDrain(shutdownCtx); drainErr != nil {
			shutdownErr = errors.Join(shutdownErr, drainErr)
		}
		drained, killed, activeRemaining := requestTracker.Snapshot()

		// Keep background services alive while in-flight HTTP requests drain. A
		// request may still enqueue work or read from a service-owned stream; stopping
		// those dependencies before Shutdown returns makes otherwise drainable
		// requests fail during a rollout.
		poolStatsCancel()
		workerCancel()
		if wikiHistoryWorker != nil {
			wikiShutdownCtx, cancelWikiShutdown := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			if err := wikiHistoryWorker.Wait(wikiShutdownCtx); err != nil {
				slog.Error("wiki history worker shutdown timed out", "error", err)
			}
			cancelWikiShutdown()
		}
		if gitHubImportWorker != nil {
			// The HTTP drain may consume its whole deadline. Give the durable
			// worker its own bounded drain window so cancellation-triggered claim
			// release finishes before run returns and closes the shared DB pool.
			workerShutdownCtx, workerShutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
			if err := gitHubImportWorker.Wait(workerShutdownCtx); err != nil {
				slog.Warn("durable GitHub import worker did not stop before shutdown deadline", "error", err)
			}
			workerShutdownCancel()
		}
		workerWaitCtx, stopWorkers := context.WithTimeout(context.Background(), shutdownTimeout)
		for _, worker := range joinedWorkers {
			if err := worker.Wait(workerWaitCtx); err != nil {
				shutdownErr = errors.Join(shutdownErr, fmt.Errorf("background worker did not stop: %w", err))
				break
			}
		}
		stopWorkers()
		if options.Role.workers() {
			authCleaner.Stop()
			workflowCacheCleaner.Stop()
			workflowArtifactCleaner.Stop()
			auditCleaner.Stop()
			workspaceCleaner.Stop()
		}
		if options.Role.clusterWorkers() {
			storageDeletionCleaner.Stop()
			egressAuditCleaner.Stop()
			goldenSnapshotService.Stop()
		}
		// Release the LISTEN connection before run closes the shared pool.
		stopRevocationBus()

		attrs := []any{
			"in_flight_requests_at_sigterm", inFlightAtSIGTERM,
			"drained", drained,
			"killed", killed,
			"active_remaining", activeRemaining,
			"shutdown_timeout", shutdownTimeout.String(),
		}
		if shutdownErr != nil {
			shutdownFailure = shutdownErr
			attrs = append(attrs, "error", shutdownErr)
			slog.Warn(fmt.Sprintf("in-flight requests at SIGTERM: %d, drained: %d, killed: %d", inFlightAtSIGTERM, drained, killed), attrs...)
			return
		}
		slog.Info(fmt.Sprintf("in-flight requests at SIGTERM: %d, drained: %d, killed: %d", inFlightAtSIGTERM, drained, killed), attrs...)
	}()
	if options.externalHTTP || !options.Role.servesHTTP() {
		if err := ctx.Err(); err != nil {
			<-shutdownDone
			return errors.Join(err, shutdownFailure)
		}
		if options.ready != nil {
			if options.Role.servesHTTP() {
				options.ready(handler)
			} else {
				options.ready(nil)
			}
		}
		<-shutdownDone
		return shutdownFailure
	}

	slog.Info("API server listening", "addr", cfg.Server.Addr)
	ln, err := netListen("tcp", srv.Addr)
	if err != nil {
		slog.Error("server error", "error", err)
		close(abortShutdown)
		<-shutdownDone
		return err
	}
	onListen(ln)
	if err := srv.Serve(ln); err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		close(abortShutdown)
		<-shutdownDone
		return err
	}
	<-shutdownDone
	return shutdownFailure
}

// revocationBusStopTimeout bounds how long shutdown waits for the revocation
// listener to release its pooled connection.
const revocationBusStopTimeout = 5 * time.Second

// stopRevocationListener cancels the revocation bus's LISTEN loop and waits,
// bounded by timeout, for it to exit and release its pooled connection. It is
// safe to call again from deferred cleanup after the signal shutdown path.
func stopRevocationListener(cancel context.CancelFunc, bus *revocation.Bus, timeout time.Duration) {
	cancel()
	select {
	case <-bus.Done():
	case <-time.After(timeout):
		slog.Warn("revocation bus did not stop before the shutdown deadline",
			"timeout", timeout.String())
	}
}

// validateProductionBlobStore fails startup unless one durable adapter is
// configured. Local filesystem storage is the ordinary self-hosted default;
// GCS remains the cluster adapter.
func validateProductionBlobStore(environment string, cfg config.BlobConfig) error {
	if strings.EqualFold(strings.TrimSpace(environment), "production") &&
		strings.TrimSpace(cfg.GCSBucket) == "" && strings.TrimSpace(cfg.DataDir) == "" {
		return fmt.Errorf("SMITHERS_BLOB_DATA_DIR or SMITHERS_BLOB_GCS_BUCKET is required in production")
	}
	return nil
}
