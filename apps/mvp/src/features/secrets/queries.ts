import { type Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import type { SecretForm, SecretRow, SecretsView } from "./schema"

// What every frontend reads of secrets (docs/features/secrets.md#the-secrets-page). Each is a live query over this
// device's collections; none waits for the network, and none can carry a value: no collection holds one.

/** One repository's secrets by name: each one's hosts, methods and when it last changed. */
export const listQuery = (secrets: { readonly tanstack: Collection.Collection<SecretRow, any>["tanstack"] }) =>
  LiveQuery.make((q) =>
    q
      .from({ secret: secrets.tanstack })
      .select(({ secret }) => ({
        name: secret.name,
        hosts: secret.hosts,
        methods: secret.methods,
        updatedAt: secret.updatedAt,
      }))
      .orderBy(({ $selected }) => $selected.name)
  )

/** What the route shows, and the row whose Rotate or Delete is open. */
export const viewQuery = (view: Collection.Collection<SecretsView, string>) =>
  LiveQuery.make((q) => q.from({ view: view.tanstack }).findOne())

/** Each form's last write on this tab. */
export const formsQuery = (forms: { readonly tanstack: Collection.Collection<SecretForm, any>["tanstack"] }) =>
  LiveQuery.make((q) => q.from({ form: forms.tanstack }))
