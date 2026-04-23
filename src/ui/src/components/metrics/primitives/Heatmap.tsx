import { useEffect, useRef, useState } from "react";
import styles from "../metrics.module.css";
import type { HeatmapCell } from "../../../types/metrics";

interface HeatmapProps {
  cells: HeatmapCell[];
  weeks?: number;
  days?: number;
  cellSize?: number;
  gap?: number;
}

export function Heatmap({
  cells,
  weeks = 13,
  days = 7,
  cellSize = 11,
  gap = 2,
}: HeatmapProps) {
  const max = cells.reduce((m, c) => (c.count > m ? c.count : m), 0);
  const width = weeks * (cellSize + gap) - gap;
  const height = days * (cellSize + gap) - gap;

  // Pin the SVG to an explicit pixel height derived from its measured width.
  // `aspect-ratio` alone gives the right *size* but leaves the CSS Grid row
  // using a stale track height after window resize — an explicit pixel height
  // provides a concrete intrinsic block-size so the grid row refits cleanly.
  const svgRef = useRef<SVGSVGElement>(null);
  const [pxHeight, setPxHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setPxHeight((w * height) / width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [width, height]);

  const lookup = new Map<string, number>();
  for (const c of cells) {
    lookup.set(`${c.week}:${c.dow}`, c.count);
  }

  const rects = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < days; d++) {
      const count = lookup.get(`${w}:${d}`) ?? 0;
      const opacity = max === 0 ? 0.06 : 0.1 + (count / max) * 0.9;
      rects.push(
        <rect
          key={`${w}-${d}`}
          className={styles.heatCell}
          x={w * (cellSize + gap)}
          y={d * (cellSize + gap)}
          width={cellSize}
          height={cellSize}
          rx={2}
          fill="var(--accent-primary)"
          fillOpacity={count === 0 ? 0.06 : opacity}
        >
          <title>{`${count} sessions`}</title>
        </rect>
      );
    }
  }

  return (
    <svg
      ref={svgRef}
      className={styles.svg}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMinYMid meet"
      role="img"
      aria-label="session heatmap"
      style={{
        aspectRatio: `${width} / ${height}`,
        ...(pxHeight !== null ? { height: `${pxHeight}px` } : null),
      }}
    >
      {rects}
    </svg>
  );
}
