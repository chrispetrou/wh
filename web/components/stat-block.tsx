"use client";

// a stat block inside the transcript: ranked label/value rows with flat
// svg bars, optionally opened by a sparkline of weekly counts (who,
// churn, activity). read-only: no selection, no expand, nothing to fetch.

import type { Block } from "@/lib/block";

type Stat = Extract<Block, { kind: "stat" }>;

const ROW_H = 22; // the viewBox height, like the log rails
const BAR_W = 120; // the bar column, matching the 20ch text budget
const BAR_H = 7;
const STEP = 5; // one week: a 3px bar and a 2px gap

function Spark({ values, label }: { values: number[]; label: string }) {
  const w = values.length * STEP;
  const max = Math.max(1, ...values);
  return (
    <div className="mb-1">
      <svg
        viewBox={`0 0 ${w} ${ROW_H}`}
        style={{ width: w, height: ROW_H, display: "block", maxWidth: "100%" }}
        aria-hidden="true"
      >
        {values.map((v, i) => {
          // a zero week keeps a faint tick so the spark reads as a timeline
          const h = v ? Math.max(1.5, (v / max) * (ROW_H - 2)) : 1;
          return (
            <rect
              key={i}
              x={i * STEP}
              y={ROW_H - h}
              width={3}
              height={h}
              fill={v ? "var(--wd-accent)" : "var(--wd-faint)"}
            />
          );
        })}
      </svg>
      <div className="text-muted-foreground">{label}</div>
    </div>
  );
}

export function StatBlock({ block, fresh }: { block: Stat; fresh: boolean }) {
  const widest = (xs: string[]) => Math.max(1, ...xs.map((s) => s.length));
  const col = (chars: number) => `calc(${chars}ch + 12px)`;
  const cols = `${col(widest(block.rows.map((r) => r.label)))} ${BAR_W}px ${col(
    widest(block.rows.map((r) => r.value))
  )} minmax(0, 1fr)`;
  // the group header renders once per run; settled before the JSX so no
  // render-scope variable is written from inside it
  const heads: Array<string | null> = [];
  let group: string | undefined;
  for (const r of block.rows) {
    heads.push(r.group && r.group !== group ? r.group : null);
    group = r.group ?? group;
  }
  return (
    <div className={`log-block ${fresh ? "block-in" : ""}`}>
      {block.spark ? <Spark values={block.spark.values} label={block.spark.label} /> : null}
      {block.rows.map((r, i) => {
        const head = heads[i];
        return (
          <div key={i}>
            {head ? <div className={`text-wd-amber ${i ? "mt-2" : ""}`}>{head}</div> : null}
            <div className="log-row stat-row" style={{ gridTemplateColumns: cols }}>
              <span className="log-cell">{r.label}</span>
              <svg
                viewBox={`0 0 ${BAR_W} ${ROW_H}`}
                preserveAspectRatio="none"
                style={{ width: BAR_W, height: "100%" }}
                aria-hidden="true"
              >
                <rect
                  x={0}
                  y={(ROW_H - BAR_H) / 2}
                  width={Math.max(r.share > 0 ? 1 : 0, r.share * BAR_W)}
                  height={BAR_H}
                  fill="var(--wd-accent)"
                />
              </svg>
              <span className="log-cell text-muted-foreground">{r.value}</span>
              <span className="log-cell text-muted-foreground">{r.note ?? ""}</span>
            </div>
          </div>
        );
      })}
      {block.footer.map((f, i) => (
        <div key={i} className="text-muted-foreground">
          {f}
        </div>
      ))}
    </div>
  );
}
