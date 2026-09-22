package compose

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type flowComposition struct {
	jobs       *jobs.Store
	dispatcher *flowdispatch.Service
	bindings   *flowhost.Store
	stopper    flowhost.RetirementStopper
}

func newFlowComposition(options runOptions, cfg *config.Config, pool *pgxpool.Pool, codec flowhost.SecretCodec, agents *services.AgentService) (*flowComposition, error) {
	if options.FlowHostRegistry == nil {
		return nil, nil
	}
	if options.Workspace == nil {
		return nil, errors.New("Flow hosts require the shared workspace runtime")
	}
	productAPIURL, err := flowHostProductAPIURL(options, cfg.Server.Addr)
	if err != nil {
		return nil, err
	}
	registry := options.FlowHostRegistry
	catalogs := []flowhost.Catalog{
		{
			Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding,
			Executable: registry.Coding.Executable, ArtifactDigest: registry.Coding.SHA256,
			ServiceName: "smithers-coding-host", ImplementationModel: strings.TrimSpace(cfg.Sandbox.WorkspaceCodingDefaultModel),
		},
		{
			Key: flowhost.CatalogLibrarian, Family: flowhost.CatalogLibrarian,
			Executable: registry.Librarian.Executable, ArtifactDigest: registry.Librarian.SHA256,
			ServiceName: "smithers-librarian-host", ProductAPIURL: productAPIURL,
			ImplementationModel: strings.TrimSpace(os.Getenv("SMITHERS_LIBRARIAN_MODEL")),
		},
	}
	bindings, err := flowhost.NewStore(pool, codec)
	if err != nil {
		return nil, fmt.Errorf("Flow host bindings: %w", err)
	}
	targets, err := services.NewAgentFlowHostTargetResolver(agents)
	if err != nil {
		return nil, fmt.Errorf("Flow host targets: %w", err)
	}
	launcher, err := flowhost.NewWorkspaceLauncher(options.Workspace)
	if err != nil {
		return nil, fmt.Errorf("Flow workspace launcher: %w", err)
	}
	stopper, ok := launcher.(flowhost.RetirementStopper)
	if !ok {
		return nil, errors.New("Flow workspace launcher cannot stop retired hosts")
	}
	resolver, err := flowhost.New(flowhost.Config{Store: bindings, Targets: targets, Launcher: launcher, Catalogs: catalogs})
	if err != nil {
		return nil, fmt.Errorf("Flow host resolver: %w", err)
	}
	store, err := jobs.NewStore(pool)
	if err != nil {
		return nil, fmt.Errorf("Flow jobs: %w", err)
	}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: resolver, Projector: agents})
	if err != nil {
		return nil, fmt.Errorf("Flow dispatcher: %w", err)
	}
	return &flowComposition{jobs: store, dispatcher: dispatcher, bindings: bindings, stopper: stopper}, nil
}

func (flow *flowComposition) recover(ctx context.Context) error {
	if _, err := flow.jobs.RecoverExpiredForOperations(ctx,
		[]string{flowdispatch.OperationLaunch, flowdispatch.OperationApprove}, 100); err != nil {
		return fmt.Errorf("recover Flow operations: %w", err)
	}
	if err := flow.bindings.ReconcileRetired(ctx, flow.stopper, 100); err != nil {
		return fmt.Errorf("retire Flow hosts: %w", err)
	}
	return nil
}

func (flow *flowComposition) maintainRetired(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := flow.bindings.ReconcileRetired(ctx, flow.stopper, 100); err != nil && ctx.Err() == nil {
				slog.Error("retire Flow hosts", "error", err)
			}
		}
	}
}

func flowHostProductAPIURL(options runOptions, listenAddress string) (string, error) {
	if origin := strings.TrimRight(strings.TrimSpace(options.FlowHostProductAPIURL), "/"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" ||
			parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
			return "", errors.New("Flow host product API URL must be an HTTP origin")
		}
		return origin, nil
	}
	if options.Role.hosted() || options.externalHTTP {
		return "", errors.New("Flow hosts require a runtime-reachable product API URL")
	}
	_, port, err := net.SplitHostPort(listenAddress)
	if err != nil || port == "" || port == "0" {
		return "", errors.New("Flow hosts require a fixed local backend port")
	}
	return "http://" + net.JoinHostPort("127.0.0.1", port), nil
}
