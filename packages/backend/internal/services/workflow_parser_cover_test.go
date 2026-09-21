package services

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
)

type workflowParserCovRunner struct {
	stdout []byte
	err    error
	name   string
	args   []string
}

func (r *workflowParserCovRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.name = name
	r.args = append([]string(nil), args...)
	return r.stdout, r.err
}

func TestWorkflowParser_Cov_ParseUsesRunnerAndEvaluatorPath(t *testing.T) {
	runner := &workflowParserCovRunner{stdout: []byte(`{"on":{"push":{}},"jobs":{"build":{"runs_on":"ubuntu"}}}`)}
	parser := NewWorkflowParser(WithWorkflowParserRunner(runner), WithWorkflowParserEvaluatorPath("custom/eval.ts"))

	cfg, err := parser.Parse(context.Background(), "workflow.ts", []byte("export default {}"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if cfg.On.Push == nil || runner.name != "bun" || len(runner.args) != 3 || runner.args[1] != "custom/eval.ts" || !strings.HasSuffix(runner.args[2], ".ts") {
		t.Fatalf("cfg=%+v runner=%+v", cfg, runner)
	}
}

func TestWorkflowParser_Cov_ParseErrorBranches(t *testing.T) {
	runner := &workflowParserCovRunner{err: errors.New("runner failed")}
	_, err := NewWorkflowParser(WithWorkflowParserRunner(runner)).Parse(context.Background(), "workflow.tsx", []byte("bad"))
	if err == nil || !strings.Contains(err.Error(), "evaluate workflow workflow.tsx") {
		t.Fatalf("runner err = %v", err)
	}

	runner = &workflowParserCovRunner{stdout: []byte(`not-json`)}
	_, err = NewWorkflowParser(WithWorkflowParserRunner(runner), WithWorkflowParserEvaluatorPath(" ")).Parse(context.Background(), "workflow.tsx", []byte("bad"))
	if err == nil || !strings.Contains(err.Error(), "invalid evaluator output") {
		t.Fatalf("json err = %v", err)
	}
}

func TestWorkflowParser_Cov_CommandRunnerRun(t *testing.T) {
	out, err := (commandRunner{}).Run(context.Background(), "sh", "-c", "printf ok")
	if err != nil || string(out) != "ok" {
		t.Fatalf("commandRunner success = %q, %v", string(out), err)
	}

	_, err = (commandRunner{}).Run(context.Background(), "sh", "-c", "printf bad >&2; exit 3")
	if err == nil || !strings.Contains(err.Error(), "bad") {
		t.Fatalf("commandRunner stderr err = %v", err)
	}

	_, err = (commandRunner{}).Run(context.Background(), "definitely-not-a-command")
	if err == nil {
		t.Fatal("expected missing command error")
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		t.Fatalf("missing command should not be ExitError: %v", err)
	}
}
