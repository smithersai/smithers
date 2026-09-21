package services

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Exercise the production shell with controlled download bytes. An altered
// archive must fail before its extractor or installed binary can run.
func TestRepoGatewayDownloadsVerifyBeforeExtraction(t *testing.T) {
	for _, tool := range []string{"bun", "jj"} {
		for _, valid := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/valid=%v", tool, valid), func(t *testing.T) {
				dir := t.TempDir()
				bin := filepath.Join(dir, "bin")
				require.NoError(t, os.Mkdir(bin, 0o755))
				write := func(name, body string) {
					require.NoError(t, os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/bash\nset -eu\n"+body), 0o755))
				}
				fixture := filepath.Join(dir, "download")
				require.NoError(t, os.WriteFile(fixture, []byte("trusted archive"), 0o600))
				write("uname", "echo x86_64\n")
				write("curl", "while [ \"$#\" -gt 0 ]; do if [ \"$1\" = -o ]; then cp "+shellQuote(fixture)+" \"$2\"; exit; fi; shift; done; exit 1\n")
				marker := filepath.Join(dir, "extracted")
				installed := filepath.Join(dir, "installed")
				version := "jj 0.44.0"
				script := strings.ReplaceAll(repoGatewayJJInstallScript, "/usr/local/bin/jj", installed)
				digest := "0a07bab4641a55fd2bc2fd1563ba3a3f9a577584086ad74086a1c5b69b3ffce9"
				extractor, flag, relative := "tar", "-C", "jj"
				if tool == "bun" {
					version = repoGatewayBunVersion
					script = "bun_version=" + shellQuote(version) + "\nstaged_bun_path=" + shellQuote(installed) + "\n" + repoGatewayBunDownloadScript
					digest = "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452"
					extractor, flag, relative = "unzip", "-d", "bun-linux-x64/bun"
				}
				write(extractor, "touch "+shellQuote(marker)+"\nwhile [ \"$1\" != "+shellQuote(flag)+" ]; do shift; done\nmkdir -p \"$2/$(dirname "+shellQuote(relative)+")\"\nprintf '%s\\n' '#!/bin/sh' "+shellQuote("echo "+shellQuote(version))+" > \"$2/"+relative+"\"\n")
				if valid {
					script = strings.ReplaceAll(script, digest, fmt.Sprintf("%x", sha256.Sum256([]byte("trusted archive"))))
				}
				cmd := exec.Command("bash", "-c", "set -euo pipefail\n"+script)
				cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
				output, err := cmd.CombinedOutput()
				if valid {
					require.NoError(t, err, string(output))
					require.FileExists(t, installed)
				} else {
					require.Error(t, err, string(output))
					require.NoFileExists(t, marker, "unverified archive reached extractor")
					require.NoFileExists(t, installed, "unverified binary installed")
				}
			})
		}
	}
}
