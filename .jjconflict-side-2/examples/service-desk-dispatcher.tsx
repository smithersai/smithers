// @ts-nocheck
/**
 * <ServiceDeskDispatcher> — Distinguish incidents from requests or policy questions
 * and hand off to the right service-desk path.
 *
 * Pattern: intake → classify → specialized subflows/agents.
 * Use cases: IT help desk, internal service requests, policy FAQ routing,
 * incident management, request fulfillment.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IntakePrompt from "./prompts/service-desk-dispatcher/intake.mdx";
import ClassifyPrompt from "./prompts/service-desk-dispatcher/classify.mdx";
import IncidentPrompt from "./prompts/service-desk-dispatcher/incident.mdx";
import RequestPrompt from "./prompts/service-desk-dispatcher/request.mdx";
import PolicyPrompt from "./prompts/service-desk-dispatcher/policy.mdx";

const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  submitter: z.string(),
});

const intakeResultSchema = z.object({
  tickets: z.array(ticketSchema),
  totalReceived: z.number(),
});

const classificationSchema = z.object({
  classified: z.array(z.object({
    id: z.string(),
    title: z.string(),
    category: z.enum(["incident", "request", "policy"]),
    urgency: z.enum(["critical", "high", "medium", "low"]),
    reasoning: z.string(),
  })),
});

const handlerResultSchema = z.object({
  ticketId: z.string(),
  action: z.string(),
  status: z.enum(["resolved", "escalated", "pending"]),
  resolution: z.string(),
});

const dispatchReportSchema = z.object({
  totalTickets: z.number(),
  incidents: z.number(),
  requests: z.number(),
  policyQuestions: z.number(),
  resolved: z.number(),
  escalated: z.number(),
  pending: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  intake: intakeResultSchema,
  classification: classificationSchema,
  handlerResult: handlerResultSchema,
  dispatchReport: dispatchReportSchema,
});

const intakeAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a service-desk intake agent. Gather and normalize incoming
tickets, ensuring each has a clear title, description, and submitter.`,
});

const classifierAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a service-desk classifier. Categorize each ticket as an incident
(something is broken or degraded), a request (someone needs something provisioned
or changed), or a policy question (someone needs guidance on rules or processes).
Assign urgency based on business impact.`,
});

const incidentAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are an incident handler. Investigate the reported incident,
determine root cause where possible, apply mitigations, and escalate if the issue
requires human intervention or is beyond your tooling.`,
});

const requestAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a service-request fulfillment agent. Process the request,
verify it meets policy, and take action to fulfill it. Escalate if approval is
needed or if the request falls outside standard procedures.`,
});

const policyAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a policy advisor. Answer the submitter's question by
referencing relevant internal policies, runbooks, or documentation. Provide a
clear, actionable answer.`,
});

const handlerForCategory: Record<string, InstanceType<typeof Agent>> = {
  incident: incidentAgent,
  request: requestAgent,
  policy: policyAgent,
};

const promptForCategory: Record<string, typeof IncidentPrompt> = {
  incident: IncidentPrompt,
  request: RequestPrompt,
  policy: PolicyPrompt,
};

export default smithers((ctx) => {
  const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
  const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
  const results = ctx.outputs.handlerResult ?? [];

  const classifiedTickets = classification?.classified ?? [];

  return (
    <Workflow name="service-desk-dispatcher">
      <Sequence>
        {/* Step 1: Intake — gather and normalize tickets */}
        <Task id="intake" output={outputs.intake} agent={intakeAgent}>
          <IntakePrompt
            source={ctx.input.source ?? "service desk queue"}
            tickets={ctx.input.tickets ?? null}
            fetchCmd={ctx.input.fetchCmd ?? null}
          />
        </Task>

        {/* Step 2: Classify each ticket as incident, request, or policy */}
        <Task id="classify" output={outputs.classification} agent={classifierAgent}>
          <ClassifyPrompt tickets={intake?.tickets ?? []} />
        </Task>

        {/* Step 3: Route to specialized handlers in parallel */}
        {classifiedTickets.length > 0 && (
          <Parallel maxConcurrency={5}>
            {classifiedTickets.map((ticket) => {
              const Prompt = promptForCategory[ticket.category] ?? IncidentPrompt;
              return (
                <Task
                  key={ticket.id}
                  id={`handle-${ticket.id}`}
                  output={outputs.handlerResult}
                  agent={handlerForCategory[ticket.category] ?? incidentAgent}
                  continueOnFail
                >
                  <Prompt
                    id={ticket.id}
                    title={ticket.title}
                    category={ticket.category}
                    urgency={ticket.urgency}
                    reasoning={ticket.reasoning}
                  />
                </Task>
              );
            })}
          </Parallel>
        )}

        {/* Step 4: Dispatch report */}
        <Task id="report" output={outputs.dispatchReport}>
          {{
            totalTickets: classifiedTickets.length,
            incidents: classifiedTickets.filter((t) => t.category === "incident").length,
            requests: classifiedTickets.filter((t) => t.category === "request").length,
            policyQuestions: classifiedTickets.filter((t) => t.category === "policy").length,
            resolved: results.filter((r) => r.status === "resolved").length,
            escalated: results.filter((r) => r.status === "escalated").length,
            pending: results.filter((r) => r.status === "pending").length,
            summary: `Dispatched ${classifiedTickets.length} tickets: ${classifiedTickets.filter((t) => t.category === "incident").length} incidents, ${classifiedTickets.filter((t) => t.category === "request").length} requests, ${classifiedTickets.filter((t) => t.category === "policy").length} policy questions — ${results.filter((r) => r.status === "resolved").length} resolved, ${results.filter((r) => r.status === "escalated").length} escalated`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
