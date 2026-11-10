// A project's own declaration file, as a compiler emits for a module LemmaScript cannot read as TypeScript.
export declare const Message: { readonly Type: { readonly _tag: "Reset" } | { readonly _tag: "Set"; readonly n: number } }
export type Message = typeof Message.Type
