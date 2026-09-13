/** A request ID belongs to one run; the containing card supplies repo/workspace scope. */
export interface ApprovalReference {
  readonly runId: string
  readonly requestId: string
}

export const sameApproval = (left: ApprovalReference, right: ApprovalReference): boolean =>
  left.runId === right.runId && left.requestId === right.requestId

export const approvalRowKey = (row: ApprovalReference): string => JSON.stringify([row.runId, row.requestId])

/** URI encoding keeps the three identifiers intact through the slash grammar. */
export const approvalActionId = (cardId: string, row: ApprovalReference): string =>
  `approval-row@${encodeURIComponent(JSON.stringify([cardId, row.runId, row.requestId]))}`

export const parseApprovalActionId = (value: string): (ApprovalReference & { readonly cardId: string }) | undefined => {
  if (!value.startsWith("approval-row@")) return undefined
  try {
    const parts: unknown = JSON.parse(decodeURIComponent(value.slice("approval-row@".length)))
    if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((part) => typeof part === "string" && part !== "")) return undefined
    return { cardId: parts[0], runId: parts[1], requestId: parts[2] }
  } catch {
    return undefined
  }
}
