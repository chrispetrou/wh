"use client";

// a log, history, or prs block inside the transcript: a grid of rows with
// an svg lane column, a `›` selection driven by the arrow keys (see
// terminal-chat), and an expandable panel per row with the commit or pr
// in full. everything in the panel is a way into explain.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CommitRow, ListBlock, PrRow } from "@/lib/block";
import { absolute, Action, Chip, CopyAction, Skel } from "./block-bits";
import { dragging, startDrag, type DragPayload } from "./drag-layer";
import {
  chatStore,
  type CommitDetail,
  type Detail,
  type DetailFailure,
  type PrDetail,
} from "@/lib/chat-store";
import type { LaneRow } from "@/lib/graph";
import { signInAgain } from "@/lib/signin";
import { useNow } from "@/lib/now";
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


// the panel before its fetch lands: what the row already knows is real,
// the rest breathes as placeholders, so opening never feels blocked
function CommitSkeleton({ row }: { row: CommitRow }) {
  return (
    <div>
      <div>
        <span className="text-muted-foreground">sha      </span>
        {row.sha}
      </div>
      <div>
        <span className="text-muted-foreground">parents  </span>
        {row.parents.length ? row.parents.map((p) => p.slice(0, 7)).join(" ") : <Skel w={7} />}
      </div>
      <div>
        <span className="text-muted-foreground">author   </span>
        {row.author}
        <span className="text-muted-foreground"> · {absolute(row.date)}</span>
      </div>
      <div className="mt-2">{row.subject}</div>
      <div className="text-muted-foreground">
        <Skel w={44} />
      </div>
      <div className="mt-2">
        <Skel w={22} /> <Skel w={8} />
        <br />
        <Skel w={30} /> <Skel w={8} />
      </div>
      <div className="mt-2 text-muted-foreground">explain · changelog · describe</div>
    </div>
  );
}

function PrSkeleton({ row }: { row: PrRow }) {
  return (
    <div>
      <div>
        <span className="text-muted-foreground">pr       </span>#{row.num} {row.title}
      </div>
      <div>
        <span className="text-muted-foreground">by       </span>
        {row.author}
        <span className="text-muted-foreground">
          {" "}
          · {row.head} → {row.base}
          {row.flags.length ? ` · ${row.flags.join(" · ")}` : ""}
        </span>
      </div>
      <div className="mt-2 text-muted-foreground">
        <Skel w={48} />
        <br />
        <Skel w={36} />
      </div>
      <div className="mt-2">
        <Skel w={26} /> <Skel w={8} />
      </div>
      <div className="mt-2 text-muted-foreground">explain · changelog · describe</div>
    </div>
  );
}

const rowId = (b: ListBlock, i: number): string =>
  b.kind === "log" ? b.rows[i].sha : String(b.rows[i].num);

const NONE: string[] = [];
const DRAG_THRESHOLD = 4;

// what a row says while it is carried
function payload(b: ListBlock, i: number): DragPayload {
  if (b.kind === "prs") {
    const r = b.rows[i];
    return { kind: "pr", id: String(r.num), label: `#${r.num} ${r.title.slice(0, 40)}` };
  }
  const r = b.rows[i];
  return { kind: "commit", id: r.sha, label: `● ${r.sha.slice(0, 7)} ${r.subject.slice(0, 40)}` };
}

