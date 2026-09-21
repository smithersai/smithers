#!/bin/sh
# Compile the public app API as a module outside this repository. A local
# replace points at this source checkout; there is no Plue or sibling checkout.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
consumer_dir=$(mktemp -d)
trap 'rm -rf "$consumer_dir"' EXIT HUP INT TERM
cat > "$consumer_dir/go.mod" <<EOF
module example.net/smithers-public-consumer

go 1.26.8

require github.com/smithersai/smithers v0.0.0

replace github.com/smithersai/smithers => $repo_dir
EOF
cat > "$consumer_dir/main.go" <<'EOF'
package main

import (
    "context"
	"net/http"

    "github.com/smithersai/smithers/packages/backend/app"
    "github.com/smithersai/smithers/packages/backend/ports"
)

func main() {
    var launch func(context.Context, app.Config) error = app.Run
	var start func(context.Context, app.Config) (*app.Instance, error) = app.Start
	var handler func(*app.Instance) http.Handler = (*app.Instance).Handler
    var executor ports.Executor
	_, _, _, _ = launch, start, handler, executor
}
EOF
cd "$consumer_dir"
GOWORK=off go mod tidy
GOWORK=off go build ./...
