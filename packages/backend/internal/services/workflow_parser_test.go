package services

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockWorkflowParserRunner struct {
	runFn func(ctx context.Context, name string, args ...string) ([]byte, error)

	names [][]string
	args  [][]string
}

func (m *mockWorkflowParserRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	m.names = append(m.names, []string{name})
	m.args = append(m.args, append([]string(nil), args...))
	if m.runFn != nil {
		return m.runFn(ctx, name, args...)
	}
	return nil, nil
}

func TestWorkflowParser_Parse_Success(t *testing.T) {
	t.Parallel()

	tsContent := []byte(`export default { on: { push: {} }, jobs: { build: { "runs-on": "ubuntu-latest" } } };`)
	runner := &mockWorkflowParserRunner{
		runFn: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			require.Len(t, args, 3)
			assert.Equal(t, "run", args[0])
			assert.Equal(t, "scripts/workflow-evaluator.ts", args[1])
			assert.Equal(t, ".tsx", filepath.Ext(args[2]))

			written, err := os.ReadFile(args[2])
			require.NoError(t, err)
			assert.Equal(t, tsContent, written)

			return []byte(`{"on":{"push":{}},"jobs":{"build":{"runs-on":"ubuntu-latest"}}}`), nil
		},
	}

	parser := NewWorkflowParser(
		WithWorkflowParserRunner(runner),
		WithWorkflowParserEvaluatorPath("scripts/workflow-evaluator.ts"),
	)

	cfg, err := parser.Parse(context.Background(), ".smithers/workflows/build.tsx", tsContent)
	require.NoError(t, err)
	require.NotNil(t, cfg)
	require.Contains(t, cfg.Jobs, "build")

	require.Len(t, runner.names, 1)
	assert.Equal(t, "bun", runner.names[0][0])
}

func TestWorkflowParser_Parse_InvalidJSONOutput_ReturnsError(t *testing.T) {
	t.Parallel()

	runner := &mockWorkflowParserRunner{
		runFn: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return []byte(`not json`), nil
		},
	}

	parser := NewWorkflowParser(WithWorkflowParserRunner(runner))
	cfg, err := parser.Parse(context.Background(), ".smithers/workflows/build.tsx", []byte("export default {};"))
	require.Error(t, err)
	assert.Nil(t, cfg)
	assert.Contains(t, err.Error(), "invalid")
}

func TestWorkflowParser_Parse_BunExecutionError_ReturnsError(t *testing.T) {
	t.Parallel()

	runner := &mockWorkflowParserRunner{
		runFn: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return nil, errors.New("bun failed: syntax error")
		},
	}

	parser := NewWorkflowParser(WithWorkflowParserRunner(runner))
	cfg, err := parser.Parse(context.Background(), ".smithers/workflows/build.tsx", []byte("export default {}"))
	require.Error(t, err)
	assert.Nil(t, cfg)
	assert.Contains(t, err.Error(), "bun failed")
}

func TestWorkflowParser_Parse_MissingDefaultExport_ReturnsError(t *testing.T) {
	t.Parallel()

	runner := &mockWorkflowParserRunner{
		runFn: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return nil, errors.New("workflow module must default export an object")
		},
	}

	parser := NewWorkflowParser(WithWorkflowParserRunner(runner))
	cfg, err := parser.Parse(context.Background(), ".smithers/workflows/build.tsx", []byte("export const x = 1;"))
	require.Error(t, err)
	assert.Nil(t, cfg)
	assert.Contains(t, err.Error(), "default export")
}

func TestWorkflowParser_Parse_ContextCancelled_ReturnsContextError(t *testing.T) {
	t.Parallel()

	runner := &mockWorkflowParserRunner{
		runFn: func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}

	parser := NewWorkflowParser(WithWorkflowParserRunner(runner))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	cfg, err := parser.Parse(ctx, ".smithers/workflows/build.tsx", []byte("export default {}"))
	require.Error(t, err)
	assert.Nil(t, cfg)
	assert.ErrorIs(t, err, context.Canceled)
}

func TestWorkflowParser_Parse_TSFile_UsesTSExtension(t *testing.T) {
	t.Parallel()

	tsContent := []byte(`export default { on: { push: {} }, jobs: { lint: { "runs-on": "ubuntu-latest" } } };`)
	runner := &mockWorkflowParserRunner{
		runFn: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			require.Len(t, args, 3)
			assert.Equal(t, "run", args[0])
			// The temp file should have .ts extension, not .tsx
			assert.Equal(t, ".ts", filepath.Ext(args[2]))

			written, err := os.ReadFile(args[2])
			require.NoError(t, err)
			assert.Equal(t, tsContent, written)

			return []byte(`{"on":{"push":{}},"jobs":{"lint":{"runs-on":"ubuntu-latest"}}}`), nil
		},
	}

	parser := NewWorkflowParser(WithWorkflowParserRunner(runner))

	cfg, err := parser.Parse(context.Background(), ".smithers/workflows/lint.ts", tsContent)
	require.NoError(t, err)
	require.NotNil(t, cfg)
	require.Contains(t, cfg.Jobs, "lint")
}

func TestWorkflowParser_Parse_TSXFile_UsesTSXExtension(t *testing.T) {
	t.Parallel()

	runner := &mockWorkflowParserRunner{
		runFn: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			require.Len(t, args, 3)
			// The temp file should have .tsx extension for .tsx source files
			assert.Equal(t, ".tsx", filepath.Ext(args[2]))
			return []byte(`{"on":{"push":{}},"jobs":{}}`), nil
		},
	}

	parser := NewWorkflowParser(WithWorkflowParserRunner(runner))

	cfg, err := parser.Parse(context.Background(), ".smithers/workflows/build.tsx", []byte("export default {}"))
	require.NoError(t, err)
	require.NotNil(t, cfg)
}

func TestWorkflowParser_Parse_RejectsOversizedSourceBeforeRunner(t *testing.T) {
	t.Parallel()

	runner := &mockWorkflowParserRunner{}
	parser := NewWorkflowParser(WithWorkflowParserRunner(runner))
	_, err := parser.Parse(context.Background(), ".smithers/workflows/large.tsx", bytes.Repeat([]byte("x"), maxWorkflowFileBytes+1))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "too large")
	assert.Empty(t, runner.names)
}
