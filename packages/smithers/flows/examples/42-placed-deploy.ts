/**
 * Run a secret-using action only on the host that holds the secret.
 *
 * `Ship` calls `PushRelease`, which sends `DEPLOY_TOKEN` to the deploy
 * endpoint. The caller's engine has no such variable. Its `Hosts` table binds
 * the action's placement, `remote({ target: "deploy" })`, to the holder's
 * engine, which serves `PlacedAction.served(PushRelease)` and runs the body with
 * its own vault and its own deploy endpoint. The caller names a version and
 * journals the result; the value and the endpoint never enter its process.
 *
 * The holder requires a separate bearer credential before RPC dispatch.
 */
import { FlowProxy, FlowProxyServer, Hosts, PlacedAction } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Placement from "@smthrs/plan/Placement"
import { TestNodeRuntime } from "@smthrs/platform-node"
import * as Secret from "@smthrs/targets/Secret"
import * as SecretProxy from "@smthrs/targets/SecretProxy"
import * as Effect from "effect/Effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  type HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "effect/http"
import * as Layer from "effect/Layer"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import * as Schema from "effect/Schema"

/** A safe, serializable deployment failure; never contains request credentials. */
export class DeploymentError extends Schema.TaggedError<DeploymentError>()("DeploymentError", {
  reason: Schema.Literals(["transport", "status"]),
  status: Schema.optional(Schema.Number)
}) {}

/** Sends one release to the deploy endpoint with the deploy token. */
export const PushRelease = Action.make("examples/PlacedDeploy/PushRelease", {
  payload: { version: Schema.String },
  error: DeploymentError,
  success: Schema.Struct({ version: Schema.String, status: Schema.Number })
})

/** The flow a caller runs. Nothing in it names a machine or an endpoint. */
export const Ship = Flow.make("examples/PlacedDeploy/Ship", {
  payload: { version: Schema.String },
  error: DeploymentError,
  success: Schema.Struct({ version: Schema.String, status: Schema.Number }),
  body: (payload) => PushRelease.call(payload)
})

/** Where `PushRelease` runs: whichever host a table binds `deploy` to. */
export const deploy = Placement.remote({ target: "deploy" })

/**
 * The body, run with one host's environment and its deploy endpoint. The
 * vault mints a placeholder for `DEPLOY_TOKEN`, bound to that endpoint's
 * origin, and substitutes the value only while it builds the one request
 * there. A host without the variable fails with `SecretUnavailable`.
 */
export const push = (read: SecretProxy.Read, endpoint: string) => ({ version }: { readonly version: string }) =>
  Effect.gen(function*() {
    const vault = SecretProxy.makeVault({ read })
    const placeholder = vault.mint(Secret.HttpSecret(Secret.Secret("DEPLOY_TOKEN"), [endpoint]))
    const boundary = vault.request(new URL(endpoint).origin)
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.post(new URL("/release", endpoint).href).pipe(
        HttpClientRequest.setHeader("authorization", boundary.substitute(`Bearer ${placeholder}`)),
        HttpClientRequest.bodyText(version)
      )
    ).pipe(Effect.mapError(() => new DeploymentError({ reason: "transport" })))
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(new DeploymentError({ reason: "status", status: response.status }))
    }
    return { version, status: response.status }
  }).pipe(Effect.withSpan("examples.deploy.push"))

/**
 * The holder: a durable engine that serves `PushRelease` over HTTP on
 * `server` and runs its body with `read`, the holder's environment, against
 * `endpoint`, the holder's deploy endpoint.
 */
export const holder = <E, R>(
  filename: string,
  read: SecretProxy.Read,
  endpoint: string,
  server: Layer.Layer<HttpServer.HttpServer, E, R>,
  credential: string
) => {
  const served = PlacedAction.served(PushRelease)
  return HttpRouter.serve(
    RpcServer.layerHttp({ group: FlowProxy.toRpcGroup([served]), path: "/", protocol: "http" }).pipe(
      Layer.provide(FlowProxyServer.layerRpcHandlers([served])),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(
        HttpRouter.middleware(Effect.succeed((handler) =>
          Effect.gen(function*() {
            const request = yield* HttpServerRequest.HttpServerRequest
            if (!credential || request.headers.authorization !== `Bearer ${credential}`) {
              return HttpServerResponse.empty({ status: 401 })
            }
            return yield* handler
          })
        )).layer
      )
    )
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(PushRelease.toLayer(push(read, endpoint)), Interpreter.layer(served)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(TestNodeRuntime.durableEngine(filename, "examples-placed-deploy-holder"))
      )
    ),
    Layer.provideMerge(server),
    Layer.provide(FetchHttpClient.layer)
  )
}

/**
 * The caller: a durable engine that runs `Ship` and binds `deploy` to the
 * holder at `holderUrl`. Without one, `deploy` runs here, with `read` and
 * `endpoint` standing for this host's own environment and endpoint.
 */
export const caller = (
  filename: string,
  read: SecretProxy.Read,
  endpoint: string,
  holderUrl?: string,
  holderCredential?: string
) =>
  Layer.mergeAll(PlacedAction.layer(PushRelease, deploy, push(read, endpoint)), Interpreter.layer(Ship)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(TestNodeRuntime.durableEngine(filename, "examples-placed-deploy-caller")),
    Layer.provideMerge(
      holderUrl === undefined ? Hosts.layer({}) : Hosts.layer({
        deploy: {
          _tag: "Proxy",
          connect: (group) =>
            RpcClient.make(group).pipe(
              Effect.provide(
                RpcClient.layerProtocolHttp({
                  url: holderUrl,
                  transformClient: HttpClient.mapRequest(
                    HttpClientRequest.setHeader("authorization", `Bearer ${holderCredential ?? ""}`)
                  )
                }).pipe(
                  Layer.provide(RpcSerialization.layerJson),
                  Layer.provide(FetchHttpClient.layer)
                )
              )
            )
        }
      })
    ),
    Layer.provide(FetchHttpClient.layer)
  )
