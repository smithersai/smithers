// Package webhooks exposes the shared product event contract to deployment workers.
package webhooks

import impl "github.com/smithersai/smithers/packages/backend/internal/webhooks"

type Dispatcher = impl.Dispatcher
type EventType = impl.EventType
type RepositoryPayload = impl.RepositoryPayload
type WorkflowRunEventPayload = impl.WorkflowRunEventPayload
type WorkflowRunPayload = impl.WorkflowRunPayload

const EventTypeWorkflowRun = impl.EventTypeWorkflowRun
