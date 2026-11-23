---
title: "Authorize network and model calls"
description: "How the HTTP decorator names a request as a capability: the method-to-action mapping, the implicit https scheme, per-hop redirect checks, and marking a request as a model call."
sidebar:
  order: 5
---

Network access is Effect's `HttpClient`, and the kernel decorates it. There is
no Smithers transport port beneath it, because a raw port would be a second way
to reach the network whose contract never mentions permission.

## What a request is checked as

The decorator derives one capability per request:

| Request                                                     | Action       |
| ----------------------------------------------------------- | ------------ |
| `GET` or `HEAD`                                             | `net:get`    |
| Every other method                                          | `net:post`   |
| Inside `withModelCall`, and the request asks for that model | `model:call` |

The resource is the URL host, and the scheme decides how it is written:

- For an `https:` URL, the resource is the **lowercased host** alone:
  `https://API.Example.test/v1/x` names `api.example.test`.
- For every other scheme, the resource is `<scheme>//<lowercased host>`:
  `http://API.Example.test/x` names `http://api.example.test`.
- A trailing dot is dropped from the host, so the fully qualified
  `https://api.example.test./x` names `api.example.test` too, and a rule for
  the bare host also governs the dotted spelling.

`https` is therefore the implicit scheme, and a grant for `api.example.test`
can never authorize a cleartext `http` downgrade to the same host. The path,
the query, and the headers are not part of the resource.

A URL that is not absolute and parseable fails with `permission_denied` and
the reason `"HTTP capability checks require an absolute, parseable URL"`.

## Mark a model call

The same host answers many models, and a grant for one must not be a grant for
the rest. Effect's tag has no room for an extra method, so the caller claims
the model around the request:

```ts
import { HttpClient } from "@smthrs/kernel"

const call = provider.chat(request).pipe(
  HttpClient.withModelCall("claude-sonnet-4-5")
)
```

The claim is not trusted. For each request inside `call`, the guard reads the
model out of the request itself and compares:

```text
claim             request sent                                  checked as
----------------  --------------------------------------------  ---------------------------------------
claude-haiku      POST /v1/messages  {"model":"claude-haiku"}   model:call  api.anthropic.com/claude-haiku
claude-haiku      POST /v1/messages  {"model":"claude-opus"}    net:post    api.anthropic.com
claude-haiku      GET  /v1/organizations/api_keys               net:get     api.anthropic.com
claude-haiku      POST /v1/files     (no model)                 net:post    api.anthropic.com
(ModelCall set    POST /v1/messages  {"model":"claude-haiku"}   net:post    api.anthropic.com
 by hand)
```

So a grant for `api.anthropic.com/claude-haiku` sends Haiku requests and
nothing else. `HttpClient.ModelCall` holds the claimed id for a transport or a
trace to read; setting it yourself changes no check.

### What counts as asking for a model

`HttpClient.layer` reads the one top-level `model` string of a `POST`
request's JSON body (`HttpClient.declaredModel`). That is where the Anthropic
Messages, OpenAI Chat Completions and OpenAI Responses protocols name the
model. A streamed body, a body that is not one JSON object, and a body that
spells `model` twice all name no model.

That default reads the body, not the path. A `POST` endpoint on the same host
that accepts a top-level `model` field would pass it. Pin the endpoints to
close that, and to read a protocol that names the model in a header:

```ts
import { HttpClient } from "@smthrs/kernel"

const guarded = HttpClient.layerWith({
  modelIdentity: HttpClient.modelEndpoints([
    { url: "https://api.anthropic.com/v1/messages" },
    { url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", identity: HttpClient.headerModel("ai-model-id") }
  ])
})
```

With `modelEndpoints`, a request to any URL that is not listed names no model.
The URL is compared exactly, query included. The identity is captured when the
host builds the layer, so nothing a flow provides later replaces it.

`authorizePreflight` authorizes `net:get` and `net:post` only. A model call is
checked when it is sent.

## Every redirect hop is checked

A redirect is a second network destination, so it needs a second grant check.
Two halves guarantee it:

1. The client below the decorator must **not** follow redirects on its own:
   Undici with no redirect interceptor, or Effect's fetch layer with
   `redirect: "manual"`. The decorator forces `redirect: "manual"` on the
   `RequestInit` of every request it executes, so a plain
   `FetchHttpClient.layer` cannot walk to another origin either. A custom
   client that ignores `RequestInit` must meet the precondition itself.
2. By default, the decorator composes Effect's `followRedirects` **above** the guard, so
   every hop re-enters the guarded path and is checked exactly like hop zero.
   A hop of a model call is read again: a redirected `GET` carries no body, so
   it is checked as `net:get` on the new host.

An authorized origin cannot lend its grant to another.

To handle redirects yourself, provide `FetchHttpClient.RequestInit` with
`redirect: "manual"` around the guarded request. It returns the first hop's
response without contacting the redirect target. Your loop owns the hop
limit, and each subsequent request through the guarded client receives its
own grant check. Other request options are preserved. A manual setting
provided privately to the raw host client only prevents transport-level
redirects; the guarded client still follows redirects by default.

## Read a refusal back

Effect's tag fixes the error channel to `HttpClientError`, so a refusal arrives
projected. The reason is always a `TransportError`: the request did not leave
the host. `description` carries the human rendering, and `cause` carries the
structured kernel failure:

```ts
import { HttpClient } from "@smthrs/kernel"
import { Option } from "effect"

const permission = HttpClient.fromHttpClientError(failure)
// Option.some({ code, capability, tier, requestId, ... })
```

`Option.none()` means the failure was a genuine transport problem, not a
permission decision.

## Requests are snapshotted

A request record a caller still holds is a way to change the destination after
it was authorized. The decorator snapshots the URL parameters, the headers, and
the body, copying byte buffers and form data, before any permission suspension.
A body that is neither immutable nor copyable fails with
`"HTTP request must be an immutable supported request description"`.

## Hosts with no network

`HttpClient.layerNoop()` provides a client whose every request fails with a
`TransportError` naming the request, whose cause is an `HttpClient.HttpUnavailable`
with the message `"HTTP is unavailable on this host"`. Use it for a host that
genuinely cannot reach the network, so an unconfigured capability answers rather
than vanishing. `HttpClient.isUnavailable(error)` tells that refusal apart from
a live request that failed in the network, which raises the same reason tag.
`@smthrs/testing/TestHost` composes it.

## Related

- [Write a capability policy](./write-a-capability-policy.md): naming hosts and
  models in rules.
- [Decoration in place](../concepts/decoration-in-place.md): why the error is
  projected rather than widened.
