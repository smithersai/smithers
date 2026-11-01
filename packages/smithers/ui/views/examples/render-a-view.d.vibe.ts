import { Effect } from "effect";
/**
 * What a host does with a renderer's module: check it against the components
 * the realm's bundle carries, render it, and then play one interaction.
 *
 * The realm comes from the host's layer: `PresentationRealm.layer({ bundle })`
 * over the QuickJS build it names (`QuickJSVariant.layerVariant` from
 * `@smthrs/harness`). The test beside this example provides both.
 */
import { type Interactions, PresentationRealm, ViewCode } from "@smthrs/views";
/** A two-button counter: one state interaction, no model call per click. */
export declare const counter = "import { Button, Card } from \"@smthrs/ui\"\nimport type { ViewProps } from \"smithers:view\"\n\nexport const interactions = { add: { kind: \"state\" } }\nexport const reduce = (state: number, event: { name: string; arg?: string }) => state + Number(event.arg ?? 1)\n\nexport default function View({ props, state }: ViewProps<number>) {\n  return (\n    <Card>\n      <p>{props.label}: {state}</p>\n      <Button data-event=\"add:1\">+1</Button>\n      <Button data-event=\"add:10\">+10</Button>\n    </Card>\n  )\n}\n";
/** Checks and renders `source`, then applies `event` the way a click would. */
export declare const program: (source: string, event: Interactions.Event) => Effect.Effect<{
    interactions: {
        readonly [x: string]: {
            readonly kind: "state";
        } | {
            readonly kind: "message";
            readonly label: string;
        };
    };
    first: string;
    next: PresentationRealm.Interacted;
}, PresentationRealm.RealmError | ViewCode.ViewCodeError, PresentationRealm.PresentationRealm>;
