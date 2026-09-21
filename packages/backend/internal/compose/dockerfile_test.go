package compose

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestServerDockerfile_ProvidesWorkflowParserRuntime(t *testing.T) {
	t.Parallel()

	_, thisFile, _, ok := runtime.Caller(0)
	require.True(t, ok)

	dockerfilePath := filepath.Join(filepath.Dir(thisFile), "Dockerfile")
	contentBytes, err := os.ReadFile(dockerfilePath)
	require.NoError(t, err)

	content := string(contentBytes)
	lower := strings.ToLower(content)

	assert.Regexp(t, `FROM node:[0-9]+-alpine@sha256:[a-f0-9]{64} AS workflow-runtime`, content)
	assert.Regexp(t, `FROM oven/bun:[0-9]+\.[0-9]+\.[0-9]+-alpine@sha256:[a-f0-9]{64}`, content)
	assert.Contains(t, content, "WORKDIR /app")
	assert.Contains(t, content, "corepack prepare pnpm@11.24.0 --activate")
	assert.Contains(t, content, "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /app/")
	assert.Contains(t, content, "pnpm install --ignore-workspace --frozen-lockfile")
	assert.NotContains(t, content, "COPY poc/ /app/poc/")
	assert.NotContains(t, content, "COPY --from=workflow-runtime /app/apps /app/apps")
	assert.Contains(t, content, "COPY scripts/workflow-evaluator.ts /app/scripts/workflow-evaluator.ts")
	assert.Contains(t, content, "COPY scripts/lib/workflow-renderer.ts /app/scripts/lib/workflow-renderer.ts")
	assert.Contains(t, content, "CGO_ENABLED=0 go build -buildvcs=false -o /smithers ./cmd/smithers/")
	assert.Contains(t, content, "COPY --chown=bun:bun --from=builder /smithers /usr/local/bin/smithers")
	assert.Contains(t, content, "test -s /usr/local/bin/smithers")
	assert.Contains(t, content, "/usr/local/bin/smithers --help >/tmp/smithers-cli-help")
	assert.Contains(t, content, "grep -Eiq 'Smithers CLI|Plue CLI|Usage: (smithers|plue)' /tmp/smithers-cli-help")
	assert.Contains(t, lower, "pnpm install --ignore-workspace --frozen-lockfile")
	assert.Contains(t, content, "COPY --chown=bun:bun --from=workflow-runtime /app/node_modules /app/node_modules")
	assert.Contains(t, content, "COPY --chown=bun:bun --from=workflow-runtime /app/scripts /app/scripts")
}
