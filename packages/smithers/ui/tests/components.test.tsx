import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ChatComposer,
  ChatMessage,
  ChatTranscript,
  CollapsiblePanel,
  composeSmithersUiStyles,
  EmptyState,
  Eyebrow,
  Field,
  FileTree,
  Input,
  KpiStat,
  Label,
  Progress,
  RowButton,
  SectionHeader,
  Separator,
  Skeleton,
  SmithersUiStyles,
  smithersUiCss,
  Spinner,
  StageStrip,
  stageTone,
  StatusPill,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "../src/index";

/**
 * Pure-markup tests rendered with `renderToStaticMarkup` (no DOM), the
 * gateway-ui convention. Radix open/close/focus behavior is covered by
 * tests/radix-interaction.test.tsx under happy-dom.
 */
describe("Button", () => {
  test("renders the house tinted primary by default with type=button", () => {
    const html = renderToStaticMarkup(<Button>Launch</Button>);
    expect(html).toContain("sui-button");
    expect(html).toContain("sui-button-default");
    expect(html).toContain('type="button"');
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("Launch");
  });

  test("maps variants and sizes to namespaced classes", () => {
    expect(renderToStaticMarkup(<Button variant="solid">x</Button>)).toContain("sui-button-solid");
    expect(renderToStaticMarkup(<Button variant="destructive">x</Button>)).toContain("sui-button-destructive");
    expect(renderToStaticMarkup(<Button variant="ghost">x</Button>)).toContain("sui-button-ghost");
    expect(renderToStaticMarkup(<Button size="icon">x</Button>)).toContain("sui-button-icon-size");
    expect(renderToStaticMarkup(<Button size="sm">x</Button>)).toContain("sui-button-sm");
  });

  test("asChild renders the child element with button classes (Radix Slot)", () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/runs/123">Open run</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/runs/123"');
    expect(html).toContain("sui-button");
    expect(html).not.toContain("<button");
  });

  test("asChild forwards loading semantics without injecting a spinner", () => {
    const html = renderToStaticMarkup(
      <Button asChild loading>
        <a href="/runs/123">Open run</a>
      </Button>,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("sui-spinner");
  });

  test("keeps consumer className and explicit submit type", () => {
    const html = renderToStaticMarkup(
      <Button type="submit" className="my-extra">
        x
      </Button>,
    );
    expect(html).toContain('type="submit"');
    expect(html).toContain("my-extra");
  });
});

describe("Badge + StatusPill", () => {
  test("badge defaults to the brand pill and supports status variants", () => {
    expect(renderToStaticMarkup(<Badge>hi</Badge>)).toContain("sui-badge-default");
    expect(renderToStaticMarkup(<Badge variant="success">hi</Badge>)).toContain("sui-badge-success");
    expect(renderToStaticMarkup(<Badge variant="muted">hi</Badge>)).toContain("sui-badge-muted");
  });

  test("StatusPill maps status buckets onto badge variants with data-status", () => {
    const running = renderToStaticMarkup(<StatusPill status="running" />);
    expect(running).toContain("sui-badge-default");
    expect(running).toContain('data-status="running"');
    expect(running).toContain("Running");
    expect(running).toContain("sui-status-dot");

    expect(renderToStaticMarkup(<StatusPill status="ok" />)).toContain("sui-badge-success");
    expect(renderToStaticMarkup(<StatusPill status="failed" />)).toContain("sui-badge-destructive");
    expect(renderToStaticMarkup(<StatusPill status="cancelled" />)).toContain("sui-badge-muted");
    expect(renderToStaticMarkup(<StatusPill status="waiting_approval" />)).toContain("Waiting for approval");
  });

  test("StatusPill honors label override and withDot=false", () => {
    const html = renderToStaticMarkup(<StatusPill status="ok" label="Done" withDot={false} />);
    expect(html).toContain("Done");
    expect(html).not.toContain("sui-status-dot");
  });
});

