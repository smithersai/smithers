// LemmaScript reads TypeScript fixtures; this retains nullable member inequality in code and contract.
interface Receipt { readonly answer: string | null }
//@ verify
//@ ensures \result == (receipt.answer != null && receipt.answer != "done")
export function refusedReceipt(receipt: Receipt): boolean {
  return receipt.answer !== null && receipt.answer !== "done"
}
