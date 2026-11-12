// A message union and a projection declared by a module LemmaScript reads only through its declaration, as
// VibeLang emits a Foldkit app's: payloads and results are anonymous types.
export type Message =
  | { readonly _tag: "Measured"; readonly x: number; readonly y: number }
  | { readonly _tag: "Scrolled"; readonly bottom: boolean; readonly intent?: number }
  | { readonly _tag: "Loaded"; readonly data: { readonly role?: string; readonly seq: number } };
export declare const Message: {
  match<R>(message: Message, handlers: {
    Measured: (m: { readonly x: number; readonly y: number }) => R;
    Scrolled: (m: { readonly bottom: boolean; readonly intent?: number }) => R;
    Loaded: (m: { readonly data: { readonly role?: string; readonly seq: number } }) => R;
  }): R;
};
export declare function screenOf(model: { readonly issues?: { readonly open: boolean; readonly items: ReadonlyArray<{ readonly n: number; readonly label: string }> } }): { readonly open: boolean; readonly count: number };
