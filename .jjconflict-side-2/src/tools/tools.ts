import { read } from "./read";
import { write } from "./write";
import { edit } from "./edit";
import { grep } from "./grep";
import { bash } from "./bash";

// Convenience map of built-in tools for agents that expect a tool registry.
export const tools = { read, write, edit, grep, bash };
