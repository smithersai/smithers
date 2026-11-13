# Host tools

The backend supplies the current public install origin in each authenticated turn grant. Address changes apply to the next turn. API calls still target the private callback listener and forward the public host, port, and scheme; redirects never receive the credential.

Standalone hosts can override the grant with `ModelTurnHandlerOptions.installOrigin`. Without either value, forwarding uses the callback origin. Wire origins must be HTTP or HTTPS origins without user information, paths, queries, or fragments. Context stream protocol refusals throw the tagged `ResolveFailed` error.

Diagnostic recorders use the host's Effect `Clock` and request `Scope`. In an Effect host, call `yield* makeHostDiagnostics({ write })` inside the request scope. Synchronous compositions pass `{ runtime: { clock, scope }, write }` to `createHostDiagnostics`. Closing the scope stops pending reports even if an operation never completes; completing an operation cancels its reports immediately. Start observations with `yield* diagnostics.begin(event, fields)` so they inherit the caller’s services and scheduler. A recorder without a sink remains inert. A sink without those host services is refused.

Source callbacks refuse redirects, including same-origin redirects, before reading an answer. Source and API JSON responses share a 4 MiB byte limit, enforced while streaming rather than trusting Content-Length. The reader cancels and releases the response body on completion or refusal.

Form tool results and system instructions acknowledge a requested browser instruction. A committed `call.settled` frame proves only that the instruction was recorded; it does not prove the browser opened or populated the form. The model must describe the form as requested until a browser completion receipt exists.

`runHostTurn` currently has no continuation recovery contract. Its grant carries the initial request and journal cursor, while committed frames omit the held calls and model-facing tool results needed to restore a leg. The model-host boundary fixes do not claim to add restart recovery or durable command ordinals.
