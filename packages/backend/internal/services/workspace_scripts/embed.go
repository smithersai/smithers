package workspace_scripts

import _ "embed"

//go:embed download-release.ts
var DownloadReleaseScript string

//go:embed bootstrap.sh.tmpl
var BootstrapTemplate string

//go:embed bootstrap-nixos.sh.tmpl
var BootstrapNixOSTemplate string

//go:embed coding.py
var CodingScript string
