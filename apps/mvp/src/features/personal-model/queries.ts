import { type Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import type { Form, Hidden, PersonalModelRow, TestRow } from "./schema"

// What every frontend reads of a person's own model (docs/features/personal-model.md#the-settings-section). Each is a
// live query over this device's collections; none waits for the network, and none can carry a key: no collection holds
// one.

/** The person's own row: their model, its key's last characters and its last failure; none when nothing is saved. */
export const rowQuery = (rows: { readonly tanstack: Collection.Collection<PersonalModelRow, any>["tanstack"] }) =>
  LiveQuery.make((q) => q.from({ model: rows.tanstack }).findOne())

/** The form's last write on this tab. */
export const formQuery = (form: Collection.Collection<Form, string>) =>
  LiveQuery.make((q) => q.from({ form: form.tanstack }).findOne())

/** The last test on this tab. */
export const testQuery = (test: Collection.Collection<TestRow, string>) =>
  LiveQuery.make((q) => q.from({ test: test.tanstack }).findOne())

/** The failure whose toast this device hid. */
export const hiddenQuery = (hidden: Collection.Collection<Hidden, string>) =>
  LiveQuery.make((q) => q.from({ hidden: hidden.tanstack }).findOne())
