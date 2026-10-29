---
title: "API reference"
description: "Every export of @smthrs/secrets: the Binding, Egress, Placeholder and Scrub namespaces, their services, models, errors and metric."
---

The package root exports four namespaces and nothing else:

```ts
import { Binding, Egress, Placeholder, Scrub } from "@smthrs/secrets"
```

## `Placeholder`

| Export             | Signature                                                              |
| ------------------ | ---------------------------------------------------------------------- |
| `prefix`           | `"smthrs-secret-"`                                                     |
| `minimumKeyLength` | `32`                                                                   |
| `is`               | `(text: string) => boolean`: exactly one placeholder                   |
| `find`             | `(text: string) => ReadonlyArray<string>`: every placeholder, in order |
| `minter`           | `(key: Redacted<string>) => Effect<Minter, KeyTooShort>`               |
| `Minter`           | `{ derive: (scope: string, name: string) => Effect<string> }`          |
| `KeyTooShort`      | the key is under 32 characters                                         |

## `Binding`

| Export                                   | Signature                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Name`                                   | `Schema<string>`: `^[A-Z_][A-Z0-9_]{0,63}$`                                                              |
| `Host`, `isHost`                         | a lowercase DNS name of two or more labels, at most 253 characters, not ending in an all-digit label     |
| `Method`                                 | `"GET" \| "HEAD" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"`                                              |
| `Binding`                                | `Schema<{ name, hosts, methods? }>`: 1 to `maximumHosts` (16) hosts; methods, when present, at least one |
| `minimumValueBytes`, `maximumValueBytes` | `8`, `16384`                                                                                             |
| `valueProblem`                           | `(value: string) => "too_short" \| "too_long" \| "control_character" \| "malformed_text" \| undefined`   |
| `checkValue`                             | `(value: Redacted<string>) => Effect<void, ValueInvalid>`                                                |
| `ValueInvalid`                           | `{ reason }`, never the value                                                                            |

| Export         | Contract                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValueProblem` | Type union `too_short`, `too_long`, `control_character`, `malformed_text`; `valueProblem(value)` returns it or undefined, without disclosing the value. |

## `Scrub`

| Export     | Signature                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forms`    | `(value: string) => ReadonlyArray<string>`: the value, percent-encoded (upper and lower hexadecimal, `+` for space), JSON-escaped, and base64 and base64url at each byte alignment |
| `make`     | `(targets: ReadonlyArray<{ value: Redacted<string>, replacement: string }>) => Scrubber`                                                                                           |
| `Scrubber` | `{ active, text(value), stream(body) }`; the longer form wins at one position                                                                                                      |

| Export   | Contract                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Target` | `{ value: Redacted<string>; replacement: string }`, one target passed to `make(targets)`. The scrubber reveals the value only internally and emits the replacement, never the secret. |

## `Egress`

| Export                                      | Signature                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Policy`                                    | `{ secrets: ReadonlyArray<Secret>, allow: ReadonlyArray<string> }`                                             |
| `Secret`                                    | `{ name, placeholder, hosts, methods? }`                                                                       |
| `decide`                                    | `({ method, url, headers }, policy) => Allowed \| Denied`: pure, before any value is revealed                  |
| `execute`                                   | `(request: HttpClientRequest, policy) => Effect<Answer, Refused \| Unavailable, HttpClient \| Vault \| Audit>` |
| `forward`                                   | `(request: HttpServerRequest, policy) => Effect<HttpServerResponse, never, HttpClient \| Vault \| Audit>`      |
| `Answer`                                    | `{ status, headers, body: Stream<Uint8Array, Broken> }`                                                        |
| `Vault`                                     | service: `{ reveal: (name) => Effect<Redacted<string>, SecretUnavailable> }`                                   |
| `Audit`                                     | service: `{ record: (entry: Entry) => Effect<void, AuditUnavailable> }`                                        |
| `Entry`                                     | `{ host, method, outcome: "forwarded" \| Refusal, secrets: ReadonlyArray<string> }`                            |
| `refusals`, `Refusal`                       | each refusal code and its status                                                                               |
| `Refused`                                   | `{ code: Refusal }`                                                                                            |
| `Unavailable`                               | `{ code: "secret" \| "value" \| "audit" \| "upstream" }`                                                       |
| `Broken`                                    | the answer's body broke off                                                                                    |
| `maximumPlaceholders`, `maximumHeaderBytes` | `16`, `65536`                                                                                                  |
| `requests`                                  | counter `secret_egress_requests` by `outcome`                                                                  |
