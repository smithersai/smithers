# Product workspace gateway

`node flows/librarian/build.mjs` writes `dist/product-host/smithers.mjs` and its SHA-256 sidecar. The artifact contains the 1.0 gateway, durable engine, dependencies, and the two Librarian flow implementations. Provisioners stage these exact bytes; they must not run the unrelated `smthrs@0.33.0` package or install dependencies from the user's repository.

Run with Node 22.19+ or Bun 1.4:

```
bun /usr/local/lib/smithers/product-gateway.mjs serve --root /workspace/repo --host 0.0.0.0 --port 7331 --listen
```

The provisioner supplies `SMITHERS_API_KEY`, `SMITHERS_GATEWAY_ID`, `SMITHERS_REPO=owner/repository`, and `SMITHERS_PRODUCT_API_URL` (API origin). Git and JJ must be installed. The API key is captured by the host and removed from the subprocess environment. The gateway uses its existing bearer approval authority and the same Control/Projection RPC protocols as the application. No provider credential is required by these factual, deterministic generators.

The registered names are `librarian/wiki` and `librarian/history`. Definitions are pinned to the full executable's SHA-256. Their identity records and durable SQLite databases live under `.flows/`; target-repository modules cannot replace these product definitions. Inputs must name the provisioner's owning repository.

Wiki completion requires successful publication to `POST /api/gateways/{gatewayId}/wiki-pages`, authenticated with the gateway's repository-scoped bearer. The endpoint rechecks repository authority and creates revision-scoped pages idempotently. Publication failure is a failed run, never a completed but invisible Wiki. The Wiki is a source-file index with exact revision provenance, not inferred documentation.

Mythical history creates `refs/heads/mythical` and `refs/notes/mythical` atomically in the owning workspace. It preserves the source branch and tree and never replaces existing different history. These refs are local to the persistent workspace; this host does not claim to have published them to a remote repository.

Acceptance executes the built artifact in a separate process over real HTTP RPC, real Git, durable SQLite, and a contract publication server:

```
node --test flows/test/product-host.test.mjs
SMITHERS_PRODUCT_HOST_RUNTIME=bun node --test flows/test/product-host.test.mjs
```

It checks both flows, published source provenance, real history refs, repository binding, publication failure, authentication, and completed projections after restart. Production validation additionally exercises the actual Plue publication endpoint and its cloud Wiki results.
