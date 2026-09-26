/**
 * `organization/meetings-reply`: the role answers the owner in its
 * one-on-one's Slack thread.
 *
 * The Slack intake starts it for an owner's message in a thread a
 * `organization/meetings-open` run recorded, keyed by the Slack event, instead
 * of a delivery. The role answers from the conversation so far under its own
 * host, and the answer is posted in the thread under its name.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Slack from "../../../packages/smithers/agent/integrations/src/slack/Actions.ts"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { fieldTurn } from "../field-turn.ts"
import { ReplyTask } from "../meetings.ts"
import { RenderReply, RequestKey, StepFailure } from "../schema.ts"
import { slackConnection } from "../slack-connection.ts"

const implementationVersion = "organization/meetings-reply/v1"

/** Answer the owner in a one-on-one thread. */
export default Flow.make("organization/meetings-reply", {
  description: "Answer the owner's message in a role's one-on-one Slack thread as that role.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: {
    key: RequestKey,
    principal: Profile.PrincipalId,
    channel: Schema.NonEmptyString,
    thread: Schema.NonEmptyString,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))
  },
  success: Slack.Posted,
  error: StepFailure,
  body: (payload) =>
    Actions.PinRoster.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
        ReplyTask.call({ revision: pin.revision, ...payload }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (asked) =>
            fieldTurn(pin.revision, asked.stage, ["reply"]).pipe(
              Node.map(Node.capture({ implementationVersion }, (answer) => {
                const reply = answer.result.fields["reply"]
                return typeof reply === "string" && reply.trim() !== "" ? reply : answer.result.summary
              })),
              Node.bindPlanned(Node.capture({ implementationVersion }, (text) =>
                RenderReply.call({ speaker: payload.principal, text }))),
              Node.bindPlanned(Node.capture({ implementationVersion }, (rendered) =>
                Slack.PostMessage.call({
                  connectionId: slackConnection,
                  channel: payload.channel,
                  threadTs: payload.thread,
                  text: rendered.text,
                  key: `${payload.key}/reply`.slice(0, 128),
                  persona: asked.persona
                })))
            )))
        )))
    )
})
