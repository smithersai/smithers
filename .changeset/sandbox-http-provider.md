---
"@smthrs/sandbox": minor
---

`HttpSandbox` reaches machines held by an HTTP service. `HttpSandbox.serve({ provider, token })` turns a retained `Sandbox.Provider` into a stateless handler on web-standard `Request` and `Response` that a Worker or a server mounts; `provider` may be a function of the session's `ResourceLimits`, which every request carries. `HttpSandbox.make({ url, token, client })` is the `Sandbox.Provider` a host constructs to reach it through an Effect `HttpClient`. A command starts detached in the machine and is polled with short requests, so no request lasts as long as the command; writes cross in 16 MiB chunks; every request is idempotent, and one lost on the way is sent again before it fails `unavailable`.
