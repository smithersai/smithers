/** @jsxImportSource react */
import { Badge } from "../badge";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { Kbd } from "../kbd";
import { useInjectUiCss } from "../styles";

export type FrameScrubberProps = {
  readonly totalFrames: number;
  readonly currentFrame: number;
  readonly isLive: boolean;
  readonly onStepBack: () => void;
  readonly onStepForward: () => void;
  readonly onSeek: (frame: number) => void;
  readonly onReturnLive: () => void;
  readonly className?: string;
};

/**
 * Replay and time-travel cursor synchronizing Plan Tree, Wiki, Canvas, and Trace panes.
 * Reads and writes the URL replay frame via controlled callbacks only.
 */
export function FrameScrubber({
  totalFrames,
  currentFrame,
  isLive,
  onStepBack,
  onStepForward,
  onSeek,
  onReturnLive,
  className,
}: FrameScrubberProps) {
  useInjectUiCss();
  const hasFrames = totalFrames > 0;
  const maxFrame = Math.max(0, totalFrames - 1);
  const clamped = hasFrames ? Math.min(Math.max(0, currentFrame), maxFrame) : 0;
  const frameText = hasFrames ? `Frame ${clamped + 1} of ${totalFrames}` : "No frames";

  return (
    <div
      data-slot="frame-scrubber"
      data-live={isLive ? "true" : "false"}
      data-empty={hasFrames ? "false" : "true"}
      role="region"
      aria-label="Replay frame cursor"
      className={cn("sui-card", className)}
      onKeyDown={(event) => {
        if (!hasFrames) return;
        if (event.key === "[" && clamped > 0) {
          event.preventDefault();
          onStepBack();
        } else if (event.key === "]" && clamped < maxFrame) {
          event.preventDefault();
          onStepForward();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px",
        flexWrap: "wrap",
      }}
    >
      <Badge variant={isLive ? "success" : hasFrames ? "warning" : "muted"}>
        {isLive ? "Live" : frameText}
      </Badge>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onStepBack}
        disabled={!hasFrames || clamped <= 0}
        aria-label="Previous frame"
      >
        Prev <Kbd>[</Kbd>
      </Button>

      <input
        type="range"
        aria-label="Replay frame position"
        aria-valuetext={frameText}
        min={0}
        max={maxFrame}
        value={clamped}
        disabled={!hasFrames}
        onChange={(event) => {
          if (hasFrames) onSeek(Number(event.currentTarget.value));
        }}
        style={{ flex: 1, minWidth: "120px" }}
      />

      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onStepForward}
        disabled={!hasFrames || clamped >= maxFrame}
        aria-label="Next frame"
      >
        Next <Kbd>]</Kbd>
      </Button>

      {!isLive ? (
        <Button type="button" size="sm" variant="outline" onClick={onReturnLive}>
          Return to live
        </Button>
      ) : null}
    </div>
  );
}
