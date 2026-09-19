/*
 * The `model` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { MODEL_PROTOCOL_DEFAULTS, MODEL_PROTOCOLS } from "@smthrs/rpc/ConfiguredModel"
import { Schema } from "effect"
import { flag, line } from "../FlowForms"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `model` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "model", label: "Models", summary: "Models and the seats they answer for" }

/** A model by the name it was saved under. */
const ModelTarget = Schema.Struct({ id: Schema.String })
const target = { fields: { id: { label: "Model", optionsFrom: "models" } } } as const

/*
 * The record as the form asks for it, flat: one control per field, and the
 * name is the id. A credential is a NAME the host resolves; there is no field
 * a value could be typed into. The rules a form cannot express (openai-chat
 * needs a base URL, a path belongs to openai-chat) are the controller's
 * refusals (state/controller/models.ts), painted on the form.
 */
const ModelRecord = Schema.Struct({
  name: Schema.String,
  protocol: Schema.Literals(MODEL_PROTOCOLS),
  baseUrl: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  modelId: Schema.String,
  credential: Schema.String
})

/*
 * The `model` flows registered as one aggregator block. None names a host
 * capability or sign-in: both hosts answer the Models routes themselves, the
 * local one spends the operator's own key with nobody signed in, and the
 * Worker's refusal is typed onto the card.
 */
export const modelFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "model.list",
    summary: "Show the models and the seats they answer for",
    input: NoPayload,
    handler: () => actions.listModels()
  }),
  flow({
    name: "model.new",
    summary: "Add a model",
    input: NoPayload,
    handler: () => actions.newModel()
  }),
  flow({
    name: "model.edit",
    summary: "Edit a model",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.editModel(id)
  }),
  flow({
    name: "model.save",
    summary: "Save a model: a name, a protocol, a provider model id and a credential name",
    args: `--name <name> --protocol <${MODEL_PROTOCOLS.join("|")}> --model <model id> --credential <NAME> [--url <base url>] [--path <path>]`,
    input: ModelRecord,
    form: {
      submitLabel: "Save",
      args: (payload) =>
        line(
          flag(payload, "name"),
          flag(payload, "protocol"),
          flag(payload, "modelId", "model"),
          flag(payload, "credential"),
          flag(payload, "baseUrl", "url"),
          flag(payload, "path")
        ),
      fields: {
        baseUrl: { label: "Base URL", placeholder: "https://" },
        path: { placeholder: MODEL_PROTOCOL_DEFAULTS["openai-chat"].path },
        modelId: { label: "Model" },
        credential: { optionsFrom: "credentials" }
      }
    },
    handler: (input) => actions.saveModel(input)
  }),
  flow({
    name: "model.show",
    summary: "Select a model on the Models card",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.showModel(id)
  }),
  flow({
    name: "model.remove",
    summary: "Remove a model; a seat it held returns to the host's default",
    args: "<name>",
    input: ModelTarget,
    form: target,
    confirm: (payload) => `remove the model ${String(payload["id"])}`,
    handler: ({ id }) => actions.removeModel(id)
  }),
  flow({
    name: "model.test",
    summary: "Test a model with one real call",
    args: "<name>",
    input: ModelTarget,
    form: target,
    handler: ({ id }) => actions.testModel(id)
  }),
  flow({
    name: "model.assign",
    summary: "Assign a model to a seat; `default` returns the seat to the host",
    args: "<seat> <name|default>",
    input: Schema.Struct({ seat: Schema.String, recordId: Schema.String }),
    form: {
      submitLabel: "Assign",
      fields: { seat: { optionsFrom: "seats" }, recordId: { label: "Model", optionsFrom: "models" } }
    },
    confirm: (payload) => `assign ${String(payload["recordId"])} to the ${String(payload["seat"])} seat`,
    handler: ({ seat, recordId }) => actions.assignSeat(seat, recordId)
  })
]
