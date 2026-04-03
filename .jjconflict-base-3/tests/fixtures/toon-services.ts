import { Context, Effect } from "effect";

export class Greeter extends Context.Tag("Greeter")<
  Greeter,
  {
    readonly greet: (name: string) => Effect.Effect<string>;
  }
>() {}
