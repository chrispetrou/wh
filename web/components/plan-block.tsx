"use client";

// a rebase or cherry-pick plan inside the transcript: rows to reorder
// (drag them, or shift+arrows) and mark (p r s f d e, or the panel's
// actions), a panel per row with the message to edit or draft, and the
// commands to paste below. the rows are edited in place through
// chatStore.setBlock; nothing here runs git or writes to github.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PlanAction, PlanRow } from "@/lib/block";
import { chatStore } from "@/lib/chat-store";
import {
  draftShas,
  foldTarget,
  isEdited,
  isFold,
  messageOf,
  move,
  paste,
  PICK_ACTIONS,
  REBASE_ACTIONS,
  reorderClashes,
  reset,
  setAction,
  setText,
  targetName,
  verdict,
  warnings,
  type PlanBlock as Plan,
} from "@/lib/plan";
import { relTime } from "@/lib/utils";
import { absolute, Action, Chip, CopyAction } from "./block-bits";

const NONE: string[] = [];
const DRAG_THRESHOLD = 4;

interface Drag {
  from: number;
  to: number;
  dy: number;
  h: number; // the dragged row's height, what the siblings step aside by
}

// what a row says at the far right: the target's overlap first, then a
// reorder past a sibling that touches the same file
function note(row: PlanRow, i: number, target: string, moved: Map<number, string>): string {
  if (row.action === "drop") return "";
  if (row.clash.length === 1) return `${row.clash[0]} also on ${target}`;
  if (row.clash.length) return `${row.clash.length} files also on ${target}`;
  return moved.get(i) ?? "";
}

