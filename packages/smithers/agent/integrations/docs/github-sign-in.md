# GitHub user sign-in

GitHub.Auth is the shared user authentication adapter extracted from apps/mvp. Import GitHub from the package root.
Provide GitHub.Auth.layer({ clientId, clientSecret }) and a host HttpClient, then acquire GitHub.Auth.GitHubAuth.
The secret is Redacted; callers resolve a named secret only on the server. No credential appears in a refusal.

authorizeUrl requires a fresh state, an S256 codeChallenge, and the exact redirectUri. Its durable callback step
calls exchange with the original verifier and redirect URI, then user with the returned access token.
The application owns one-time state consumption, expiring sessions, CSRF, callback allowlists and project roles.
refresh rotates the refresh token; revoke is idempotent for tokens GitHub already removed.
permission returns GitHub's permission names, not an app role.

Device flow signs a person in from a host without a browser: a CLI or an MCP server acting as that person's agent.
deviceCode starts one with the client id alone (the secret is never sent) and answers the userCode and
verificationUri the person visits; deviceToken polls once per call and reports pending, slowDown, denied, expired
or authorized with the person's tokens. The application owns the poll schedule, the expiry, and what the grant
becomes. The App must have device flow enabled in its GitHub settings; a client id GitHub refuses fails
misconfigured. No device code or token appears in a refusal.

webBaseUrl and apiBaseUrl are injected for enterprise hosts and integration fixtures. Defaults are github.com.
The adapter uses @smthrs/integrations' OAuth, PKCE and GitHubClient contracts and sets GitHubClient.USER_AGENT even
on Worker fetch. Each network mutation belongs in a durable flow step; the adapter starts no background work.

apps/mvp/worker/GitHubAuth.ts preserves the original public service, failure tags, and app-specific roleOf mapping.
Its adapter tests and SignIn suites exercise this single implementation. GitHub.Auth itself assigns no trust.

Core.CookieKeys owns the shared purpose-bound HMAC signing used by apps/mvp's SessionKeys and other applications.
make receives a map of named Redacted signing keys. sign uses the preferred key (legacy by default, else the first
sorted key); verify checks the complete key ring and returns the verified opaque value and key ID, or None.
A session cookie cannot be reused as a sign-in-state cookie. token draws a cryptographic opaque value.
Applications own host-only Secure/HttpOnly/SameSite cookies, expiry and one-time state consumption in durable storage.

Cookie purposes match [a-z][a-z0-9_]*. Signing an invalid purpose is a configuration defect; verification refuses it.
Values may contain punctuation. This restriction prevents delimiter ambiguity while preserving deployed MVP cookies.
