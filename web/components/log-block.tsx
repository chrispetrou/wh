"use client";

// a log, history, or prs block inside the transcript: a grid of rows with
// an svg lane column, a `›` selection driven by the arrow keys (see
// terminal-chat), and an expandable panel per row with the commit or pr
// in full. everything in the panel is a way into explain.

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Block, CommitRow, PrRow } from "@/lib/block";
import { chatStore, type CommitDetail, type Detail, type PrDetail } from "@/lib/chat-store";
import type { LaneRow } from "@/lib/graph";
import { relTime } from "@/lib/utils";

const LANE_W = 14;
const PAD = 7;
const ROW_H = 22; // the viewBox height; the svg stretches to the row
const x = (lane: number) => PAD + lane * LANE_W;
const laneColor = (c: number) => `var(--wd-lane-${c % 6})`;

function railWidth(lanes: number): number {
  return lanes ? PAD * 2 + (lanes - 1) * LANE_W : 0;
}

// a cubic from (x1, y1) to (x2, y2), vertical where the lane is the same
function curve(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

const stroke = { strokeWidth: 1.5, fill: "none", vectorEffect: "non-scaling-stroke" } as const;

function Rails({ g, lanes, selected }: { g: Omit<LaneRow, "sha">; lanes: number; selected: boolean }) {
  const w = railWidth(lanes);
  const mid = ROW_H / 2;
  return (
    <svg
      className="log-rails"
      viewBox={`0 0 ${w} ${ROW_H}`}
      preserveAspectRatio="none"
      style={{ width: w }}
      aria-hidden="true"
    >
      {g.through.map((s, i) => (
        <path key={`t${i}`} d={curve(x(s.from), 0, x(s.to), ROW_H)} stroke={laneColor(s.color)} {...stroke} />
      ))}
      {g.ins.map((s, i) => (
        <path key={`i${i}`} d={curve(x(s.from), 0, x(g.lane), mid)} stroke={laneColor(s.color)} {...stroke} />
      ))}
      {g.outs.map((s, i) => (
        <path key={`o${i}`} d={curve(x(g.lane), mid, x(s.to), ROW_H)} stroke={laneColor(s.color)} {...stroke} />
      ))}
      {g.merge ? (
        <circle
          cx={x(g.lane)}
          cy={mid}
          r={selected ? 3.6 : 3}
          fill="var(--background)"
          stroke={laneColor(g.color)}
          strokeWidth={1.5}
        />
      ) : (
        <circle cx={x(g.lane)} cy={mid} r={selected ? 4 : 3.4} fill={laneColor(g.color)} />
      )}
    </svg>
  );
}

// the lanes continuing under an expanded row, stretched to the panel
function Through({ g, lanes }: { g: Omit<LaneRow, "sha">; lanes: number }) {
  const w = railWidth(lanes);
  const below = new Map<number, number>();
  for (const s of g.through) below.set(s.to, s.color);
  for (const s of g.outs) below.set(s.to, s.color);
  return (
    <svg className="log-rails" viewBox={`0 0 ${w} 10`} preserveAspectRatio="none" style={{ width: w }} aria-hidden="true">
      {[...below].map(([lane, color]) => (
        <path key={lane} d={`M ${x(lane)} 0 L ${x(lane)} 10`} stroke={laneColor(color)} {...stroke} />
      ))}
    </svg>
  );
}

function absolute(iso: string): string {
  return new Date(iso)
    .toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    .toLowerCase();
}

function Chip({ name, color }: { name: string; color: string }) {
  return (
    <span className="chip" style={{ color }}>
      {name}
    </span>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="log-action" onClick={onClick}>
      {children}
    </button>
  );
}

const rowId = (b: Block, i: number): string =>
  b.kind === "log" ? b.rows[i].sha : String(b.rows[i].num);

const NONE: string[] = [];

export function LogBlock({
  block,
  line,
  storeKey,
  owner,
  repo,
  submit,
}: {
  block: Block;
  line: number;
  storeKey: string;
  owner: string;
  repo: string;
  submit: (command: string) => void;
}) {
  const live = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.live(storeKey),
    () => undefined
  );
  const mine = live?.line === line;
  const selected = mine ? live!.selected : null;
  const expanded = mine ? live!.expanded : NONE;
  const rootRef = useRef<HTMLDivElement>(null);
  // the details map is replaced on every write, so its identity is a
  // stable snapshot; individual entries are read during render
  const details = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.details(storeKey),
    () => undefined
  );

  // fetch what is open and not known yet
  useEffect(() => {
    const kind = block.kind === "log" ? "commit" : "pr";
    expanded.forEach((id) => {
      const key = `${kind}:${id}`;
      if (chatStore.detail(storeKey, key)) return;
      chatStore.setDetail(storeKey, key, "loading");
      fetch(
        `/api/detail?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&kind=${kind}&id=${encodeURIComponent(id)}`
      )
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: Detail) => chatStore.setDetail(storeKey, key, d))
        .catch(() => chatStore.setDetail(storeKey, key, "failed"));
    });
  }, [expanded, block.kind, owner, repo, storeKey]);

  // keep the keyboard selection in view
  useEffect(() => {
    if (selected === null) return;
    rootRef.current?.querySelector(".row-sel")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const toggle = (i: number) => {
    const id = rowId(block, i);
    const open = expanded.includes(id) ? expanded.filter((e) => e !== id) : [...expanded, id];
    chatStore.setLive(storeKey, { line, selected: i, expanded: open });
  };
  const select = (i: number) =>
    chatStore.setLive(storeKey, { line, selected: i, expanded: mine ? expanded : [] });

  const numW = String(block.rows.length).length;
  const lanes = block.kind === "log" ? block.lanes : 0;
  const railW = railWidth(lanes);
  // the number column carries 8px of right padding (see .log-num)
  const cols =
    block.kind === "log"
      ? `2ch calc(${numW}ch + 8px) ${railW}px minmax(0, 1fr) auto auto auto`
      : `2ch calc(${numW + 1}ch + 8px) minmax(0, 1fr) auto auto auto`;
  const panelCols =
    block.kind === "log"
      ? `calc(${numW + 2}ch + ${railW + 8}px) minmax(0, 1fr)`
      : `calc(${numW + 3}ch + 8px) minmax(0, 1fr)`;

  return (
    <div ref={rootRef} className="log-block">
      <div className="log-row log-head" style={{ gridTemplateColumns: cols }}>
        <span />
        <span className="log-num">#</span>
        {block.kind === "log" ? <span /> : null}
        <span className="log-cell">{block.kind === "log" ? "description" : "title"}</span>
        <span className="log-cell">{block.kind === "log" ? "author" : "branches"}</span>
        <span className="log-cell">{block.kind === "log" ? "age" : "author"}</span>
        <span className="log-cell">{block.kind === "log" ? "sha" : "age"}</span>
      </div>
      {block.rows.map((row, i) => {
        const id = rowId(block, i);
        const isSel = selected === i;
        const isOpen = expanded.includes(id);
        const detail = isOpen
          ? details?.get(`${block.kind === "log" ? "commit" : "pr"}:${id}`)
          : undefined;
        return (
          <div key={id}>
            <div
              className={`log-row ${isSel ? "row-sel" : ""}`}
              style={{ gridTemplateColumns: cols }}
              onClick={() => toggle(i)}
              onMouseEnter={() => (mine ? select(i) : undefined)}
            >
              <span className="text-muted-foreground">{isSel ? "›" : ""}</span>
              {block.kind === "log" ? (
                <LogCells row={row as CommitRow} i={i} lanes={lanes} selected={isSel} />
              ) : (
                <PrCells row={row as PrRow} />
              )}
            </div>
            {isOpen ? (
              <div className="log-panel" style={{ gridTemplateColumns: panelCols }}>
                <div className="flex justify-end">
                  {block.kind === "log" && (row as CommitRow).graph && lanes ? (
                    <Through g={(row as CommitRow).graph!} lanes={lanes} />
                  ) : null}
                </div>
                <div className="log-panel-body">
                  {detail === undefined || detail === "loading" ? (
                    <span className="text-muted-foreground">fetching…</span>
                  ) : detail === "failed" ? (
                    <span>
                      <span className="text-wd-amber">error:</span> could not fetch this one
                    </span>
                  ) : detail.kind === "commit" ? (
                    <CommitPanel d={detail} block={block} submit={submit} jump={(sha) => jumpTo(block, sha, line, storeKey, submit)} />
                  ) : (
                    <PrPanel d={detail} submit={submit} />
                  )}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {block.footer.map((f, i) => (
        <div key={i} className="text-muted-foreground">
          {f}
        </div>
      ))}
      {mine ? (
        <div className="text-wd-faint">↑↓ select · enter open · esc back</div>
      ) : null}
    </div>
  );
}

// a parent link: select the parent's row when it is on screen, else explain it
function jumpTo(block: Block, sha: string, line: number, storeKey: string, submit: (c: string) => void) {
  if (block.kind !== "log") return;
  const i = block.rows.findIndex((r) => r.sha === sha);
  if (i < 0) {
    submit(sha);
    return;
  }
  const live = chatStore.live(storeKey);
  const expanded = live?.line === line ? live.expanded : [];
  chatStore.setLive(storeKey, {
    line,
    selected: i,
    expanded: expanded.includes(sha) ? expanded : [...expanded, sha],
  });
}

function LogCells({ row, i, lanes, selected }: { row: CommitRow; i: number; lanes: number; selected: boolean }) {
  const merge = row.graph?.merge ?? row.parents.length > 1;
  const color = row.graph ? laneColor(row.graph.color) : "var(--wd-accent)";
  return (
    <>
      <span className="log-num">{i + 1}</span>
      <span>{row.graph && lanes ? <Rails g={row.graph} lanes={lanes} selected={selected} /> : null}</span>
      <span className={`log-cell ${merge ? "text-muted-foreground" : ""}`}>
        {row.refs.map((r) => (
          <Chip
            key={r.name}
            name={r.name}
            color={r.kind === "default" ? "var(--wd-accent)" : r.kind === "tag" ? "var(--muted-foreground)" : color}
          />
        ))}
        {row.subject}
      </span>
      <span className="log-cell log-author text-muted-foreground">{row.author}</span>
      <span className="log-cell log-age text-muted-foreground" data-tip={absolute(row.date)}>
        {relTime(row.date)}
      </span>
      <span className="log-cell text-muted-foreground">{row.sha.slice(0, 7)}</span>
    </>
  );
}

function PrCells({ row }: { row: PrRow }) {
  return (
    <>
      <span className="log-num text-wd-accent" style={{ color: "var(--wd-accent)" }}>
        #{row.num}
      </span>
      <span className="log-cell">
        {row.title}
        {row.flags.length ? (
          <span className="text-muted-foreground"> · {row.flags.join(" · ")}</span>
        ) : null}
      </span>
      <span className="log-cell text-muted-foreground">
        {row.head} → {row.base}
      </span>
      <span className="log-cell log-author text-muted-foreground">{row.author}</span>
      <span className="log-cell log-age text-muted-foreground" data-tip={absolute(row.updated)}>
        {relTime(row.updated)}
      </span>
    </>
  );
}

function Files({ files, onPick }: { files: Detail["files"]; onPick: (path: string) => void }) {
  if (!files.length) return null;
  const w = Math.max(...files.map((f) => f.path.length));
  return (
    <div>
      {files.map((f) => (
        <div key={f.path}>
          <Action onClick={() => onPick(f.path)}>{f.path}</Action>
          <span className="text-muted-foreground">{" ".repeat(Math.max(w - f.path.length, 0) + 2)}</span>
          <span className="text-wd-green">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span>
          {f.status !== "modified" ? <span className="text-muted-foreground"> {f.status}</span> : null}
        </div>
      ))}
    </div>
  );
}

function CommitPanel({
  d,
  submit,
  jump,
}: {
  d: CommitDetail;
  block: Block;
  submit: (c: string) => void;
  jump: (sha: string) => void;
}) {
  const [subject, ...rest] = d.message.split("\n");
  const body = rest.join("\n").trim();
  const who = d.author.login ? `${d.author.login} · ${d.author.name}` : d.author.name;
  return (
    <div>
      <div>
        <span className="text-muted-foreground">sha      </span>
        {d.sha}{" "}
        <Action onClick={() => void navigator.clipboard?.writeText(d.sha)}>copy</Action>
      </div>
      {d.parents.length ? (
        <div>
          <span className="text-muted-foreground">parents  </span>
          {d.parents.map((p, i) => (
            <span key={p}>
              {i ? " " : ""}
              <Action onClick={() => jump(p)}>{p.slice(0, 7)}</Action>
            </span>
          ))}
        </div>
      ) : null}
      <div>
        <span className="text-muted-foreground">author   </span>
        {who}
        <span className="text-muted-foreground">
          {" "}
          · {absolute(d.author.date)} ({relTime(d.author.date)})
        </span>
      </div>
      <div className="mt-2">{subject}</div>
      {body ? <div className="text-muted-foreground">{body}</div> : null}
      <div className="mt-2">
        <Files files={d.files} onPick={(p) => submit(`explain ${d.sha.slice(0, 7)} in ${p}`)} />
      </div>
      <div className="mt-2">
        <Action onClick={() => submit(`explain ${d.sha.slice(0, 7)}`)}>explain</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => submit(`changelog ${d.sha.slice(0, 7)}`)}>changelog</Action>
        {d.url ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <a className="log-action" href={d.url} target="_blank" rel="noreferrer">
              github ↗
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

function PrPanel({ d, submit }: { d: PrDetail; submit: (c: string) => void }) {
  const body = d.body.trim().split("\n").slice(0, 20).join("\n");
  return (
    <div>
      <div>
        <span className="text-muted-foreground">pr       </span>#{d.num} {d.title}
      </div>
      <div>
        <span className="text-muted-foreground">by       </span>
        {d.author}
        <span className="text-muted-foreground">
          {" "}
          · {d.head} → {d.base}
          {d.flags.length ? ` · ${d.flags.join(" · ")}` : ""}
          {d.commits ? ` · ${d.commits} ${d.commits === 1 ? "commit" : "commits"}` : ""}
        </span>
      </div>
      {body ? <div className="mt-2 text-muted-foreground">{body}</div> : null}
      <div className="mt-2">
        <Files files={d.files} onPick={(p) => submit(`pr ${d.num} in ${p}`)} />
      </div>
      <div className="mt-2">
        <Action onClick={() => submit(`pr ${d.num}`)}>explain</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => submit(`changelog pr ${d.num}`)}>changelog</Action>
        {d.url ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <a className="log-action" href={d.url} target="_blank" rel="noreferrer">
              github ↗
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}
