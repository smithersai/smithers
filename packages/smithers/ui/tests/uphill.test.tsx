/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UphillGauge, UphillScorecard, uphillScoreBand, type UphillReportData } from "../src";

const REPORT: UphillReportData = {
  categories: [
    {
      name: "footprint",
      title: "Footprint",
      score: 72,
      metrics: [
        {
          name: "bundle-size",
          title: "Bundle size",
          kind: "size",
          unit: "B",
          value: 14_200,
          score: 72,
          target: 5_000,
          items: [
            { name: "dist/index.js", value: 14_200, note: "Includes unused icons" },
          ],
        },
      ],
    },
    {
      name: "speed",
      title: "Speed",
      score: 96,
      metrics: [
        {
          name: "parse-time",
          title: "Parse time",
          kind: "time",
          unit: "ns",
          value: 440,
          score: 96,
          target: 500,
        },
      ],
    },
  ],
  opportunities: [
    {
      category: "footprint",
      metric: "bundle-size",
      item: "dist/index.js",
      value: 14_200,
      target: 5_000,
      gain: 21,
    },
  ],
  changes: [
    {
      category: "footprint",
      metric: "bundle-size",
      change: "worse",
      before: 12_000,
      after: 14_200,
    },
  ],
  comparison: {
    reference: "main (abc1234)",
    scores: [
      { category: "footprint", score: 78 },
      { category: "speed", score: 94 },
    ],
  },
};

describe("UphillGauge", () => {
  test("classifies score bands and renders accessible gauge markup", () => {
    expect(uphillScoreBand(95)).toBe("good");
    expect(uphillScoreBand(65)).toBe("warn");
    expect(uphillScoreBand(30)).toBe("poor");
    expect(uphillScoreBand(null)).toBe("none");
    expect(uphillScoreBand(100, true)).toBe("failed");

    const good = renderToStaticMarkup(<UphillGauge score={95} label="Speed" />);
    expect(good).toContain("data-band=\"good\"");
    expect(good).toContain("Speed: 95 out of 100");
    expect(good).toContain(">95<");

    const failed = renderToStaticMarkup(<UphillGauge score={null} label="Lint" failed />);
    expect(failed).toContain("data-band=\"failed\"");
    expect(failed).toContain("Lint: failed");
    expect(failed).toContain(">!<");
  });
});

describe("UphillScorecard", () => {
  test("renders category gauges, comparison deltas, opportunities, changes, metrics, and trend", () => {
    const html = renderToStaticMarkup(
      <UphillScorecard
        report={REPORT}
        branch="main"
        commit="deadbeef1234"
        history={[
          { commit: "1111111", overall: 74 },
          { commit: "deadbeef", overall: 84 },
        ]}
      />,
    );
    expect(html).toContain("Overall 84");
    expect(html).toContain("vs main (abc1234)");
    expect(html).toContain("-6");
    expect(html).toContain("+2");
    expect(html).toContain("+21");
    expect(html).toContain("14.2 kB → 5 kB");
    expect(html).toContain("Includes unused icons");
    expect(html).toContain("Trend (2 runs)");
    expect(html).toContain("worse");
  });

  test("renders empty state when report has no categories", () => {
    const html = renderToStaticMarkup(<UphillScorecard report={{ categories: [] }} />);
    expect(html).toContain("No Uphill categories scored");
  });
});
