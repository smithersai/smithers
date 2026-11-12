// A Foldkit message union as VibeLang declares it: each tag is a constructor, `match` takes one arm per tag.
export type Message =
  | { readonly _tag: "Opened"; readonly page: string }
  | { readonly _tag: "Closed" };
export declare const Message: {
  Opened: (payload: { readonly page: string }) => { readonly _tag: "Opened"; readonly page: string };
  Closed: () => { readonly _tag: "Closed" };
  match<R>(message: Message, handlers: { Opened: (m: { readonly page: string }) => R; Closed: () => R }): R;
};
