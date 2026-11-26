import { Binding } from "@smthrs/secrets"
import { checkSave } from "../../src/features/personal-model/contract.ts"

/** @throws {never} */
export const randomUuid = (): string => crypto.randomUUID()

export const checkConnectionSave = (
  input: Parameters<typeof checkSave>[0],
  saved: Parameters<typeof checkSave>[1],
  defaults: Parameters<typeof checkSave>[3],
) => checkSave(input, saved, Binding.valueProblem, defaults)
