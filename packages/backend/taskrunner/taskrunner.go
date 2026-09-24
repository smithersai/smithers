// Package taskrunner shares task execution and its authenticated API transport.
// Fleet registration, capacity and database claim coordination belong to the host.
package taskrunner

import (
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/taskrunner"
	"github.com/smithersai/smithers/packages/backend/internal/taskrunner/client"
	"github.com/smithersai/smithers/packages/backend/internal/taskrunner/executor"
)

type Task = db.WorkflowTask
type Executor = executor.Executor
type ExecutorConfig = executor.Config
type TaskPool = executor.TaskPool
type Client = client.Client
type ClientConfig = client.Config
type RegisterResponse = client.RegisterResponse
type AssignedTask = client.Task
type APIPool = taskrunner.APIPool

// RegisterInput is the neutral worker identity sent to the deployment API.
type RegisterInput struct {
	Name     string
	Metadata json.RawMessage
}

var NewClient = client.New
var NewExecutor = executor.NewExecutor
var NewAPIPool = taskrunner.NewAPIPool
