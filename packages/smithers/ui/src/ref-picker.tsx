/** @jsxImportSource react */
import { type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode, useState } from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import { cn } from "@smthrs/ui-css";
import { Input } from "./input";
import { isPlainNavigationClick } from "./internal/navigationClick";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Skeleton } from "./skeleton";
import { useInjectUiCss } from "./styles";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

/** A branch or tag: its name and the commit it names. */
export type RefPickerRef = { readonly name: string; readonly sha: string };

/** The repository's branches and tags, as the host has loaded them. */
export type RefPickerRefs =
  | { readonly state: "loading" }
  | {
    readonly state: "ready";
    readonly branches: ReadonlyArray<RefPickerRef>;
    readonly tags: ReadonlyArray<RefPickerRef>;
    /** The host stopped listing before the end: the picker says so under the list. */
    readonly truncated?: boolean | undefined;
  }
  | { readonly state: "failed"; readonly message: ReactNode };

export type RefPickerProps = Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  /** What the button shows: the branch or tag the view is at, or its commit's short SHA. */
  current: ReactNode;
  /** The name or full SHA the view is at, marked in the list. */
  selected?: string | undefined;
  refs: RefPickerRefs;
  /** The default branch, marked `default` in the list. */
  defaultBranch?: string | undefined;
  /** The URL of a ref (a branch or tag name, or a full SHA), so every choice is a real link. */
  href: (ref: string) => string;
  /**
   * A plain click on a choice, or Enter in the filter on the first one. The
   * browser's default is prevented first; a modified click (⌘, Ctrl, Shift,
   * Alt, middle button) keeps the browser's behavior, so a ref still opens in
   * a new tab.
   */
  onSelect: (ref: string) => void;
};

const FULL_SHA = /^[0-9a-f]{40}$/i;

function BranchIcon() {
  return (
    <svg className="sui-ref-picker-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.25v5.5M11.5 6.75c0 3-7 2-7 4" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * A branch and tag picker, as a repository view's revision: a button showing
 * where the view is, opening a filter over the branches and the tags, each
 * with its commit's short SHA and counted on its tab. Typing a full 40-hex
 * SHA offers that commit too. Every choice is a link, and choosing one
 * closes the picker.
 */
export function RefPicker({
  current,
  selected,
  refs,
  defaultBranch,
  href,
  onSelect,
  className,
  ...props
}: RefPickerProps) {
  useInjectUiCss();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"branches" | "tags">("branches");
  const needle = query.trim().toLowerCase();
  const matching = (list: ReadonlyArray<RefPickerRef>) =>
    list.filter((ref) => ref.name.toLowerCase().includes(needle));
  const branches = refs.state === "ready" ? matching(refs.branches) : [];
  const tags = refs.state === "ready" ? matching(refs.tags) : [];
  const commit = FULL_SHA.test(query.trim()) ? query.trim().toLowerCase() : undefined;

  const choose = (ref: string) => {
    setOpen(false);
    setQuery("");
    onSelect(ref);
  };
  const follow = (ref: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainNavigationClick(event)) return;
    event.preventDefault();
    choose(ref);
  };
  const first = commit ?? (tab === "branches" ? branches : tags)[0]?.name;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== "Enter" || first === undefined) return;
    event.preventDefault();
    choose(first);
  };
  const list = (items: ReadonlyArray<RefPickerRef>) =>
    items.length === 0 ? <div className="sui-ref-picker-note">No match</div> : (
      <ul className="sui-ref-picker-list">
        {items.map((ref) => (
          <li key={ref.name}>
            <a
              className="sui-ref-picker-item"
              href={href(ref.name)}
              aria-current={ref.name === selected ? "true" : undefined}
              onClick={follow(ref.name)}
            >
              <span className="sui-ref-picker-name">{ref.name}</span>
              {ref.name === defaultBranch ? <Badge variant="secondary">default</Badge> : null}
              <code className="sui-ref-picker-sha">{ref.sha.slice(0, 7)}</code>
            </a>
          </li>
        ))}
      </ul>
    );

  return (
    <div data-slot="ref-picker" className={cn("sui-ref-picker", className)} {...props}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="sui-ref-picker-trigger">
            <BranchIcon />
            <span className="sui-ref-picker-current">{current}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="sui-ref-picker-panel" aria-label="Branches and tags">
          <Input
            className="sui-ref-picker-filter"
            aria-label="Find a branch, tag or SHA"
            placeholder="Branch, tag or SHA"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {commit === undefined ? null : (
            <a className="sui-ref-picker-item" href={href(commit)} onClick={follow(commit)}>
              <code className="sui-ref-picker-name">{commit.slice(0, 7)}</code>
            </a>
          )}
          {refs.state === "loading" ?
            (
              <div className="sui-ref-picker-loading" role="status" aria-label="Loading branches and tags">
                <Skeleton className="sui-ref-picker-skeleton" />
                <Skeleton className="sui-ref-picker-skeleton" />
                <Skeleton className="sui-ref-picker-skeleton" />
              </div>
            ) :
            null}
          {refs.state === "failed" ? <div className="sui-ref-picker-note" role="alert">{refs.message}</div> : null}
          {refs.state === "ready" ?
            (
              <Tabs value={tab} onValueChange={(value) => setTab(value as "branches" | "tags")}>
                <TabsList>
                  <TabsTrigger value="branches" count={refs.branches.length}>Branches</TabsTrigger>
                  <TabsTrigger value="tags" count={refs.tags.length}>Tags</TabsTrigger>
                </TabsList>
                <TabsContent value="branches">{list(branches)}</TabsContent>
                <TabsContent value="tags">{list(tags)}</TabsContent>
              </Tabs>
            ) :
            null}
          {refs.state === "ready" && refs.truncated === true ?
            <div className="sui-ref-picker-note">More not shown</div> :
            null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