describe("Card", () => {
  test("composes header/title/action/content slots", () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardAction>
            <Badge variant="secondary">3</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    );
    expect(html).toContain("sui-card");
    expect(html).toContain("sui-card-header");
    expect(html).toContain("sui-card-title");
    expect(html).toContain("sui-card-action");
    expect(html).toContain("sui-card-content");
    expect(html).toContain('data-slot="card"');
  });

  test("renders the description and footer slots", () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardDescription>Recent activity</CardDescription>
        </CardHeader>
        <CardFooter>footer text</CardFooter>
      </Card>,
    );
    expect(html).toContain("sui-card-description");
    expect(html).toContain('data-slot="card-description"');
    expect(html).toContain("Recent activity");
    expect(html).toContain("sui-card-footer");
    expect(html).toContain('data-slot="card-footer"');
    expect(html).toContain("footer text");
  });
});

describe("form controls", () => {
  test("Input/Textarea/Label/Field carry the sui classes", () => {
    const html = renderToStaticMarkup(
      <Field>
        <Label htmlFor="p">Prompt</Label>
        <Input id="p" placeholder="Describe the task" />
        <Textarea placeholder="More" />
      </Field>,
    );
    expect(html).toContain("sui-field");
    expect(html).toContain("sui-label");
    expect(html).toContain('for="p"');
    expect(html).toContain("sui-input");
    expect(html).toContain("sui-textarea");
  });
});

describe("chat", () => {
  test("renders user, assistant, terminal, and pending message treatments", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript pending pendingLabel="Agent is working">
        <ChatMessage role="user">Please inspect the parser.</ChatMessage>
        <ChatMessage role="assistant" variant="terminal" label="Plan">
          $ pnpm test
        </ChatMessage>
      </ChatTranscript>,
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-role="user"');
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain('data-variant="terminal"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Agent is working");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Terminal output"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("sui-chat-typing");
  });

  test("renders the controlled glass composer with accessible submit state", () => {
    const ready = renderToStaticMarkup(
      <ChatComposer value="Ship it" onValueChange={() => {}} onSubmit={() => {}} statusText="Connected" docked />,
    );
    expect(ready).toContain("sui-chat-composer");
    expect(ready).toContain('data-docked="true"');
    expect(ready).toContain('data-status="ready"');
    expect(ready).toContain('aria-label="Chat message"');
    expect(ready).toContain('aria-label="Send message"');
    expect(ready).toContain('<span aria-hidden="true">↑</span>');
    expect(ready).toContain('aria-live="polite"');
    expect(ready).toContain("Connected");
    expect(ready).not.toContain('disabled=""');

    const disabled = renderToStaticMarkup(<ChatComposer value="" onValueChange={() => {}} onSubmit={() => {}} />);
    expect(disabled).toContain('disabled=""');
  });

  test("shows a Stop button while streaming when onStop is set, and blocks submit while busy", () => {
    const streaming = renderToStaticMarkup(
      <ChatComposer
        value="Ship it"
        onValueChange={() => {}}
        onSubmit={() => {}}
        lifecycleStatus="streaming"
        onStop={() => {}}
      />,
    );
    expect(streaming).toContain('data-status="streaming"');
    expect(streaming).toContain('aria-label="Stop generating"');
    expect(streaming).toContain('<span aria-hidden="true">■</span>');
    expect(streaming).toContain("sui-chat-composer-stop");
    // Busy disables send even though the draft is non-empty.
    expect(streaming).toContain('disabled=""');

    const withoutStop = renderToStaticMarkup(
      <ChatComposer value="Ship it" onValueChange={() => {}} onSubmit={() => {}} lifecycleStatus="submitted" />,
    );
    expect(withoutStop).not.toContain("sui-chat-composer-stop");

    const ready = renderToStaticMarkup(
      <ChatComposer value="Ship it" onValueChange={() => {}} onSubmit={() => {}} onStop={() => {}} />,
    );
    expect(ready).not.toContain("sui-chat-composer-stop");

  });

  test("renders custom ReactNode send and stop labels without changing accessible names", () => {
    const ready = renderToStaticMarkup(
      <ChatComposer value="Ship it" onValueChange={() => {}} onSubmit={() => {}} sendLabel={<strong>Send</strong>} />,
    );
    expect(ready).toContain('<span aria-hidden="true"><strong>Send</strong></span>');
    expect(ready).toContain('aria-label="Send message"');

    const streaming = renderToStaticMarkup(
      <ChatComposer
        value="Ship it"
        onValueChange={() => {}}
        onSubmit={() => {}}
        lifecycleStatus="streaming"
        onStop={() => {}}
        stopLabel={<strong>Stop</strong>}
      />,
    );
    expect(streaming).toContain('<span aria-hidden="true"><strong>Stop</strong></span>');
    expect(streaming).toContain('aria-label="Stop generating"');
  });
});

