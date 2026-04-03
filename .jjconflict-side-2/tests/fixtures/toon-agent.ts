export const echo = {
  id: "echo",
  async generate({ prompt }: { prompt: string }) {
    return {
      text: JSON.stringify({ message: prompt }),
    };
  },
};

function extractLine(prompt: string, label: string): string | null {
  const regex = new RegExp(`${label}\\s*:\\s*(.+)`, "i");
  const match = prompt.match(regex);
  return match?.[1]?.trim() ?? null;
}

export const researcher = {
  id: "researcher",
  async generate({ prompt }: { prompt: string }) {
    const topic =
      extractLine(prompt, "Topic") ??
      extractLine(prompt, "Subject") ??
      "Unknown topic";
    const summary = `${topic} has a clear evolution and ecosystem.`;
    const keyPoints = [
      `${topic} origins`,
      `${topic} adoption`,
      `${topic} tooling`,
    ];
    return {
      output: { summary, keyPoints },
    };
  },
};

export const writer = {
  id: "writer",
  async generate({ prompt }: { prompt: string }) {
    const summary = extractLine(prompt, "Summary") ?? "Summary unavailable";
    const title = `Report: ${summary.replace(/\.$/, "")}`;
    const keyPointsLine = extractLine(prompt, "Key points") ?? "";
    const points = keyPointsLine
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const body =
      points.length > 0
        ? `Summary: ${summary}\nHighlights: ${points.join("; ")}`
        : `Summary: ${summary}`;
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    return {
      output: { title, body, wordCount },
    };
  },
};
