import { Sequence, Branch } from "smithers";
import { Discover, TicketPipeline } from "./components";
import { Ticket } from "./components/Discover.schema";
import { Workflow, smithers, tables } from "./smithers";

export default smithers((ctx) => {
  const discoverOutput = ctx.latest(tables.discover, "discover-codex");
  const tickets = ctx.latestArray(discoverOutput?.tickets, Ticket);
  const unfinishedTickets = tickets.filter(
    (t) => !ctx.latest(tables.report, `${t.id}:report`)
  ) as Ticket[];

  return (
    <Workflow name="worktree-feature">
      <Sequence>
        <Branch if={tickets.length === 0} then={<Discover />} />
        {unfinishedTickets.map((ticket) => (
          <TicketPipeline key={ticket.id} ticket={ticket} />
        ))}
      </Sequence>
    </Workflow>
  );
});
