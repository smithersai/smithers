
import { codex } from "../agents";
import DiscoverPrompt from "./Discover.mdx";
import { Task, useCtx, tables } from "../smithers";

export function Discover() {
  return (
    <Task id="discover-codex" output={outputs.discover} agent={codex}>
      <DiscoverPrompt />
    </Task>
  );
}
