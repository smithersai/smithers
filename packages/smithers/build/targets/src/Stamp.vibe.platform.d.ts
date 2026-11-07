/**
 * The inert placeholder a declaration carries in place of a stamp value.
 *
 * A stamp resolves after keying, so a declaration that must render a stamp
 * into a plain string (a linker flag, a Dockerfile build arg) carries this
 * token instead of a value. The token spells only the stamp's name — or, for
 * a secret-valued stamp, the environment variable's name — so it is safe in
 * key material, and the executor replaces it immediately before spawn.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const token: (name: string, value: unknown) => string;
