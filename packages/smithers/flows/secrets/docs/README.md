---
title: "@smthrs/secrets"
description: "Secrets a sandbox or a flow step uses without holding them: placeholders, per-secret hosts and methods, an egress that substitutes values in request headers only for a secret's own hosts, never follows redirects, audits by name and scrubs echoes from answers."
---

`@smthrs/secrets` keeps a secret's value out of the code that uses it. The
code, a sandbox's guest or a flow step, holds a placeholder such as
`smthrs-secret-3f…` (64 hexadecimal characters). Its HTTP requests leave
through the egress, and only there does a placeholder become its value, for
the hosts and methods the secret is bound to. The approach is the one Fly's
tokenizer, iron-proxy and Cloudflare's outbound Workers take: the guest can
use a credential against the hosts it was meant for, and can't read it.

## What it guarantees

- **No value reaches the guest.** The guest holds placeholders. A value
  exists only in the egress, for one request, in the header it was
  substituted into, and every echo in the answer is replaced with its
  placeholder.
- **Exact audiences.** A placeholder is substituted only when the request's
  URL host is exactly one of its secret's hosts, the method is one of its
  methods, the port is the scheme's own and the scheme is HTTPS. A host is a
  lowercase DNS name: no wildcard, IP address or single label. Every other
  request with a placeholder is refused unsent, and so is any request to a
  host the policy doesn't name.
- **Headers only.** Values go into header values, a Basic credential decoded
  and encoded again. A placeholder in the URL or the body reaches the host as
  the placeholder.
- **No redirects followed.** A 3xx answer returns to the guest with its
  `Location` scrubbed. The guest's next request is checked again, so a
  redirect to another host never gets a value.
- **Scrubbed answers.** Every answer's headers and body are scrubbed of every
  value in the policy, whichever host answers, since one host may read what
  another was sent: the value, its percent, JSON and base64 encodings at
  every byte alignment, as the body streams, across chunk boundaries. When
  the policy holds a secret, the egress asks for an uncompressed answer and
  drops `Range` and `If-Range`.
- **Bounded.** At most 16 placeholders per request and 64 KiB of headers after
  substitution. A value is 8 bytes to 16 KiB of printable ASCII with no
  leading or trailing spaces, so a header preserves its bytes. Values are
  checked before saving and again before forwarding.
- **Audited by name.** Each decision is recorded through the host's `Audit`
  before the request is sent: host, method, outcome and the secrets' names. A
  forwarded request that can't be recorded isn't sent.
- **Opaque telemetry.** One `Egress.execute` span and one count on
  `secret_egress_requests` by `outcome` per request; a log line with the host,
  method, status and number of secrets. The HTTP client's own span is off,
  and no failure carries the request. A forwarded request settles once its
  answer has streamed, through the caller's logger and metrics, wherever the
  host streams it. `HEAD` and statuses `204`, `205` and `304` settle
  immediately, without reading a body. For other `Egress.execute` answers,
  consume or drain `body` even when only the status or headers are needed.
  Successful answers log at Info as `forwarded`; a guest's interrupted
  download logs at Info as `cancelled`. A host's broken body logs at Warn as
  `broken`.

## What it doesn't do

- **Abuse of an allowed host.** Anything holding a placeholder can use the
  secret against its own hosts. Bind narrowly: few hosts, few methods.
- **Transformed echoes.** A host that returns the value hashed, reversed or
  in hexadecimal defeats scrubbing. Bind secrets only to hosts whose answers
  you have reviewed.
- **Bodies.** A value can't be substituted into a body, so a request that
  needs one there can't use a secret.

## Placeholders

`Placeholder.minter(key)` derives placeholders with HMAC-SHA-256 under a key
the host holds, from a scope (what the guest is, such as a repository, branch
and sandbox generation) and a secret's name. The host stores nothing to
recognize them: it derives them again to build the guest's `Policy`. A new
scope gets new placeholders, and the old ones are refused as
`unknown_placeholder`.

## The host's part

| Service        | What it does                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpClient`   | Sends the request. With Effect's Fetch client the egress sets `redirect: "manual"`; any other client must not follow redirects, and must decode a compressed answer as Fetch does |
| `Egress.Vault` | Reveals a value by name for one request, for example by opening a sealed row                                                                                                      |
| `Egress.Audit` | Records each decision                                                                                                                                                             |

## Refusals

| Code                    | Status | When                                                                    |
| ----------------------- | ------ | ----------------------------------------------------------------------- |
| `invalid_url`           | 400    | not an absolute `http:` or `https:` URL, or one with a user or password |
| `port_not_allowed`      | 403    | a port other than the scheme's own                                      |
| `host_not_allowed`      | 403    | a host neither `allow` nor any secret names                             |
| `unknown_placeholder`   | 403    | a placeholder the policy doesn't know                                   |
| `secret_not_allowed`    | 403    | a secret not bound to this host or method                               |
| `insecure_scheme`       | 403    | a placeholder over plain HTTP                                           |
| `too_many_placeholders` | 403    | more than 16 distinct placeholders                                      |
| `headers_too_large`     | 431    | headers over 64 KiB after substitution                                  |

`Egress.forward` answers 503 with `secret`, `value` or `audit` when the vault,
a stored value or the audit failed, and 502 with `upstream` when the host
didn't answer.
