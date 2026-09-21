package workspace_scripts

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

// nativeCodingModules are the Python suites that drive the pinned guest jj
// through coding.py. Each is sharded into independent python processes that
// run as parallel Go subtests: the suite is dominated by jj subprocess calls
// (1,000+ per full run, each a fresh process against a throwaway repo), so
// its wall time is the sum of those calls when run in one process and the
// largest shard when sharded. One process needed 266s on a loaded 16-core
// host, past the unit gate's 300s package timeout; six-test shards keep the
// gate inside the same bound with margin.
var nativeCodingModules = []string{"coding_test", "coding_engine_test", "coding_history_test", "coding_files_test", "coding_source_import_test", "coding_source_create_test"}

// nativeCodingShardSize bounds the tests per python process.
const nativeCodingShardSize = 6

// nativeCodingShardTimeout bounds one shard's python process. It is the
// per-process budget the unsharded suite had; a shard runs at most six of
// its tests.
const nativeCodingShardTimeout = 5 * time.Minute

var (
	nativeCodingClassRE = regexp.MustCompile(`^class (\w+)\(`)
	nativeCodingTestRE  = regexp.MustCompile(`^    def (test_\w+)\(`)
)

// nativeCodingTestIDs lists the module's tests as unittest dotted ids
// (module.Class.test_name) in source order, so shards address exact tests
// rather than -k substring patterns.
func nativeCodingTestIDs(t *testing.T, module string) []string {
	t.Helper()
	source, err := os.ReadFile(module + ".py")
	if err != nil {
		t.Fatalf("read %s.py: %v", module, err)
	}
	var ids []string
	class := ""
	for _, line := range strings.Split(string(source), "\n") {
		if m := nativeCodingClassRE.FindStringSubmatch(line); m != nil {
			class = m[1]
			continue
		}
		if m := nativeCodingTestRE.FindStringSubmatch(line); m != nil {
			if class == "" {
				t.Fatalf("%s.py: test %s precedes any class", module, m[1])
			}
			ids = append(ids, module+"."+class+"."+m[1])
		}
	}
	if len(ids) == 0 {
		t.Fatalf("%s.py declares no test methods", module)
	}
	return ids
}

func nativeCodingShards(ids []string, size int) [][]string {
	var shards [][]string
	for start := 0; start < len(ids); start += size {
		end := start + size
		if end > len(ids) {
			end = len(ids)
		}
		shards = append(shards, ids[start:end])
	}
	return shards
}

func requireNativeCodingToolchain(t *testing.T) {
	t.Helper()
	version, err := exec.Command("jj", "--version").Output()
	if err != nil || !strings.HasPrefix(string(version), "jj 0.39.0") {
		t.Skip("requires pinned native JJ 0.39.0")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("requires sandbox Python 3")
	}
}

// runNativeCodingShard runs the listed unittest ids in one python process
// and fails the subtest on any failure or on the shard's own deadline.
func runNativeCodingShard(t *testing.T, ids []string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), nativeCodingShardTimeout)
	defer cancel()
	args := append([]string{"-m", "unittest", "-v"}, ids...)
	start := time.Now()
	output, err := exec.CommandContext(ctx, "python3", args...).CombinedOutput()
	t.Logf("shard %s: %d tests in %s\n%s", ids[0], len(ids), time.Since(start).Round(time.Millisecond), output)
	if ctx.Err() != nil {
		t.Fatalf("shard exceeded %s: %v", nativeCodingShardTimeout, ctx.Err())
	}
	if err != nil {
		t.Fatal(err)
	}
	// unittest exits 0 only after printing OK; guard against a run that
	// matched nothing (an id typo would otherwise pass silently).
	ran := fmt.Sprintf("Ran %d tests", len(ids))
	if len(ids) == 1 {
		ran = "Ran 1 test"
	}
	if !strings.Contains(string(output), ran) {
		t.Fatalf("shard ran a different number of tests than its %d ids", len(ids))
	}
}

func TestCodingNative(t *testing.T) {
	requireNativeCodingToolchain(t)
	for _, module := range nativeCodingModules {
		for index, shard := range nativeCodingShards(nativeCodingTestIDs(t, module), nativeCodingShardSize) {
			shard := shard
			t.Run(fmt.Sprintf("%s/%d", module, index), func(t *testing.T) {
				t.Parallel()
				runNativeCodingShard(t, shard)
			})
		}
	}
}

func TestCodingEligibilityNative(t *testing.T) {
	if os.Getenv("SMITHERS_JJ_EXPORT_BINARY") == "" {
		t.Skip("requires built smithers-jj-export native helper")
	}
	requireNativeCodingToolchain(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	output, err := exec.CommandContext(ctx, "python3", "-m", "unittest", "coding_eligibility_test", "-v").CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
