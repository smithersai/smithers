package compose

import (
	"encoding/json"
	"net/http"
	"runtime"
	"runtime/debug"

	"github.com/go-chi/cors"
)

// appBootstrap describes only capabilities that this assembled process can
// actually serve. The browser reads it before making any authenticated call.
type appBootstrap struct {
	APIVersion   int      `json:"apiVersion"`
	Host         string   `json:"host"`
	Version      string   `json:"version"`
	BuildSHA     string   `json:"buildSha"`
	Capabilities []string `json:"capabilities"`
	AuthFlow     string   `json:"authFlow"`
	Sandbox      *struct {
		Platform string `json:"platform"`
		Mode     string `json:"mode"`
	} `json:"sandbox"`
}

type bootstrapFeatures struct {
	role             Role
	identity         bool
	redirectAuth     bool
	agent            bool
	billingCheckout  bool
	workspaceRuntime bool
	isolatedSandbox  bool
}

func newAppBootstrap(features bootstrapFeatures) appBootstrap {
	version, sha := buildIdentity()
	result := appBootstrap{APIVersion: 1, Host: "local", Version: version, BuildSHA: sha,
		Capabilities: make([]string, 0, 4), AuthFlow: "none"}
	if features.role.hosted() {
		result.Host = "cloud"
	}
	if features.identity {
		result.Capabilities = append(result.Capabilities, "identity")
		if features.redirectAuth {
			result.AuthFlow = "redirect"
		} else if !features.role.hosted() {
			result.AuthFlow = "native-handoff"
		}
	}
	if features.agent {
		result.Capabilities = append(result.Capabilities, "agent")
	}
	if features.billingCheckout {
		result.Capabilities = append(result.Capabilities, "billing.checkout")
	}
	if features.workspaceRuntime || features.isolatedSandbox {
		mode := "trusted-only"
		if features.isolatedSandbox {
			mode = "enforced"
		}
		result.Sandbox = &struct {
			Platform string `json:"platform"`
			Mode     string `json:"mode"`
		}{Platform: runtime.GOOS, Mode: mode}
	}
	return result
}

func buildIdentity() (version, sha string) {
	version, sha = "dev", "unknown"
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return version, sha
	}
	if info.Main.Version != "" && info.Main.Version != "(devel)" {
		version = info.Main.Version
	}
	for _, setting := range info.Settings {
		if setting.Key == "vcs.revision" && setting.Value != "" {
			sha = setting.Value
			break
		}
	}
	return version, sha
}

func withAppBootstrap(next http.Handler, bootstrap appBootstrap, corsOptions cors.Options) http.Handler {
	bootstrapHandler := cors.Handler(corsOptions)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "GET, HEAD")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodHead {
			return
		}
		_ = json.NewEncoder(w).Encode(bootstrap)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/bootstrap" {
			next.ServeHTTP(w, r)
			return
		}
		bootstrapHandler.ServeHTTP(w, r)
	})
}
