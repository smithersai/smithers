import { digest } from "@smthrs/core/Digest"

/** Retain replay refusal without retaining the account's raw lineage label. */
export const retiredLineageKey = (lineageId: string): string => digest(`smithers-ui/retired-lineage/v1:${lineageId}`)
