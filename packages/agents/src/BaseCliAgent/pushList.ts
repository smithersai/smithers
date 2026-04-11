export function pushList(args: string[], flag: string, values?: string[]) {
  if (!values || values.length === 0) return;
  args.push(flag, ...values.map(String));
}
