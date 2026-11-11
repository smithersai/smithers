/** Barrel parity with the platform-browser and platform-bun packages. */
import { describe, expect, it } from "@effect/vitest"
import * as DestinationProxy from "../src/DestinationProxy.ts"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import * as FetchTransport from "../src/FetchTransport.ts"
import * as Index from "../src/index.ts"
import * as NativeRuntime from "../src/NativeRuntime.ts"
import * as NodeGarbageCollector from "../src/NodeGarbageCollector.ts"
import * as NodeHost from "../src/NodeHost.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"
import * as TestNodeRuntime from "../src/TestNodeRuntime.ts"

describe("@smthrs/platform-node barrel", () => {
  it("re-exports every module as a namespace", () => {
    expect(Object.keys(Index).sort()).toEqual([
      "DestinationProxy",
      "EgressHttpClient",
      "FetchTransport",
      "HostLiveness",
      "NativeRuntime",
      "NodeGarbageCollector",
      "NodeHost",
      "NodeLanguageServer",
      "NodeRuntime",
      "ProcessConfinement",
      "ProcessReaper",
      "ProcessSandbox",
      "SandboxedFlow",
      "ScopedProcess",
      "TestNodeRuntime"
    ])
    expect(Index.NodeGarbageCollector.layer).toBe(NodeGarbageCollector.layer)
    expect(Index.NodeHost.layer).toBe(NodeHost.layer)
    expect(Index.NodeHost.layerAt).toBe(NodeHost.layerAt)
    expect(Index.NodeHost.layerContained).toBe(NodeHost.layerContained)
    expect(Index.NodeHost.layerContainedAt).toBe(NodeHost.layerContainedAt)
    expect(Index.DestinationProxy.isolated).toBe(DestinationProxy.isolated)
    expect(Index.EgressHttpClient.layer).toBe(EgressHttpClient.layer)
    expect(Index.FetchTransport.observe).toBe(FetchTransport.observe)
    expect(Index.NodeLanguageServer.layer).toBe(NodeLanguageServer.layer)
    expect(Index.EgressHttpClient.resolveHost).toBe(EgressHttpClient.resolveHost)
    expect(Index.NodeHost.EgressHttpClient).toBe(EgressHttpClient)
    expect(Index.ProcessConfinement.make).toBe(ProcessConfinement.make)
    expect(Index.ProcessConfinement.layer).toBe(ProcessConfinement.layer)
    expect(Index.ProcessSandbox.plan).toBe(ProcessSandbox.plan)
    expect(Index.ProcessSandbox.wrap).toBe(ProcessSandbox.wrap)
    expect(Index.ScopedProcess.spawn).toBe(ScopedProcess.spawn)
    expect(Index.ScopedProcess.status).toBe(ScopedProcess.status)
    expect(Index.NativeRuntime.make).toBe(NativeRuntime.make)
    expect(Index.NodeRuntime.layerHost).toBe(NodeRuntime.layerHost)
    expect(Index.SandboxedFlow.execute).toBe(SandboxedFlow.execute)
    expect(Index.TestNodeRuntime.durableEngine).toBe(TestNodeRuntime.durableEngine)
  })
})
