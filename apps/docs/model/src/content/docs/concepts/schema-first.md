---
title: "Schema-first model calls"
description: "Why @smthrs/model splits a call into Protocol, Endpoint, Auth, and Framing, and why the request is sealed data."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/concepts/schema-first.md"
---

The package's central bet: a model call is data before it is I/O. The
`ModelRequest` you build is a serializable, credential-free value; the
provider body derived from it is validated against a schema; and the bytes
sent are a deterministic encoding of that validated value. This page explains
the four-way split that falls out of that bet, and the sealing discipline it
enables.

## The request is a schema value

`ModelRequest` and every part inside it are Effect Schema classes. Decoding
validates, encoding produces plain JSON, and the field declaration order is
stable. That last property is load-bearing: a durable engine keys a sealed
model step on the serialized request, so two runs that issue the same call
must produce byte-identical key material. The schema is what makes that
promise enforceable rather than conventional.

`GenerationParams` follows the same discipline in the small: every field is
optional, and an omitted field leaves the provider's default in place, so a
request never smuggles in an unstated knob. The Anthropic Messages lowering is
the one exception, because that API requires a budget: an omitted `maxTokens`
is sent as the model's output ceiling from `ModelCatalog.maxOutputTokensFor`,
or as `max_tokens: 4096` for a model the catalog has not met. Dropping a knob is
a separate rule from defaulting one. A protocol with no wire field for a stated
knob leaves it out of the body, so `topK`, `stopSequences`, and `thinkingBudget`
are absent from both OpenAI bodies, and the ChatGPT backend refuses a stated
`maxTokens` in `Route.prepare` rather than sending the request without it. On
Anthropic, `reasoningEffort` becomes `output_config.effort` (clamped to the
levels the model accepts, with adaptive thinking) and is dropped for a model
with no effort control.

## Four pieces, four reasons to change

A deployment of a model API varies along four independent axes, and the
package gives each its own interface:

- `Protocol` owns the wire shape of an API family: lowering a `ModelRequest`
  into the provider body, decoding framed events, running the state machine
  that emits `ModelEvent`s, and classifying a failed response. Anthropic
  Messages and OpenAI Responses are different protocols because their bodies
  and events differ.
- `Endpoint` owns where the request goes. It is public data, part of the
  step's key material, so its validation rejects anything that could carry a
  secret.
- `Auth` owns the credential. It signs a copy of the headers as the request
  leaves, and its optional `refresh` is the one sanctioned recovery from an
  `authentication` failure.
- `Framing` owns how response bytes become frames. Server-sent events and
  newline-delimited JSON are framings, not protocols: the same protocol
  decoder can sit behind either.

The split pays off at composition time. OpenAI's Responses protocol serves
three deployments in this package alone: `api.openai.com` with an API key,
an OpenAI-compatible host with its own origin, and the ChatGPT-subscription
backend with OAuth and a narrowed body. Same protocol, three endpoints and
three auths. Conversely, `api.openai.com` and a chat-compatible gateway
share nothing on the wire, so they are different protocols behind one
`Model` interface.

## Preparation seals the call

`Route.prepare` compiles a request exactly once: schema validation of the
`ModelRequest`, protocol lowering, schema validation of the provider body,
public-header checks, then canonical encoding. The result is a
`PreparedRequest`: route id, protocol id, method, URL, public headers, and
canonical body bytes.

Two disciplines meet in that value. First, the snapshot: every later step
reads the compiled view, so a caller mutating the request object while
signing is pending cannot change what is sent. Second, the credential
boundary: the `PreparedRequest` contains no secret, which is what allows a
durable engine to digest it into a sealed-step key and to journal it.
`Auth.sign` applies the credential to a copy of the headers at the transport
edge, and a route header whose name looks like a credential is refused,
because a secret in the sealed view would leak into keys, journals, and
diagnostics at once.

## Canonical JSON is strict on purpose

The body bytes come from `CanonicalJson`, which sorts object keys
recursively and rejects any value `JSON.stringify` would silently drop or
reshape: `undefined`, functions, symbols, non-finite numbers, class
instances, symbol-keyed members, cycles. Silence here is the failure mode
that matters: if the encoder dropped a value, the sealed-step key and the
wire body would describe different requests, and a replay could serve a
cached answer to a call that never happened. Rejection keeps the key and the
bytes the same statement. [`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/) makes the
opposite choice, mirroring `JSON.stringify` exactly, and is the right
encoder for everything that is not a provider request body.

## Deferred tools are replay-safe by construction

Native deferred tool loading changes the wire body, so the package gates it
twice: per protocol and per model, from explicit allowlists, and per
request, by a `resolve` that reads only the sealed request itself: declared
`deferred` annotations, the tool calls in the transcript, and the
`addedToolNames` activations in tool results. No process-local activation
state is consulted. A replayed run therefore derives the identical tool
partition, which is the property a durable executor needs from every input
to a sealed step. A lazy tool may never add prompt text for the same reason:
changing the prompt prefix would change the step key of every request that
declares it.

Anthropic activation keeps tool references and the original output together
inside `tool_result.content`. Activation never promotes tool output to user
text. Results without new references retain their string content.

For the mechanics of the stream these sealed calls produce, see
[Streaming](/concepts/streaming/). For the full interface list, see the
[API reference](/reference/api/).
