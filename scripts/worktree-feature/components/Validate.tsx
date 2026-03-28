
import { Task, outputs } from "../smithers";
import { codex } from "../agents";
import ValidatePrompt from "./Validate.mdx";
import { useCtx, tables } from "../smithers";
import type { Ticket } from "./Discover.schema";
import type { ImplementOutput } from "./Implement.schema";

interface ValidateProps {
  ticket: Ticket;
}

export function Validate({ ticket }: ValidateProps) {
  const ctx = useCtx();
  const ticketId = ticket.id;

  const implementOutput = ctx.latest(tables.implement, `${ticketId}:implement`) as ImplementOutput | undefined;

  return (
    <Task
      id={`${ticketId}:validate`}
      output={outputs.validate}
      agent={codex}
      timeoutMs={20 * 60 * 1000}
    >
      <ValidatePrompt
        ticketId={ticketId}
        ticketTitle={ticket.title}
        implementOutput={implementOutput}
      />
    </Task>
  );
}
