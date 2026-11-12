// A project's declaration of a schema module, as VibeLang emits one: the record's type is computed from a value
// (`typeof Model.Type`), so every nested type in it is anonymous.
export declare const Model: {
  readonly Type: {
    readonly client: {
      readonly gap: boolean;
      readonly status: "idle" | "busy";
      readonly pending: ReadonlyArray<{ readonly id: string; readonly text: string }>;
      readonly last: { readonly type: "Posted"; readonly id: string } | { readonly type: "Cleared" };
    };
    readonly label: string;
  };
};
export type Model = typeof Model.Type;
export declare const empty: Model["client"];
