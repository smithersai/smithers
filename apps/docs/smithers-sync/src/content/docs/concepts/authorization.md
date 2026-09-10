---
title: "Authorization"
description: "The two fail-closed boundaries of the read path, the workspace principal and the branch capability that cross them, and why a subscription carries its own expiry."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/concepts/authorization.md"
---

Authorization in `@smthrs/sync` fails closed along two boundaries, and both are
consulted on every request. Neither has a trusted pass-through: code that never
authenticates reads nothing.

## Boundary one: non-branch runs and workspace listings

Every run whose id does not map to a branch is visible only to the workspace
principal. `SyncPrincipal` is a `Context.Reference` whose default value is
`SyncPrincipal.anonymous`, which is what makes the default posture closed
rather than open. A workspace-scoped request and a run-scoped request for an
engine run are both refused with `unauthorized` for an anonymous caller.

There are exactly two ways to become the workspace principal:

- **Over a transport.** `SyncAuth.layer` verifies the `WorkspaceShare`
  capability presented in the `flows-sync-workspace` request header and
  installs the resulting principal. A request with no header runs as anonymous.
  A header that is present but malformed, forged, expired, or signed by an
  unknown key is refused outright rather than downgraded to anonymity, because
  presenting a credential is a claim and a false claim is not the same thing as
  no claim.
- **In process.** A caller that already owns the journal provides
  `SyncPrincipal.layerWorkspace(capabilityId)` itself. That is the sanctioned
  bypass, and it is never a transport's to take.

Every decode failure of the header folds to the same `unauthorized` refusal, so
the header is not a parsing oracle for an attacker probing its shape.

## Boundary two: branch runs

A run whose id carries the branch prefix is visible only when the request's own
`capability` verifies for that branch through `BranchShare`. The capability
travels in the request payload, not in a header, because a share link is a
per-branch credential rather than a per-connection one.

The two boundaries compose rather than override each other:

- An explicitly scoped branch read with no capability fails.
- A workspace listing excludes the branch runs the caller's capability does not
  cover, so one share link never leaks another branch's log.
- With no `BranchShare` service in scope at all, every branch run is closed.
- A connection holding only a branch share link can never read an engine run,
  because that is boundary one's question and the link does not answer it.

## What a capability is

Both authorities mint the same shape: a claim set plus an HMAC-SHA-256
signature over a length-prefixed canonical encoding of it, compared in constant
time. A capability names one subject, one access level (`read` or `write`), and
one expiry. The holder cannot widen it because widening changes the claims and
therefore the signature.

Three details make that hold up:

- **Length prefixes.** Without them a subject id ending in the separator could
  be re-cut into a different, still validly signed claim set. Prefixes count
  UTF-8 bytes, and a claim set that does not survive UTF-8 encoding, such as
  one carrying an unpaired surrogate, is refused with `invalid_request` rather
  than signed.
- **A scheme label leading the encoding.** A branch signature can never verify
  as a workspace signature, even if one secret is misconfigured into both
  authorities.
- **`Redacted` secrets.** A keyring never holds a plain string, so a log, a
  span, or an inspection of the options object cannot render it.

Both authorities carry a `kid` inside the signed claims. The verifier both
selects the right key and refuses a capability whose key name was swapped after
minting, which is what lets a deployment rotate keys while capabilities minted
under a retired key are still outstanding. The keyrings are separate:
`BranchShare.layerConfig` provisions the branch authority from
`SMITHERS_SYNC_BRANCH_SECRET` and `SMITHERS_SYNC_BRANCH_KEY_ID`, so rotating
one credential leaves the other's outstanding capabilities alone. See
[Authorize a connection](/guides/authorize-a-connection/).

## A subscription carries its own deadline

A signed expiry is this package's only revocation mechanism, and a subscription
is not a sequence of requests. It is authorized once, at open, and then
streams. Without a deadline travelling with the identity, a holder of an
expired capability could keep reading for as long as it declined to disconnect.

So the expiry is on the principal itself, as
`SyncPrincipal.Workspace.expiresAtMs`, or on the branch capability's own
`expiresAtMs`, and the stream ends with `unauthorized` when that moment
arrives. An in-process owner that provided `SyncPrincipal` directly presented no
credential, so its `expiresAtMs` is `Infinity` and no deadline applies.

## Two stages on the branch side

Opening a branch is a bootstrap: no capability for it can exist yet.
`Branch.CreateBranch` therefore requires an authenticated workspace principal
supplied by the same `SyncAuth` middleware, and its handler refuses any other
principal. Every later branch procedure carries its own capability and
authorizes through `BranchShare`, so past the bootstrap the capability is the
credential.

`Branch.MintShare` requires write access to the branch, so only a collaborator
can invite one, and the minted link never outlives the capability it was minted
from. The handler rechecks the parent expiry after generating the child ID.
It passes the parent's absolute expiry as `BranchShare.mint`'s
`maxExpiresAtMs`; the authority clamps the requested TTL against that ceiling
using the clock read that sets `issuedAtMs`. If the ceiling has elapsed,
minting fails with `unauthorized`.

## Related pages

- [Authorize a connection](/guides/authorize-a-connection/): minting,
  presenting, and rotating a workspace capability.
- [Branch collaboration](/concepts/branches/): what a branch capability authorizes
  beyond reading.
- [Troubleshooting](/troubleshooting/): the `unauthorized` symptoms and
  what each one means.