export function PlanBlock({
  block,
  line,
  storeKey,
  submit,
  fresh = false,
}: {
  block: Plan;
  line: number;
  storeKey: string;
  submit: (command: string) => void;
  fresh?: boolean;
}) {
  const live = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.live(storeKey),
    () => undefined
  );
  const mine = live?.line === line;
  const selected = mine ? live!.selected : null;
  const expanded = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.expanded(storeKey, line),
    () => NONE
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const rows = block.rows;
  const update = (next: PlanRow[]) => chatStore.setBlock(storeKey, line, { ...block, rows: next });
  const select = (i: number) => chatStore.setLive(storeKey, { line, selected: i });
  const toggle = (i: number) => {
    const id = rows[i].sha;
    chatStore.setExpanded(
      storeKey,
      line,
      expanded.includes(id) ? expanded.filter((e) => e !== id) : [...expanded, id]
    );
    select(i);
  };
  const moveRow = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return;
    update(move(rows, from, to));
    select(to);
  };

  useEffect(() => {
    if (selected === null) return;
    rootRef.current?.querySelector(".row-sel")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // drag to reorder: a press that travels past the threshold picks the row
  // up; it rides the pointer, the rows it passes step aside, and the drop
  // slot is whichever row center is nearest. touch keeps scrolling: the
  // panel's move up and move down cover it
  const dragRef = useRef<(Drag & { y0: number; id: number; active: boolean }) | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const didDrag = useRef(false);
  const rowEls = () => [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, i: number) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const h = e.currentTarget.getBoundingClientRect().height;
    dragRef.current = { from: i, to: i, dy: 0, h, y0: e.clientY, id: e.pointerId, active: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      d.active = true;
      didDrag.current = true;
      e.currentTarget.setPointerCapture(d.id);
    }
    // the slot is the row whose center is nearest the pointer, measured
    // before any transform so open panels count
    let to = d.from;
    let best = Infinity;
    rowEls().forEach((el, j) => {
      const r = el.getBoundingClientRect();
      const center = r.top + r.height / 2 - (j === d.from ? d.dy : 0);
      const dist = Math.abs(e.clientY - center);
      if (dist < best) {
        best = dist;
        to = j;
      }
    });
    d.to = to;
    d.dy = dy;
    setDrag({ from: d.from, to, dy, h: d.h });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d?.active) return;
    setDrag(null);
    moveRow(d.from, d.to);
  };
  const onClick = (i: number) => {
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    toggle(i);
  };
  const rowStyle = (i: number): React.CSSProperties | undefined => {
    if (!drag) return undefined;
    if (i === drag.from) return { transform: `translateY(${drag.dy}px)` };
    if (drag.from < i && i <= drag.to) return { transform: `translateY(${-drag.h}px)` };
    if (drag.to <= i && i < drag.from) return { transform: `translateY(${drag.h}px)` };
    return undefined;
  };
  const rowClass = (i: number): string => {
    if (!drag) return "";
    if (i === drag.from) return "row-drag";
    return "row-shift";
  };

  const target = targetName(block);
  const moved = reorderClashes(rows);
  const notes = rows.map((r, i) => note(r, i, target, moved));
  const actions = block.mode === "pick" ? PICK_ACTIONS : REBASE_ACTIONS;

  const numW = String(rows.length).length;
  const now = Date.now();
  const widest = (xs: string[]) => Math.max(1, ...xs.map((s) => s.length));
  const col = (chars: number) => `calc(${chars}ch + 12px)`;
  const authorW = col(widest(rows.map((r) => r.author)));
  const ageW = col(widest(rows.map((r) => relTime(r.date, now))));
  const noteW = notes.some(Boolean) ? col(Math.min(widest(notes), 36)) : "0px";
  // wide: every column; narrow (see .plan-row in globals.css): author,
  // age, and the note step out, so the description keeps its room
  const cols = {
    "--plan-cols": `2ch calc(${numW}ch + 8px) ${col(6)} minmax(0, 1fr) ${authorW} ${ageW} ${col(7)} ${noteW}`,
    "--plan-cols-narrow": `2ch calc(${numW}ch + 8px) ${col(6)} minmax(0, 1fr) ${col(7)}`,
  } as React.CSSProperties;
  const panelCols = `calc(${numW + 2}ch + 8px) minmax(0, 1fr)`;

  const lines = paste(block);
  const warn = warnings(block);
  const v = verdict(block);
  const hint =
    block.mode === "pick"
      ? "↑↓ select · enter open · p d action · shift+↑↓ move · esc back"
      : "↑↓ select · enter open · p r s f d e action · shift+↑↓ move · esc back";

  return (
    <div ref={rootRef} className={`log-block ${fresh ? "block-in" : ""}`} data-drop={`plan:${line}`}>
      {rows.length ? (
        <div className="log-row log-head plan-row" style={cols}>
          <span />
          <span className="log-num">#</span>
          <span className="plan-action">action</span>
          <span className="log-cell">description</span>
          <span className="log-cell log-author">author</span>
          <span className="log-cell log-age">age</span>
          <span className="log-cell">sha</span>
          <span className="log-cell plan-note">{notes.some(Boolean) ? "note" : ""}</span>
        </div>
      ) : null}
      {rows.map((row, i) => {
        const isSel = selected === i;
        const isOpen = expanded.includes(row.sha);
        const fold = isFold(row.action);
        const dropped = row.action === "drop";
        return (
          <div key={row.sha}>
            <div
              data-row
              className={`log-row plan-row ${isSel ? "row-sel" : ""} ${rowClass(i)}`}
              style={{ ...cols, ...rowStyle(i) }}
              onClick={() => onClick(i)}
              onMouseEnter={() => (mine && !drag ? select(i) : undefined)}
              onPointerDown={(e) => onPointerDown(e, i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <span className="text-muted-foreground">{isSel ? "›" : ""}</span>
              <span className="log-num">{i + 1}</span>
              <span className={`plan-action ${fold ? "plan-fold" : dropped ? "plan-drop" : ""}`}>
                {fold ? `↳ ${row.action}` : row.action}
              </span>
              <span className={`log-cell ${dropped ? "text-muted-foreground" : ""}`}>
                {row.refs.map((r) => (
                  <Chip
                    key={r.name}
                    name={r.name}
                    color={r.kind === "default" ? "var(--wd-accent)" : "var(--muted-foreground)"}
                  />
                ))}
                {row.text ? row.text.split("\n")[0] : row.subject}
              </span>
              <span className="log-cell log-author text-muted-foreground">{row.author}</span>
              <span className="log-cell log-age text-muted-foreground" data-tip={absolute(row.date)}>
                {relTime(row.date, now)}
              </span>
              <span className="log-cell text-muted-foreground">{row.sha.slice(0, 7)}</span>
              <span
                className="log-cell plan-note text-wd-amber"
                data-tip={
                  row.clash.length > 1 ? row.clash.join(", ") : notes[i].length > 36 ? notes[i] : undefined
                }
              >
                {notes[i]}
              </span>
            </div>
            {isOpen ? (
              <div className="log-panel-wrap">
                <div>
                  <div className="log-panel" style={{ gridTemplateColumns: panelCols }}>
                    <div />
                    <div className="log-panel-body">
                      <Panel
                        block={block}
                        rows={rows}
                        i={i}
                        actions={actions}
                        target={target}
                        update={update}
                        moveRow={moveRow}
                        submit={submit}
                        storeKey={storeKey}
                        line={line}
                      />
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
      {rows.length ? (
        <div className={v.warn ? "text-wd-amber" : "text-muted-foreground"}>{v.text}</div>
      ) : null}
      {warn.map((w, i) => (
        <div key={i} className="text-wd-amber">
          {w}
        </div>
      ))}
      {lines.length ? <pre className="plan-pre">{lines.join("\n")}</pre> : null}
      <div>
        <CopyAction text={lines.join("\n") + "\n"} />
        {isEdited(rows) ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <Action onClick={() => update(reset(rows))}>reset</Action>
          </>
        ) : null}
      </div>
      {mine ? <div className="text-wd-faint">{hint}</div> : null}
    </div>
  );
}

// an opened row: the commit, its files with the target's overlap marked,
// the message to edit (or draft with the model), and the actions
function Panel({
  block,
  rows,
  i,
  actions,
  target,
  update,
  moveRow,
  submit,
  storeKey,
  line,
}: {
  block: Plan;
  rows: PlanRow[];
  i: number;
  actions: PlanAction[];
  target: string;
  update: (rows: PlanRow[]) => void;
  moveRow: (from: number, to: number) => void;
  submit: (c: string) => void;
  storeKey: string;
  line: number;
}) {
  const row = rows[i];
  const fold = isFold(row.action);
  const into = fold ? foldTarget(rows, i) : null;
  const sha7 = row.sha.slice(0, 7);
  const w = row.files.length ? Math.max(...row.files.map((f) => f.length)) : 0;
  const draft = () => {
    chatStore.setDraft(storeKey, { line, base: block.base.sha, sha: row.sha });
    submit(`message ${draftShas(rows, i).map((s) => s.slice(0, 7)).join(" ")}`);
  };
  return (
    <div>
      <div>
        <span className="text-muted-foreground">sha      </span>
        {row.sha} <CopyAction text={row.sha} />
      </div>
      <div>
        <span className="text-muted-foreground">author   </span>
        {row.author}
        <span className="text-muted-foreground">
          {" "}
          · {absolute(row.date)} ({relTime(row.date)})
        </span>
      </div>
      {row.files.length ? (
        <div className="mt-2">
          {row.files.map((f) => (
            <div key={f} className="log-file">
              <span>{f}</span>
              {row.clash.includes(f) ? (
                <span className="text-wd-amber">
                  {" ".repeat(Math.max(w - f.length, 0) + 2)}also changed on {target}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-2">
        {fold ? (
          <>
            <div className="text-muted-foreground">
              {into === null
                ? `nothing older to ${row.action} into; will be picked as is`
                : `${row.action === "fixup" ? "folds" : "squashes"} into row ${into + 1}${
                    row.action === "fixup" ? ", its message dropped" : ", the messages joined"
                  } (draft the result there)`}
            </div>
            <div className="text-muted-foreground">{messageOf(row)}</div>
          </>
        ) : block.mode === "pick" ? (
          <div className={row.action === "drop" ? "text-muted-foreground" : ""}>{messageOf(row)}</div>
        ) : (
          <textarea
            className="field-input plan-text"
            aria-label="commit message"
            value={row.text ?? row.message}
            spellCheck={false}
            onChange={(e) => update(setText(rows, i, e.target.value))}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
      </div>
      <div className="mt-2">
        {actions.map((a, j) => (
          <span key={a}>
            {j ? <span className="text-muted-foreground"> · </span> : null}
            {a === row.action ? (
              <span>{a}</span>
            ) : (
              <Action onClick={() => update(setAction(rows, i, a))}>{a}</Action>
            )}
          </span>
        ))}
      </div>
      <div className="mt-2">
        {block.mode === "rebase" && !fold && row.action !== "drop" ? (
          <>
            <Action onClick={draft}>draft message</Action>
            <span className="text-muted-foreground"> · </span>
          </>
        ) : null}
        <Action onClick={() => submit(`explain ${sha7}`)}>explain</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => moveRow(i, i - 1)}>move up</Action>
        <span className="text-muted-foreground"> · </span>
        <Action onClick={() => moveRow(i, i + 1)}>move down</Action>
      </div>
    </div>
  );
}
