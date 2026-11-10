// Each element of a filtered list, read by index, satisfies the predicate and came from the input.
//@ option dafny-library local
interface Command { readonly command: string }

//@ verify
//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].command.startsWith(query) && commands.includes(\result[i]))
//@ ensures forall(i, 0 <= i && i < commands.length && commands[i].command.startsWith(query) ==> \result.includes(commands[i]))
export function matching(query: string, commands: ReadonlyArray<Command>): ReadonlyArray<Command> {
  return commands.filter((entry) => entry.command.startsWith(query))
}
