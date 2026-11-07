# Unrestricted reducer-input findings

These `.ts` files retain the exact production executable code and add one unrestricted invariant each. They are
expected to fail `pnpm verify verify/findings`; they are **not executable mutations**. The qualified claims in the
production file are separately proved for inputs admitted by `decide`.

- `unrestricted-reply.ts`: starting the next reply with `id: ""` yields `working` with no nonempty replying id.
- `unrestricted-client-id.ts`: two next nonblank posts with `clientId: ""` yield duplicate person client ids.

With Node >=22.18 (native TypeScript loading), run `node verify/findings/run.mjs` for concrete runtime counterexamples using the actual production functions. It
also shows why the unsafe numeric input `seq = 9007199254740992` is outside the integer proof's precondition.

Existing behavior is preserved. These false unrestricted claims remain findings; the lane does not silently treat
the qualified invariant proofs as covering malformed external inputs. A product decision to reject empty external
ids while still advancing `seq` would allow the unrestricted invariants to be repaired in a later change.
