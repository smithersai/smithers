
/** The run reference is separate from backend IDs and from freeform message/JSON arguments. */
export const splitRunSource = (args: string | undefined): { readonly args: string | undefined; readonly sourceCard?: string } => {
  const match = /^\s*sourceCard=(\S+)(?:\s+([\s\S]*))?$/.exec(args ?? "")
  return match === null ? { args } : { args: match[2], sourceCard: match[1]! }
}
