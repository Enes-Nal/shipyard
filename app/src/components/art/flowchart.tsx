import { type CSSProperties, useId } from "react";

import type { Flowchart, Layout } from "@/lib/art/mermaid";

const PAD = 14;

// edgePath is an edge's curve, and its ends: an edge back up the flow
// loops out below the nodes it joins.
function edgePath(layout: Layout, a: { x: number; y: number }, b: { x: number; y: number }) {
  const { NW, NH, lr } = layout;
  const [x0, y0, x1, y1] = lr ? [a.x + NW, a.y + NH / 2, b.x - 2, b.y + NH / 2] : [a.x + NW / 2, a.y + NH, b.x + NW / 2, b.y - 2];
  const back = lr ? x1 < x0 : y1 < y0;
  const c = back ? [x0 + 60, y0 + 70, x1 - 60, y1 + 70] : lr ? [(x0 + x1) / 2, y0, (x0 + x1) / 2, y1] : [x0, (y0 + y1) / 2, x1, (y0 + y1) / 2];
  return { x0, y0, x1, y1, back, c, d: `M${x0},${y0} C${c[0]},${c[1]} ${c[2]},${c[3]} ${x1},${y1}` };
}

// flowchartBox is the drawing's viewBox: the nodes, with room around
// them, and with fit, the loops of edges back up the flow too, which an
// artifact's diagram leaves to its frame to cut.
export function flowchartBox(g: Flowchart, layout: Layout, fit = false): { x: number; y: number; w: number; h: number } {
  let [x0, y0, x1, y1] = [0, 0, layout.W, layout.H];
  if (fit)
    for (const e of g.edges) {
      const a = layout.pos[e.from];
      const b = layout.pos[e.to];
      if (!a || !b) continue;
      const p = edgePath(layout, a, b);
      if (!p.back) continue;
      // The curve's extent, sampled: near enough for a margin.
      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;
        const x = u * u * u * p.x0 + 3 * u * u * t * p.c[0] + 3 * u * t * t * p.c[2] + t * t * t * p.x1;
        const y = u * u * u * p.y0 + 3 * u * u * t * p.c[1] + 3 * u * t * t * p.c[3] + t * t * t * p.y1;
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    }
  return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
}

// FlowchartSvg draws a Mermaid flowchart laid out by lib/art/mermaid.ts in
// the theme's chart colours (--chart-*, set by an .art-scope around it):
// an artifact's diagram, and a mermaid block in a reply. A thumb is a
// card's small picture: bolder lines, no edge labels. fit: flowchartBox.
export function FlowchartSvg({ g, layout, thumb = false, fit = false, className, style }: { g: Flowchart; layout: Layout; thumb?: boolean; fit?: boolean; className?: string; style?: CSSProperties }) {
  const arrow = `art-arrow-${useId().replace(/:/g, "")}`;
  const { pos, NW, NH } = layout;
  const box = flowchartBox(g, layout, fit);
  return (
    <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} className={className} style={style} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Diagram: ${g.nodes.map((n) => n.label).join(", ")}`}>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--chart-foreground-muted)" />
        </marker>
      </defs>
      {g.edges.map((e, i) => {
        const a = pos[e.from];
        const b = pos[e.to];
        if (!a || !b) return null;
        const { x0, y0, x1, y1, d } = edgePath(layout, a, b);
        return (
          <g key={i} className="art-edge" style={{ animationDelay: `${Math.min(i * 40, 600)}ms` }}>
            <path d={d} fill="none" stroke="var(--chart-foreground-muted)" strokeOpacity={thumb ? 0.9 : 0.75} strokeWidth={(thumb ? 2.4 : 1.4) * (e.thick ? 1.7 : 1)} strokeDasharray={e.dotted ? "4 4" : undefined} markerEnd={e.arrow ? `url(#${arrow})` : undefined} />
            {e.label && !thumb && (
              <g transform={`translate(${(x0 + x1) / 2}, ${(y0 + y1) / 2})`}>
                <rect x={-e.label.length * 3.3 - 6} y={-9} width={e.label.length * 6.6 + 12} height={18} rx={9} fill="var(--background)" stroke="var(--border)" />
                <text textAnchor="middle" dy="0.32em" className="art-tick">
                  {e.label}
                </text>
              </g>
            )}
          </g>
        );
      })}
      {g.nodes.map((n, i) => {
        const p = pos[n.id];
        const store = n.shape === "store";
        const tint = store ? "var(--chart-3)" : n.shape === "diamond" ? "var(--chart-4)" : i === 0 ? "var(--chart-1)" : undefined;
        const r = n.shape === "round" || n.shape === "circle" ? NH / 2 : n.shape === "diamond" ? 4 : 8;
        return (
          <g key={n.id} transform={`translate(${p.x}, ${p.y})`} className="art-node-g" style={{ animationDelay: `${Math.min(i * 50, 600)}ms` }}>
            <rect width={NW} height={NH} rx={r} fill={tint ? `color-mix(in oklab, ${tint} ${thumb ? 30 : 16}%, var(--card))` : "var(--card)"} stroke={tint ? `color-mix(in oklab, ${tint} 60%, var(--border))` : "var(--border)"} strokeWidth={thumb ? 2 : 1.2} />
            {store && <path d={`M8,7 Q${NW / 2},15 ${NW - 8},7`} fill="none" stroke={`color-mix(in oklab, ${tint} 60%, var(--border))`} strokeWidth={1.1} />}
            <text x={NW / 2} y={NH / 2 + (store ? 3 : 0)} textAnchor="middle" dy="0.34em" className="art-node" fontWeight={500}>
              {n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
