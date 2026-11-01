# `@smthrs/secrets`

Secrets a sandbox or a flow step uses without holding them. The guest holds a
placeholder. Its outbound HTTP goes through the egress, which puts the value
in place of the placeholder in the request's headers only when the request is
for one of that secret's own hosts and methods, over HTTPS. The egress never
follows a redirect, records each decision by name, and scrubs every echo of a
value from the answer before the guest reads it.

It uses Effect's `HttpClient` and imports no Node built-in, so it runs in a
browser, a Worker, Node and Bun. The host provides three things: the
`HttpClient` requests leave through, an `Egress.Vault` that reveals a value by
name, and an `Egress.Audit` that records decisions.

**Documentation:** [`docs/`](docs/README.md)

## Install

The package is private in this repository. Add it as a workspace dependency,
with `effect` at this exact version.

```json
{
  "dependencies": {
    "@smthrs/secrets": "workspace:*",
    "effect": "4.1.0"
  }
}
```

## Quickstart

```ts
import { Egress } from "@smthrs/secrets"
import * as Effect from "effect/Effect"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

const PLACEHOLDER = "smthrs-secret-" + "0".repeat(64)

const policy: Egress.Policy = {
  secrets: [{ name: "STRIPE_KEY", placeholder: PLACEHOLDER, hosts: ["api.stripe.com"], methods: ["GET", "POST"] }],
  allow: []
}

// The guest's request carries the placeholder; api.stripe.com receives the value.
const request = HttpClientRequest.get("https://api.stripe.com/v1/charges").pipe(
  HttpClientRequest.setHeader("authorization", `Bearer ${PLACEHOLDER}`)
)

const host = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(Egress.Vault, Egress.Vault.of({ reveal: () => Effect.succeed(Redacted.make("sk_live_...")) })),
  Layer.succeed(Egress.Audit, Egress.Audit.of({ record: (entry) => Effect.log("egress", entry.outcome) }))
)

const answer = Egress.execute(request, policy).pipe(Effect.provide(host))
```

A sandbox's intercepted request goes through `Egress.forward(request, policy)`,
which answers an `HttpServerResponse`: the scrubbed answer, or the refusal's
code with its status.

## Learn more

- [Overview and guarantees](docs/README.md)
- [API reference](docs/api.md)
