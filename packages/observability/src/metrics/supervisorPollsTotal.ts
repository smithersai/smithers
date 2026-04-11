import { Metric } from "effect";

export const supervisorPollsTotal = Metric.counter("smithers.supervisor.polls_total");
