package control

import "testing"

// The workspace create body carries the staged CLI, coding host and jj export
// helper inline; together they passed 16 MiB on 2026-09-15 and every create
// answered 413. The limit must leave room for those payloads to grow.
func TestControllerRequestBodyLimitFitsStagedWorkspacePayloads(t *testing.T) {
	t.Parallel()
	const stagedPayloadsBytes = 8<<20 + 2<<20 + 6<<20 // cli + coding host + jj export, compressed+base64
	if maxRequestBody < 2*stagedPayloadsBytes {
		t.Fatalf("maxRequestBody=%d leaves no headroom over the %d bytes of staged workspace payloads", maxRequestBody, stagedPayloadsBytes)
	}
}
