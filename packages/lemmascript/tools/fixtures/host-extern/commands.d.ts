// A project's own declaration of a module LemmaScript cannot read, as VibeLang emits one: values without bodies.
import type { DefinitionWithArgs } from "hostlib";
export declare const Ping: DefinitionWithArgs<"Ping", { readonly count: number; readonly label: string }>;
export declare const Focus: DefinitionWithArgs<"Focus", {}>;
export declare const Load: DefinitionWithArgs<"Load", { readonly key?: string }>;
