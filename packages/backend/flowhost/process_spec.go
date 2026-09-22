package flowhost

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"path"
	"strconv"
	"strings"
)

// BuildProcessSpec materializes the one reviewed host command after the
// deployment adapter allocates a port in its own network namespace. Both
// trusted-process and Plue launch this spec; only their transport differs.
func BuildProcessSpec(launch HostLaunch, paths WorkspacePaths, port uint16) (ProcessSpec, error) {
	if err := bindingMatches(launch.Binding, launch.Authority, launch.Catalog); err != nil {
		return ProcessSpec{}, err
	}
	if strings.TrimSpace(launch.Credential) == "" || port == 0 {
		return ProcessSpec{}, errors.New("flow host process needs a credential and allocated port")
	}
	root := strings.TrimSpace(paths.Root)
	stateBase := strings.TrimSpace(paths.StateDir)
	if root == "" || stateBase == "" || !path.IsAbs(root) || !path.IsAbs(stateBase) {
		return ProcessSpec{}, errors.New("flow host workspace root and state directory must be absolute runtime paths")
	}
	stateDir := path.Join(stateBase, "flow-runtime", launch.Binding.ID)
	environment := make(map[string]string, len(launch.Catalog.Environment)+8)
	for name, value := range launch.Catalog.Environment {
		environment[name] = value
	}
	environment["SMITHERS_API_KEY"] = launch.Credential
	environment["SMITHERS_GATEWAY_ID"] = launch.Binding.ID
	environment["SMITHERS_OWNER_GENERATION"] = strconv.FormatInt(launch.Binding.OwnerGeneration, 10)
	environment["SMITHERS_FLOW_ARTIFACT_SHA256"] = launch.Binding.RuntimeArtifactDigest
	environment["SMITHERS_SOURCE_REVISION"] = launch.Binding.SourceRevision
	switch launch.Catalog.Family {
	case CatalogCoding:
		environment["SMITHERS_CODING_IMPLEMENT_MODEL"] = launch.Catalog.ImplementationModel
	case CatalogLibrarian:
		if strings.TrimSpace(launch.Authority.Repository) == "" {
			return ProcessSpec{}, errors.New("librarian host needs its authorized repository name")
		}
		environment["SMITHERS_REPO"] = launch.Authority.Repository
		environment["SMITHERS_PRODUCT_API_URL"] = launch.Catalog.ProductAPIURL
		environment["SMITHERS_LIBRARIAN_MODEL"] = launch.Catalog.ImplementationModel
	default:
		return ProcessSpec{}, errors.New("flow host family is unsupported")
	}
	args := []string{launch.Catalog.Executable, "serve", "--root", root, "--state-dir", stateDir,
		"--host", "127.0.0.1", "--port", strconv.Itoa(int(port)), "--listen"}
	identityInput := strings.Join([]string{launch.Binding.ID, launch.Catalog.Key, launch.Catalog.Executable,
		launch.Binding.RuntimeArtifactDigest, launch.Binding.SourceRevision,
		strconv.FormatInt(launch.Binding.OwnerGeneration, 10), root, stateDir, strconv.Itoa(int(port))}, "\x00")
	digest := sha256.Sum256([]byte(identityInput))
	return ProcessSpec{
		Name: launch.Binding.ServiceName, Identity: "flow-host:" + hex.EncodeToString(digest[:]),
		Args: args, Environment: environment, ReadyAddress: net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))),
		ReadyTimeout: launch.Catalog.ReadyTimeout,
	}, nil
}
