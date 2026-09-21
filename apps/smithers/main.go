package main

import (
	"os"

	"github.com/smithersai/smithers/packages/backend/cli"
)

func main() { os.Exit(cli.Run(os.Args[1:])) }
