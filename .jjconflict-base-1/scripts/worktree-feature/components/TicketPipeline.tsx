import { Sequence } from "smithers";
import { ValidationLoop } from "./ValidationLoop";
import { Report } from "./Report";
import { useCtx, tables } from "../smithers";
import type { Ticket } from "./Discover.schema";
import type { ReportOutput } from "./Report.schema";

interface TicketPipelineProps {
  ticket: Ticket;
}

export function TicketPipeline({ ticket }: TicketPipelineProps) {
  const ctx = useCtx();
  const tid = ticket.id;

  const latestReport = ctx.latest(tables.report, `${tid}:report`) as ReportOutput | undefined;
  const ticketComplete = latestReport != null;

  return (
    <Sequence key={tid} skipIf={ticketComplete}>
      <ValidationLoop ticket={ticket} />
      <Report ticket={ticket} />
    </Sequence>
  );
}
