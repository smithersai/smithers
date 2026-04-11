export function pushFlag(
  args: string[],
  flag: string,
  value?: string | number | boolean,
) {
  if (value === undefined) return;
  if (value === true) {
    args.push(flag);
  } else if (value === false) {
    return;
  } else {
    args.push(flag, String(value));
  }
}
