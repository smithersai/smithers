/**
 * @param {string[]} args
 * @param {string} flag
 * @param {string[]} [values]
 */
export function pushList(args, flag, values) {
    if (!values || values.length === 0)
        return;
    args.push(flag, ...values.map(String));
}
