// Package app is the public composition boundary for the Smithers product
// backend. Deployments configure and launch this package instead of importing
// product handlers or domain services directly.
package app

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"

	"go.opentelemetry.io/otel/sdk/trace"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/repository"
)

// Config holds the process-level inputs of the shared backend. The product
// routes, services, jobs, and database are assembled by the common
// implementation. A deployment can pass its configuration file using Args.
type Config struct {
	// Admission is the complete quota authority. Multitenant deployments must
	// supply it; Commerce is optional and supplied only to HTTP processes.
	Admission admission.Policy
	Commerce  commerce.Service
	Args      []string
	Stdout    io.Writer
	Stderr    io.Writer
	// Duties selects which halves of the product this process runs. The zero
	// value serves HTTP and runs the background workers together; a deployment
	// that scales them separately starts one process per duty.
	Duties Duties
	// TraceExporter is built by the deployment and runs through the common
	// telemetry pipeline. Nil selects the local none/OTLP configuration.
	TraceExporter trace.SpanExporter
	// Blobs and AgentLogs are deployment adapters. Nil uses the configured
	// single-process default, which the self-hosted app supplies locally.
	Blobs       ports.BlobStore
	AgentLogs   ports.AgentLogStore
	MetricsDoer ports.MetricsDoer
	// Repository is the same native Git/jj client in local and Plue modes.
	// A local host supplies repository.OpenLocal(...).Client(); Plue supplies
	// repository.NewRemoteClient(...).
	Repository *repository.Client
	// RepositoryPlacement is supplied by a hosted deployment and keyed by the
	// canonical repository ID. Single-owner installations leave it nil.
	RepositoryPlacement ports.RepositoryPlacement
	// Workspace supplies the common execution boundary. The app closes it after
	// requests and workers stop. Local deployments supply a trusted process
	// runtime; hosted deployments supply an isolated runtime.
	Workspace ports.WorkspaceRuntime
	// FlowHostRegistry is the verified set of packaged canonical Flow hosts.
	// Nil leaves durable Flow admission unavailable for development setups
	// without a built host bundle.
	FlowHostRegistry *flowmanifest.Registry
	// FlowHostProductAPIURL is the backend origin reachable from the managed
	// host's network, which may differ from the browser's public origin.
	FlowHostProductAPIURL string
	// ChatHost selects a model host for each authenticated turn. Hosted
	// deployments must resolve the grant's owner to an isolated host; a
	// process-global host containing other owners' credentials is unsafe.
	ChatHost ports.ChatHost
	// ChatCallbackListener serves producer callbacks on a private network.
	// Local combined mode creates a loopback listener when this is nil.
	ChatCallbackListener net.Listener
	// ChatProducerBaseURL is the URL of ChatCallbackListener reachable from
	// the selected model host. It is required for hosted workers.
	ChatProducerBaseURL string
	Recommender         ports.Recommender
	RecommendationLog   ports.RecommendationLog
	ModelStreamHost     ports.ModelStreamHost
}

// Duties is one process's share of the product composition.
type Duties string

const (
	DutiesAll     Duties = ""
	DutiesHTTP    Duties = "http"
	DutiesWorkers Duties = "workers"
)

// Instance is one running product composition. Its handler is the real shared
// route set; callers can mount it on their own HTTP server while the bounded
// background workers run under the same lifecycle.
type Instance struct {
	handler http.Handler
	cancel  context.CancelFunc
	done    chan struct{}
	err     error
}

func (instance *Instance) Handler() http.Handler { return instance.handler }

// Wait returns when the product workers and resources have stopped.
func (instance *Instance) Wait() error {
	<-instance.done
	return instance.err
}

// Close stops new requests, drains in-flight handlers, and stops workers.
// The supplied context bounds the caller's wait; cleanup continues if it
// expires so resources are never abandoned solely because a caller timed out.
func (instance *Instance) Close(ctx context.Context) error {
	instance.cancel()
	select {
	case <-instance.done:
		return instance.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Start assembles the shared product without opening an HTTP listener. Plue
// and other hosts can mount Handler on their own server. One instance per
// process is supported; the extracted product currently owns process-wide
// logging and revocation state.
func Start(ctx context.Context, cfg Config) (*Instance, error) {
	ctx, cancel := context.WithCancel(ctx)
	instance := &Instance{cancel: cancel, done: make(chan struct{})}
	ready := make(chan http.Handler, 1)
	stdout, stderr := writers(cfg)
	go func() {
		instance.err = closeWorkspace(cfg.Workspace, compose.StartWithOptions(ctx, append([]string(nil), cfg.Args...), stdout, stderr, cfg.options(), func(handler http.Handler) {
			ready <- handler
		}))
		close(instance.done)
	}()
	select {
	case handler := <-ready:
		instance.handler = handler
		return instance, nil
	case <-instance.done:
		cancel()
		if instance.err == nil {
			return nil, errors.New("backend stopped before becoming ready")
		}
		return nil, instance.err
	case <-ctx.Done():
		cancel()
		<-instance.done
		return nil, errors.Join(ctx.Err(), instance.err)
	}
}

// Run starts the same product assembly used by the Smithers executable and
// Plue. It returns when the context is cancelled and cleanup completes, or
// when startup or a worker fails.
func Run(ctx context.Context, cfg Config) error {
	stdout, stderr := writers(cfg)
	return closeWorkspace(cfg.Workspace, compose.RunWithOptions(ctx, append([]string(nil), cfg.Args...), stdout, stderr, cfg.options()))
}

// options maps Config to the composition options. Start and Run share it so
// a new field cannot reach one entry point and miss the other.
func (cfg Config) options() compose.Options {
	return compose.Options{
		Admission: cfg.Admission, Commerce: cfg.Commerce,
		Duties:                compose.Duties(cfg.Duties),
		TraceExporter:         cfg.TraceExporter,
		Blobs:                 cfg.Blobs,
		AgentLogs:             cfg.AgentLogs,
		MetricsDoer:           cfg.MetricsDoer,
		Repository:            cfg.Repository,
		RepositoryPlacement:   cfg.RepositoryPlacement,
		Workspace:             cfg.Workspace,
		FlowHostRegistry:      cfg.FlowHostRegistry,
		FlowHostProductAPIURL: cfg.FlowHostProductAPIURL,
		ChatHost:              cfg.ChatHost,
		ChatCallbackListener:  cfg.ChatCallbackListener,
		ChatProducerBaseURL:   cfg.ChatProducerBaseURL,
		Recommender:           cfg.Recommender,
		RecommendationLog:     cfg.RecommendationLog,
		ModelStreamHost:       cfg.ModelStreamHost,
	}
}

func closeWorkspace(runtime ports.WorkspaceRuntime, runErr error) error {
	if runtime == nil {
		return runErr
	}
	return errors.Join(runErr, runtime.Close())
}

func writers(cfg Config) (io.Writer, io.Writer) {
	stdout := cfg.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := cfg.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	return stdout, stderr
}
