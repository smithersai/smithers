package ports

import "github.com/smithersai/smithers/packages/backend/flowruntime"

// Composition aliases. Shared services import flowruntime directly so ports
// may continue to aggregate internal service aliases without dependency cycles.
const FlowRuntimeProtocol = flowruntime.Protocol

type FlowRuntimeIdentity = flowruntime.Identity
type FlowRuntimeTarget = flowruntime.Target
type FlowRuntimeResolver = flowruntime.Resolver
type FlowRuntimeResolverFunc = flowruntime.ResolverFunc
type FlowRuntimeFailure = flowruntime.Failure
type FlowRuntimeLaunch = flowruntime.Launch
type FlowRuntimeReceipt = flowruntime.Receipt
type FlowRuntimeLaunchResult = flowruntime.LaunchResult
type FlowRuntimeDecision = flowruntime.Decision
type FlowRuntimeSignal = flowruntime.Signal
type FlowRuntimeSteer = flowruntime.Steer
type FlowRuntimeLifecycle = flowruntime.Lifecycle
type FlowRuntimeMutationResult = flowruntime.MutationResult
type FlowRuntimeEventCursor = flowruntime.EventCursor
type FlowRuntimeEvent = flowruntime.Event
type FlowRuntimeRun = flowruntime.Run
type FlowRuntimeObservation = flowruntime.Observation
type FlowRuntime = flowruntime.Runtime
