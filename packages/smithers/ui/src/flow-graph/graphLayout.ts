/** Pure small-DAG geometry, shared by browser and terminal views. */
export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly state: "next" | "current" | "done" | "failed" | "waiting" | "cancelled" | "skipped";
}
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** Omit when the journal records dependency without a reason. */
  readonly kind?: "value" | "continuation" | "failure";
  readonly label?: string;
}
export type GraphDirection = "LR" | "TB";
export interface GraphPosition { readonly id: string; readonly x: number; readonly y: number; }
export interface GraphLayout {
  readonly nodes: ReadonlyArray<GraphPosition>;
  readonly ranks: ReadonlyArray<ReadonlyArray<string>>;
  readonly width: number;
  readonly height: number;
  readonly direction: GraphDirection;
}
const NODE_W = 184, NODE_H = 72, GAP = 56, CROSS_GAP = 24, PAD = 32;
export const graphLayout = (nodes: ReadonlyArray<Pick<GraphNode, "id">>, edges: ReadonlyArray<GraphEdge>, direction: GraphDirection = "LR"): GraphLayout => {
  const ids = [...new Set(nodes.map((n) => n.id))];
  const incoming = new Map(ids.map((id) => [id, [] as string[]]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to) || edge.from === edge.to) continue;
    if (incoming.get(edge.to)!.includes(edge.from)) continue;
    incoming.get(edge.to)!.push(edge.from); outgoing.get(edge.from)!.push(edge.to);
  }
  const degree = new Map(ids.map((id) => [id, incoming.get(id)!.length]));
  const rank = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => degree.get(id) === 0), order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!; order.push(id);
    for (const to of outgoing.get(id)!) {
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
      degree.set(to, degree.get(to)! - 1);
      if (degree.get(to) === 0) queue.push(to);
    }
  }
  // Malformed cyclic evidence remains visible, without an unbounded traversal.
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const ranks: string[][] = [];
  for (const id of order) (ranks[rank.get(id)!] ??= []).push(id);
  for (let pass = 0; pass < 3; pass++) {
    const index = new Map(ranks.flatMap((group) => group.map((id, i) => [id, i] as const)));
    const mean = (id: string) => {
      const parents = incoming.get(id)!;
      return parents.length === 0 ? index.get(id)! : parents.reduce((sum, p) => sum + index.get(p)!, 0) / parents.length;
    };
    for (const group of ranks) group.sort((a, b) => mean(a) - mean(b));
  }
  const crossSize = direction === "LR" ? NODE_H : NODE_W;
  const centers = new Map<string, number>();
  for (const group of ranks) {
    const wants = group.map((id) => {
      const parents = incoming.get(id)!.filter((p) => centers.has(p));
      return parents.length === 0 ? 0 : parents.reduce((sum, p) => sum + centers.get(p)!, 0) / parents.length;
    });
    const positions: number[] = [];
    group.forEach((_, i) => positions.push(i === 0 ? wants[i]! : Math.max(wants[i]!, positions[i - 1]! + crossSize + CROSS_GAP)));
    const shift = wants.reduce((sum, want, i) => sum + want - positions[i]!, 0) / group.length;
    group.forEach((id, i) => centers.set(id, positions[i]! + shift));
  }
  const min = Math.min(0, ...centers.values());
  const positioned = order.map((id) => {
    const main = rank.get(id)! * ((direction === "LR" ? NODE_W : NODE_H) + GAP) + PAD;
    const cross = centers.get(id)! - min + PAD;
    return { id, x: direction === "LR" ? main : cross, y: direction === "LR" ? cross : main };
  });
  return { nodes: positioned, ranks, direction,
    width: Math.max(0, ...positioned.map((p) => p.x + NODE_W)) + PAD,
    height: Math.max(0, ...positioned.map((p) => p.y + NODE_H)) + PAD };
};
export const fitGraph = (nodes: ReadonlyArray<GraphNode>, edges: ReadonlyArray<GraphEdge>, width: number, height: number) => {
  const lr = graphLayout(nodes, edges), tb = graphLayout(nodes, edges, "TB");
  const fit = (g: GraphLayout) => Math.min(width / g.width, height / g.height);
  return fit(tb) > fit(lr) ? tb : lr;
};
/** Navigation follows recorded dependencies; disconnected nodes remain reachable. */
export const graphNeighbour = (nodes: ReadonlyArray<GraphNode>, edges: ReadonlyArray<GraphEdge>, selected: string | null, forward: boolean): string | undefined => {
  const linked = edges.find((e) => forward ? e.from === selected : e.to === selected);
  const candidate = linked === undefined ? undefined : forward ? linked.to : linked.from;
  if (nodes.some((n) => n.id === candidate)) return candidate;
  const index = nodes.findIndex((n) => n.id === selected);
  return nodes[Math.max(0, Math.min(nodes.length - 1, index + (forward ? 1 : -1)))]?.id;
};
