package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	defaultWorkflowEvaluatorPath = "scripts/workflow-evaluator.ts"
	// workflowParseTimeout bounds a single evaluator (bun) execution so a
	// pathological workflow file cannot hold a parse slot forever.
	workflowParseTimeout = 30 * time.Second
	// maxConcurrentWorkflowParses bounds evaluator subprocesses process-wide.
	maxConcurrentWorkflowParses = 4
)

// workflowParseSlots gates evaluator subprocess spawns across all pushes so a
// burst of pushes carrying many workflow files cannot exhaust API CPU and
// process slots with unbounded bun processes.
var workflowParseSlots = make(chan struct{}, maxConcurrentWorkflowParses)

// WorkflowConfig is the normalized workflow shape consumed by runtime services.
type WorkflowConfig struct {
	On          WorkflowOnConfig           `json:"on"`
	Concurrency *WorkflowConcurrencyConfig `json:"concurrency,omitempty"`
	Jobs        map[string]JobConfig       `json:"jobs,omitempty"`
}

// WorkflowConcurrencyConfig is the workflow-level opt-out for superseded-run
// cancellation, the analogue of GitHub Actions' `concurrency.cancel-in-progress`.
// A push to a ref implicitly supersedes every older push run of the same
// workflow on that ref, so the platform cancels those runs instead of letting
// them hold runner capacity that no one is waiting on. A workflow whose push
// runs must each complete (a deploy, a release cut, anything that publishes)
// sets `concurrency: { cancelSuperseded: false }`.
type WorkflowConcurrencyConfig struct {
	// CancelSuperseded is nil when the workflow says nothing, which means the
	// default applies: true for push runs, and never for manual_dispatch or
	// schedule runs, which are not superseded by anything.
	CancelSuperseded *bool `json:"cancelSuperseded,omitempty"`
}

// UnmarshalJSON accepts both the camelCase spelling a TypeScript workflow
// definition writes (`cancelSuperseded`) and the snake_case spelling the rest
// of the stored config uses (`cancel_superseded`), so neither is silently
// ignored.
func (c *WorkflowConcurrencyConfig) UnmarshalJSON(data []byte) error {
	var raw struct {
		CancelSuperseded      *bool `json:"cancelSuperseded"`
		CancelSupersededSnake *bool `json:"cancel_superseded"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	c.CancelSuperseded = raw.CancelSuperseded
	if c.CancelSuperseded == nil {
		c.CancelSuperseded = raw.CancelSupersededSnake
	}
	return nil
}

// WorkflowParser parses TypeScript workflow files into WorkflowConfig.
type WorkflowParser interface {
	Parse(ctx context.Context, filePath string, content []byte) (*WorkflowConfig, error)
}

// WorkflowParserRunner executes external commands for workflow parsing.
type WorkflowParserRunner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type workflowParser struct {
	runner        WorkflowParserRunner
	evaluatorPath string
}

type workflowParserTempFile interface {
	Name() string
	Write([]byte) (int, error)
	Close() error
}

var (
	workflowParserCreateTemp = func(dir, pattern string) (workflowParserTempFile, error) {
		return os.CreateTemp(dir, pattern)
	}
	workflowParserRemove = os.Remove
)

// WorkflowParserOption configures workflow parser behavior.
type WorkflowParserOption func(*workflowParser)

// WithWorkflowParserRunner injects a command runner (used in tests).
func WithWorkflowParserRunner(runner WorkflowParserRunner) WorkflowParserOption {
	return func(p *workflowParser) {
		if runner != nil {
			p.runner = runner
		}
	}
}

// WithWorkflowParserEvaluatorPath overrides the evaluator script location.
func WithWorkflowParserEvaluatorPath(path string) WorkflowParserOption {
	return func(p *workflowParser) {
		if strings.TrimSpace(path) != "" {
			p.evaluatorPath = strings.TrimSpace(path)
		}
	}
}

// NewWorkflowParser constructs a WorkflowParser with default Bun execution behavior.
//
// Security note: workflow files are parsed using a static TypeScript AST
// analysis pass (scripts/workflow-evaluator.ts), NOT by importing or executing
// user code. The evaluator reads the workflow file, walks the AST, and emits a
// JSON config object without ever calling eval(), require(), or dynamic import.
// User-supplied workflow logic (shell commands, agent instructions, etc.) is
// only executed inside sandboxed runner pods, never on the API server.
//
// The security boundary is enforced at the evaluator level: user TSX is written
// to a temporary file whose path is passed to the evaluator, but the evaluator
// only reads the file as text and passes it to the TypeScript compiler's parse
// API. No user code runs in-process on the API server.
func NewWorkflowParser(opts ...WorkflowParserOption) WorkflowParser {
	parser := &workflowParser{
		runner:        commandRunner{},
		evaluatorPath: defaultWorkflowEvaluatorPath,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(parser)
		}
	}
	return parser
}

func (p *workflowParser) Parse(ctx context.Context, filePath string, content []byte) (*WorkflowConfig, error) {
	if len(content) > maxWorkflowFileBytes {
		return nil, fmt.Errorf("workflow file too large (%d bytes, max %d)", len(content), maxWorkflowFileBytes)
	}

	select {
	case workflowParseSlots <- struct{}{}:
		defer func() { <-workflowParseSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	parseCtx, cancel := context.WithTimeout(ctx, workflowParseTimeout)
	defer cancel()

	ext := ".tsx"
	if strings.HasSuffix(filePath, ".ts") {
		ext = ".ts"
	}
	tmpFile, err := workflowParserCreateTemp("", "smithers-workflow-*"+ext)
	if err != nil {
		return nil, fmt.Errorf("create temp workflow file: %w", err)
	}
	defer func() { _ = workflowParserRemove(tmpFile.Name()) }()

	if _, err := tmpFile.Write(content); err != nil {
		_ = tmpFile.Close()
		return nil, fmt.Errorf("write temp workflow file: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return nil, fmt.Errorf("close temp workflow file: %w", err)
	}

	stdout, err := p.runner.Run(parseCtx, "bun", "run", p.evaluatorPath, tmpFile.Name())
	if err != nil {
		if parseCtx.Err() != nil {
			return nil, fmt.Errorf("evaluate workflow %s: %w", filePath, parseCtx.Err())
		}
		return nil, fmt.Errorf("evaluate workflow %s: %w", filePath, err)
	}

	var cfg WorkflowConfig
	if err := json.Unmarshal(stdout, &cfg); err != nil {
		return nil, fmt.Errorf("invalid evaluator output for %s: %w", filePath, err)
	}
	return &cfg, nil
}

type commandRunner struct{}

func (commandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.Output()
	if err == nil {
		return stdout, nil
	}

	if ee, ok := err.(*exec.ExitError); ok {
		stderr := strings.TrimSpace(string(ee.Stderr))
		if stderr != "" {
			return nil, fmt.Errorf("%w: %s", err, stderr)
		}
	}
	return nil, err
}
