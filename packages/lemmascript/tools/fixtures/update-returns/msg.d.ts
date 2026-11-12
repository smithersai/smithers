declare const Msg: { readonly Type: { readonly _tag: "A" } | { readonly _tag: "B"; readonly n: number } };
export type Msg = typeof Msg.Type;
