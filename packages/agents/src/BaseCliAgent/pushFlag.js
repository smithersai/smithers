/**
 * @param {string[]} args
 * @param {string} flag
 * @param {string | number | boolean} [value]
 */
export function pushFlag(args, flag, value) {
    if (value === undefined)
        return;
    if (value === true) {
        args.push(flag);
    }
    else if (value === false) {
        return;
    }
    else {
        args.push(flag, String(value));
    }
}