describe("Alert", () => {
  test("renders role=alert with variant classes", () => {
    const html = renderToStaticMarkup(
      <Alert variant="warning">
        <AlertTitle>Gateway not connected</AlertTitle>
        <AlertDescription>Runs cannot be launched from this deployment.</AlertDescription>
      </Alert>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("sui-alert-warning");
    expect(html).toContain("sui-alert-title");
    expect(html).toContain("sui-alert-description");
  });
});

describe("Table", () => {
  test("wraps the table in an overflow container", () => {
    const html = renderToStaticMarkup(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>abc123</TableCell>
          </TableRow>
        </TableBody>
        <TableCaption>All runs</TableCaption>
      </Table>,
    );
    expect(html).toContain("sui-table-container");
    expect(html).toContain("sui-table");
    expect(html).toContain("<thead");
    expect(html).toContain("abc123");
    expect(html).toContain("<caption");
    expect(html).toContain('data-slot="table-caption"');
    expect(html).toContain("All runs");
  });
});

describe("Tabs", () => {
  test("renders triggers with count pills and the active content", () => {
    const html = renderToStaticMarkup(
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs" count={12}>
            Runs
          </TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">run list</TabsContent>
        <TabsContent value="events">event list</TabsContent>
      </Tabs>,
    );
    expect(html).toContain("sui-tabs-list");
    expect(html).toContain("sui-tabs-trigger");
    expect(html).toContain("sui-tab-count");
    expect(html).toContain(">12<");
    expect(html).toContain("run list");
    expect(html).not.toContain("event list");
  });
});

describe("misc primitives", () => {
  test("Spinner announces status; Skeleton is aria-hidden", () => {
    const spinner = renderToStaticMarkup(<Spinner />);
    expect(spinner).toContain('role="status"');
    expect(spinner).toContain("sui-spinner");
    const skeleton = renderToStaticMarkup(<Skeleton style={{ width: 120 }} />);
    expect(skeleton).toContain("sui-skeleton");
    expect(skeleton).toContain("aria-hidden");
  });

  test("Progress carries value semantics and the translated indicator", () => {
    const html = renderToStaticMarkup(<Progress value={40} />);
    expect(html).toContain("sui-progress");
    expect(html).toContain("sui-progress-indicator");
    expect(html).toContain("translateX(-60%)");
  });

  test("Progress scales the indicator by max and clamps out-of-range values", () => {
    const scaled = renderToStaticMarkup(<Progress value={25} max={50} />);
    expect(scaled).toContain('aria-valuemax="50"');
    expect(scaled).toContain("translateX(-50%)");
    expect(renderToStaticMarkup(<Progress value={80} max={50} />)).toContain("translateX(-0%)");
    expect(renderToStaticMarkup(<Progress value={-10} />)).toContain("translateX(-100%)");
  });

  test("Progress announces the same clamped value it paints", () => {
    const over = renderToStaticMarkup(<Progress value={80} max={50} />);
    expect(over).toContain('aria-valuenow="50"');
    expect(over).toContain('data-state="complete"');
    const under = renderToStaticMarkup(<Progress value={-10} />);
    expect(under).toContain('aria-valuenow="0"');
    expect(under).toContain('data-state="loading"');
    const unknown = renderToStaticMarkup(<Progress value={Number.NaN} />);
    expect(unknown).toContain('data-state="indeterminate"');
    expect(unknown).not.toContain("aria-valuenow");
  });

  test("Separator renders orientation data attributes", () => {
    expect(renderToStaticMarkup(<Separator />)).toContain('data-orientation="horizontal"');
    expect(renderToStaticMarkup(<Separator orientation="vertical" />)).toContain('data-orientation="vertical"');
  });

  test("EmptyState renders optional slots", () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No runs yet" description="Launch one to see it here." action={<Button>Launch</Button>} />,
    );
    expect(html).toContain("sui-empty");
    expect(html).toContain("No runs yet");
    expect(html).toContain("sui-empty-action");
  });

  test("SectionHeader composes eyebrow, title, and actions", () => {
    const html = renderToStaticMarkup(
      <SectionHeader eyebrow="Workflow" title="Implement" actions={<Button size="sm">Refresh</Button>} />,
    );
    expect(html).toContain("sui-eyebrow");
    expect(html).toContain("sui-section-header-title");
    expect(html).toContain("sui-section-header-actions");
    expect(renderToStaticMarkup(<Eyebrow>Docs</Eyebrow>)).toContain("sui-eyebrow");
  });

  test("RowButton reflects the active state", () => {
    const active = renderToStaticMarkup(<RowButton active>row</RowButton>);
    expect(active).toContain('data-active="true"');
    const idle = renderToStaticMarkup(<RowButton>row</RowButton>);
    expect(idle).not.toContain("data-active");
  });

  test("KpiStat renders label/value/hint", () => {
    const html = renderToStaticMarkup(<KpiStat label="Total runs" value={42} hint="last 7 days" />);
    expect(html).toContain("sui-kpi-label");
    expect(html).toContain("sui-kpi-value");
    expect(html).toContain("sui-kpi-hint");
  });

  test("FileTree nests a flat path list and marks the selected leaf", () => {
    const html = renderToStaticMarkup(
      <FileTree
        nodes={["src/app/main.ts", "README.md"]}
        selected="README.md"
        renderAffordance={(node) => (node.path === "README.md" ? <span className="dot" /> : null)}
      />,
    );
    expect(html).not.toContain('role="tree"');
    expect(html).toContain('data-slot="file-tree"');
    expect(html).toContain("sui-file-tree-dir-toggle");
    expect(html).toContain("main.ts");
    expect(html).toContain('data-active="true"');
    expect(html).toContain("sui-file-tree-affordance");
  });
});

