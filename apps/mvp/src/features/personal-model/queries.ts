import { type Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import type { Form, PersonalModelRow, TestRow } from "./schema"

// What every frontend reads of a person's own models (docs/features/personal-model.md#the-settings-section). Each is a
// live query over this device's collections; none waits for the network, and none can carry a key: no collection holds
// one.

/**
 * The person's saved keys, one row per protocol, by protocol: each one's base URL, the models its tiers use, its key's
 * last characters and its last failure; none when nothing is saved.
 */
export const rowsQuery = (rows: { readonly tanstack: Collection.Collection<PersonalModelRow, any>["tanstack"] }) =>
  LiveQuery.make((q) => q.from({ model: rows.tanstack }).orderBy(({ model }) => model.protocol))

/** The form's last write on this tab. */
export const formQuery = (form: Collection.Collection<Form, string>) =>
  LiveQuery.make((q) => q.from({ form: form.tanstack }).findOne())

/** The last test on this tab. */
export const testQuery = (test: Collection.Collection<TestRow, string>) =>
  LiveQuery.make((q) => q.from({ test: test.tanstack }).findOne())