export function LogBlock({
  block,
  line,
  storeKey,
  owner,
  repo,
  submit,
  fresh = false,
}: {
  block: ListBlock;
  line: number;
  storeKey: string;
  owner: string;
  repo: string;
  submit: (command: string) => void;
  fresh?: boolean; // just arrived in this session: enters with a fade
}) {
  const now = useNow();
  const live = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.live(storeKey),
    () => undefined
  );
  const mine = live?.line === line;
  const selected = mine ? live!.selected : null;
  // open rows survive the keys moving on to the next command
  const expanded = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.expanded(storeKey, line),
    () => NONE
  );
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
        .then(async (r) => {
          if (r.ok) return (await r.json()) as Detail;
          // the server's words, and whether the github session is gone
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw { failed: j?.error ?? `request failed (${r.status})`, auth: r.status === 401 };
        })
        .then((d) => chatStore.setDetail(storeKey, key, d))
        .catch((e: unknown) =>
          chatStore.setDetail(
            storeKey,
            key,
            typeof e === "object" && e && "failed" in e
              ? (e as DetailFailure)
              : { failed: "connection interrupted", auth: false }
          )
        );
    });
  }, [expanded, block.kind, owner, repo, storeKey]);

  // a row that just closed keeps its panel mounted for the exit
  // animation, then lets go; under reduced motion it goes at once
  const [closing, setClosing] = useState<Set<string>>(() => new Set());
  const prevOpenRef = useRef<string[]>(expanded);
  useEffect(() => {
    const gone = prevOpenRef.current.filter((id) => !expanded.includes(id));
    prevOpenRef.current = expanded;
    if (!gone.length) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setClosing((s) => new Set([...s, ...gone]));
  }, [expanded]);
  const settle = (id: string) =>
    setClosing((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });

  // keep the keyboard selection in view
  useEffect(() => {
    if (selected === null) return;
    rootRef.current?.querySelector(".row-sel")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // a press that travels picks the row up (the drag layer carries it to a
  // branch line or a plan); the click that follows a drop is not a toggle
  const pressRef = useRef<{ i: number; x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  useEffect(() => {
    const settle = () => setTimeout(() => (didDrag.current = false), 0);
    window.addEventListener("pointerup", settle);
    return () => window.removeEventListener("pointerup", settle);
  }, []);
  const onPointerDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    pressRef.current = { i, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pressRef.current;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
    pressRef.current = null;
    didDrag.current = true;
    startDrag(payload(block, p.i), e);
  };
  const onPointerUp = () => {
    pressRef.current = null;
  };
  const onClick = (i: number) => {
    if (didDrag.current) return;
    toggle(i);
  };

  const toggle = (i: number) => {
    const id = rowId(block, i);
    const open = expanded.includes(id) ? expanded.filter((e) => e !== id) : [...expanded, id];
    chatStore.setExpanded(storeKey, line, open);
    chatStore.setLive(storeKey, { line, selected: i });
  };
  const select = (i: number) => chatStore.setLive(storeKey, { line, selected: i });

  const numW = String(block.rows.length).length;
  const lanes = block.kind === "log" ? block.lanes : 0;
  const railW = railWidth(lanes);
  // every row is its own grid, so the right-hand columns are sized once
  // here from the longest value, or they would shift row by row. cells
  // carry 6px of padding each side (.log-cell); numbers 8px (.log-num)
  const widest = (xs: string[]) => Math.max(1, ...xs.map((s) => s.length));
  const col = (chars: number) => `calc(${chars}ch + 12px)`;
  const authorW = col(widest(block.rows.map((r) => r.author)));
  const ageW = col(
    widest(block.rows.map((r) => relTime(block.kind === "log" ? (r as CommitRow).date : (r as PrRow).updated, now)))
  );
  const cols =
    block.kind === "log"
      ? `2ch calc(${numW}ch + 8px) ${railW}px minmax(0, 1fr) ${authorW} ${ageW} ${col(7)}`
      : `2ch calc(${numW + 1}ch + 8px) minmax(0, 1fr) ${col(widest((block.rows as PrRow[]).map((r) => `${r.head} → ${r.base}`)) + 1)} ${authorW} ${ageW}`; // the arrow is wider than a cell
  const panelCols =
    block.kind === "log"
      ? `calc(${numW + 2}ch + ${railW + 8}px) minmax(0, 1fr)`
      : `calc(${numW + 3}ch + 8px) minmax(0, 1fr)`;

  return (
    <div ref={rootRef} className={`log-block ${fresh ? "block-in" : ""}`}>
      {block.rows.length ? (
      <div className="log-row log-head" style={{ gridTemplateColumns: cols }}>
        <span />
        <span className="log-num">#</span>
        {block.kind === "log" ? <span /> : null}
        <span className="log-cell">{block.kind === "log" ? "description" : "title"}</span>
        <span className="log-cell">{block.kind === "log" ? "author" : "branches"}</span>
        <span className="log-cell">{block.kind === "log" ? "age" : "author"}</span>
        <span className="log-cell">{block.kind === "log" ? "sha" : "age"}</span>
      </div>
      ) : null}
      {block.rows.map((row, i) => {
        const id = rowId(block, i);
        const isSel = selected === i;
        const isOpen = expanded.includes(id);
        const isClosing = !isOpen && closing.has(id);
        const detail =
          isOpen || isClosing
            ? details?.get(`${block.kind === "log" ? "commit" : "pr"}:${id}`)
            : undefined;
        return (
          <div key={id}>
            <div
              className={`log-row ${isSel ? "row-sel" : ""}`}
              style={{ gridTemplateColumns: cols }}
              onClick={() => onClick(i)}
              onMouseEnter={() => (mine && !dragging() ? select(i) : undefined)}
              onPointerDown={(e) => onPointerDown(e, i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              <span className="text-muted-foreground">{isSel ? "›" : ""}</span>
              {block.kind === "log" ? (
                <LogCells row={row as CommitRow} i={i} lanes={lanes} selected={isSel} />
              ) : (
                <PrCells row={row as PrRow} />
              )}
            </div>
            {isOpen || isClosing ? (
              <div
                className={isClosing ? "log-panel-out" : "log-panel-wrap"}
                onAnimationEnd={isClosing ? () => settle(id) : undefined}
              >
                <div>
                  <div className="log-panel" style={{ gridTemplateColumns: panelCols }}>
                    <div className="flex justify-end">
                      {block.kind === "log" && (row as CommitRow).graph && lanes ? (
                        <Through g={(row as CommitRow).graph!} lanes={lanes} />
                      ) : null}
                    </div>
                    <div className="log-panel-body">
                      {detail === undefined || detail === "loading" ? (
                        block.kind === "log" ? (
                          <CommitSkeleton row={row as CommitRow} />
                        ) : (
                          <PrSkeleton row={row as PrRow} />
                        )
                      ) : "failed" in detail ? (
                        <div className="detail-in">
                          <div>
                            <span className="text-wd-amber">error:</span>{" "}
                            {detail.auth ? "your github session ended" : detail.failed}
                          </div>
                          {detail.auth ? (
                            <SignInAgain storeKey={storeKey} line={line} id={id} />
                          ) : null}
                        </div>
                      ) : (
                        <div className="detail-in">
                          {detail.kind === "commit" ? (
                            <CommitPanel
                              d={detail}
                              block={block}
                              submit={submit}
                              jump={(sha) => jumpTo(block, sha, line, storeKey, submit)}
                            />
                          ) : detail.kind === "pr" ? (
                            <PrPanel d={detail} submit={submit} />
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
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
function jumpTo(block: ListBlock, sha: string, line: number, storeKey: string, submit: (c: string) => void) {
  if (block.kind !== "log") return;
  const i = block.rows.findIndex((r) => r.sha === sha);
  if (i < 0) {
    submit(sha);
    return;
  }
  const expanded = chatStore.expanded(storeKey, line);
  if (!expanded.includes(sha)) chatStore.setExpanded(storeKey, line, [...expanded, sha]);
  chatStore.setLive(storeKey, { line, selected: i });
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

// sign in again via github and come back to this row, reopened
function SignInAgain({ storeKey, line, id }: { storeKey: string; line: number; id: string }) {
  return (
    <div>
      <Action onClick={() => signInAgain(storeKey, { line, open: id })}>
        sign in again <span className="text-wd-green">→</span>
      </Action>
    </div>
  );
}

// one line per file: counts, then actions that appear on hover (always
// on touch): explain the change to this file, its history, copy the path
function Files({
  files,
  onView,
  onExplain,
  onHistory,
}: {
  files: CommitDetail["files"];
  onView: (path: string) => void;
  onExplain: (path: string) => void;
  onHistory: (path: string) => void;
}) {
  if (!files.length) return null;
  const w = Math.max(...files.map((f) => f.path.length));
  return (
    <div>
      {files.map((f) => (
        <div key={f.path} className="log-file">
          <span>{f.path}</span>
          <span className="text-muted-foreground">{" ".repeat(Math.max(w - f.path.length, 0) + 2)}</span>
          <span className="text-wd-green">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span>
          {f.status !== "modified" ? <span className="text-muted-foreground"> {f.status}</span> : null}
          <span className="log-file-actions">
            <span className="text-muted-foreground">   </span>
            {/* a removed file has nothing to view at this point in time */}
            {f.status !== "removed" ? (
              <>
                <Action onClick={() => onView(f.path)}>view</Action>
                <span className="text-muted-foreground"> · </span>
              </>
            ) : null}
            <Action onClick={() => onExplain(f.path)}>explain</Action>
            <span className="text-muted-foreground"> · </span>
            <Action onClick={() => onHistory(f.path)}>history</Action>
            <span className="text-muted-foreground"> · </span>
            <CopyAction text={f.path} />
          </span>
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
  block: ListBlock;
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
        {d.sha} <CopyAction text={d.sha} />
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
        <Files
          files={d.files}
          onView={(p) => submit(`view ${p} on ${d.sha.slice(0, 7)}`)}
          onExplain={(p) => submit(`explain ${d.sha.slice(0, 7)} in ${p}`)}
          onHistory={(p) => submit(`history ${p}`)}
        />
      </div>
      <div className="mt-2">
        <Action onClick={() => submit(`explain ${d.sha.slice(0, 7)}`)}>explain</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => submit(`changelog ${d.sha.slice(0, 7)}`)}>changelog</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => submit(`describe ${d.sha.slice(0, 7)}`)}>describe</Action>
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
        <Files
          files={d.files}
          onView={(p) => submit(`view ${p} on ${d.head}`)}
          onExplain={(p) => submit(`pr ${d.num} in ${p}`)}
          onHistory={(p) => submit(`history ${p}`)}
        />
      </div>
      <div className="mt-2">
        <Action onClick={() => submit(`pr ${d.num}`)}>explain</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => submit(`changelog pr ${d.num}`)}>changelog</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => submit(`describe pr ${d.num}`)}>describe</Action>
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
