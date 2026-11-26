import { digestSync } from "@smthrs/crypto"

export const digestSessionValue = (value: string): string => digestSync(value)

export const randomSessionUuid = () => crypto.randomUUID()
