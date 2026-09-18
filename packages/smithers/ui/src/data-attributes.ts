/*
 * The one shape a host's pass-through `data-*` attributes have.
 *
 * React's element prop types name no `data-*` key, so an object holding only
 * data attributes has nothing in common with `ComponentProps<"button">` and
 * the weak-type check rejects it — exactly the object a host passes when the
 * only thing it adds is a binding (`data-flow`) or a test hook. Every
 * pass-through prop in this package intersects this type, so those objects
 * type-check and each attribute keeps a value type.
 */
export type DataAttributes = { [attribute: `data-${string}`]: string | number | boolean | undefined; };