describe("CollapsiblePanel", () => {
  test("renders title, status pill glyph, meta, and children (open by default)", () => {
    const html = renderToStaticMarkup(
      <CollapsiblePanel title="Research" status="ok" statusLabel="ready" meta="2 findings">
        <div>context body</div>
      </CollapsiblePanel>,
    );
    expect(html).toContain("sui-collapsible");
    expect(html).toContain('data-slot="collapsible-panel"');
    expect(html).toContain('data-state="open"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Research");
    expect(html).toContain("2 findings");
    // The status prop drives a StatusPill: tint + glyph come from status.ts,
    // not a locally re-derived class.
    expect(html).toContain("sui-badge-success");
    expect(html).toContain('data-status="ok"');
    expect(html).toContain("sui-status-dot");
    expect(html).toContain("ready");
    expect(html).toContain("sui-collapsible-body");
    expect(html).toContain("context body");
    expect(html).toContain("collapse");
  });

  test("status prop maps buckets onto the StatusPill tint", () => {
    expect(
      renderToStaticMarkup(
        <CollapsiblePanel title="Run" status="running">
          x
        </CollapsiblePanel>,
      ),
    ).toContain("sui-badge-default");
    expect(
      renderToStaticMarkup(
        <CollapsiblePanel title="Run" status="failed">
          x
        </CollapsiblePanel>,
      ),
    ).toContain("sui-badge-destructive");
    // No status prop -> no pill.
    expect(renderToStaticMarkup(<CollapsiblePanel title="Run">x</CollapsiblePanel>)).not.toContain("sui-status-dot");
  });

  test("renders the empty fallback when no children are supplied", () => {
    const html = renderToStaticMarkup(<CollapsiblePanel title="Plan" emptyText="Creating plan." />);
    expect(html).toContain("sui-collapsible-empty");
    expect(html).toContain("Creating plan.");
    expect(html).not.toContain("sui-collapsible-body");
  });

  test("pending forces the fallback even with children present", () => {
    const html = renderToStaticMarkup(
      <CollapsiblePanel title="Validate" pending emptyText="Validating.">
        <div>should be hidden</div>
      </CollapsiblePanel>,
    );
    expect(html).toContain("Validating.");
    expect(html).not.toContain("should be hidden");
  });

  test("defaultOpen={false} starts collapsed and hides the body", () => {
    const html = renderToStaticMarkup(
      <CollapsiblePanel title="Review" defaultOpen={false}>
        <div>hidden until expanded</div>
      </CollapsiblePanel>,
    );
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("expand");
    expect(html).not.toContain("hidden until expanded");
  });

  test("controlled open renders per the open prop", () => {
    const closed = renderToStaticMarkup(
      <CollapsiblePanel title="Merge" open={false}>
        <div>merge body</div>
      </CollapsiblePanel>,
    );
    expect(closed).not.toContain("merge body");
    const open = renderToStaticMarkup(
      <CollapsiblePanel title="Merge" open>
        <div>merge body</div>
      </CollapsiblePanel>,
    );
    expect(open).toContain("merge body");
  });
});

describe("StageStrip", () => {
  const stages = [
    { label: "Target", status: "done" },
    { label: "Preview", status: "active" },
    { label: "Review", status: "pending" },
    { label: "Summary", status: "failed" },
  ];

  test("stageTone buckets the status vocabulary into the four tones", () => {
    expect(stageTone("done")).toBe("done");
    expect(stageTone("complete")).toBe("done");
    expect(stageTone("active")).toBe("active");
    expect(stageTone("running")).toBe("active");
    expect(stageTone("pending")).toBe("pending");
    expect(stageTone(undefined)).toBe("pending");
    expect(stageTone("failed")).toBe("failed");
    expect(stageTone("cancelled")).toBe("pending");
  });

  test("tints each chip via the shared badge variants and carries the tone", () => {
    const html = renderToStaticMarkup(<StageStrip stages={stages} />);
    expect(html).toContain("sui-stage-strip");
    expect(html).toContain("sui-stage-chip");
    // done -> success, active -> brand default, pending -> muted, failed -> destructive.
    expect(html).toContain("sui-badge-success");
    expect(html).toContain("sui-badge-default");
    expect(html).toContain("sui-badge-muted");
    expect(html).toContain("sui-badge-destructive");
    expect(html).toContain('data-tone="done"');
    expect(html).toContain('data-tone="active"');
    expect(html).toContain('data-tone="pending"');
    expect(html).toContain('data-tone="failed"');
    expect(html).toContain('data-status="active"');
    expect(html).toContain("Target");
    expect(html).toContain("Summary");
  });

  test("optional summary header counts terminal-status stages over the total", () => {
    // done + failed are terminal; active + pending are not -> 2/4.
    const html = renderToStaticMarkup(<StageStrip stages={stages} showSummary summaryLabel="Phases" />);
    expect(html).toContain("sui-stage-strip-summary");
    expect(html).toContain("Phases");
    expect(html).toContain("2/4");
    // No header unless asked for.
    expect(renderToStaticMarkup(<StageStrip stages={stages} />)).not.toContain("sui-stage-strip-summary");
  });

  test("renders nothing for an empty stages array", () => {
    expect(renderToStaticMarkup(<StageStrip stages={[]} />)).toBe("");
  });
});

describe("SmithersUiStyles", () => {
  test("renders the marker style tag with the component sheet", () => {
    const html = renderToStaticMarkup(<SmithersUiStyles />);
    expect(html).toContain("data-smithers-ui");
    expect(html).toContain(".sui-button");
    expect(html).toContain(".sui-card");
  });

  test("withTheme prepends the styleguide theme tokens for standalone hosts", () => {
    const css = composeSmithersUiStyles({ withTheme: true });
    expect(css).toContain("color-scheme:light");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(":root[data-theme='dark']");
    expect(css.indexOf("color-scheme:light")).toBeLessThan(css.indexOf(".sui-button"));
  });

  test("extra CSS lands after the component sheet", () => {
    const css = composeSmithersUiStyles({ extra: ".mine { color: red; }" });
    expect(css.endsWith(".mine { color: red; }")).toBe(true);
    expect(css).toContain(smithersUiCss);
  });
});
