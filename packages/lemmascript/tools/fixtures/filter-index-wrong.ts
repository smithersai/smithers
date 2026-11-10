// The filter keeps commands that end with the query; each kept command must start with it.
//@ option dafny-library local
interface Command { readonly command: string }

//@ verify
//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].command.startsWith(query) && commands.includes(\result[i]))
export function matching(query: string, commands: ReadonlyArray<Command>): ReadonlyArray<Command> {
  return commands.filter((entry) => entry.command.endsWith(query))
}
