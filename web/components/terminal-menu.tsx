"use client";

// the completion dropdown under the prompt (fx-style): commands with
// their descriptions, a command's options with notes, branch names, log
// row numbers with their subjects, pr numbers with their titles. the
// keyboard selection is the terminal's; this only draws it.

import { useEffect, useRef } from "react";
import type { LogRow, PrPick } from "@/lib/chat-store";
import { argNotes, COMMANDS, type Menu } from "@/lib/terminal/menu";

export function CompletionMenu({
  menu,
  sel,
  onSel,
  onPick,
  branchList,
  logRows,
  prRows,
}: {
  menu: Menu;
  sel: number;
  onSel: (i: number) => void;
  onPick: (row: string) => void;
  branchList: string[] | undefined;
  logRows: LogRow[] | undefined;
  prRows: PrPick[] | undefined;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // one name column per menu, wide enough for its longest row
  const menuCol = Math.max(...menu.rows.map((r) => r.length));

  // keep the keyboard selection visible inside the scrolling menu
  useEffect(() => {
    menuRef.current
      ?.querySelector(".row-sel")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <div className="mt-2 border-t border-border pt-1.5">
      <div ref={menuRef} className="max-h-56 overflow-y-auto">
        {menu.rows.map((row, i) => {
          const spec =
            menu.stage === "cmd"
              ? COMMANDS.find((c) => c.name === row)
              : undefined;
          const selected = i === sel;
          return (
            <button
              key={row}
              type="button"
              onClick={() => onPick(row)}
              onMouseEnter={() => onSel(i)}
              className={`flex w-full cursor-pointer items-baseline gap-2 rounded-[3px] px-1.5 py-0.5 text-left ${
                selected ? "row-sel" : ""
              }`}
            >
              {/* the landing picker's marker, and one column width for
                  the whole menu so descriptions line up */}
              <span className="shrink-0 text-muted-foreground">{selected ? "›" : " "}</span>
              <span
                className={`shrink-0 ${selected ? "font-semibold" : "text-wd-accent"}`}
                style={{ minWidth: `${menuCol}ch` }}
              >
                {row}
              </span>
              {spec ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {spec.desc}
                </span>
              ) : menu.stage === "arg" && argNotes(menu.spec, row).length ? (
                <span className="text-muted-foreground">
                  {argNotes(menu.spec, row).map((n, j) => (
                    <span key={n.text}>
                      {j ? " · " : ""}
                      <span className={n.cls}>{n.text}</span>
                    </span>
                  ))}
                </span>
              ) : menu.stage === "branch" && row === branchList?.[0] ? (
                <span className="text-muted-foreground">default branch</span>
              ) : menu.stage === "row" ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {logRows?.[Number(row) - 1]?.subject}
                </span>
              ) : menu.stage === "pr" ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {prRows?.find((p) => String(p.num) === row)?.title}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="pt-1 text-wd-faint">
        ↑↓ navigate · tab complete · enter use · esc close
      </div>
    </div>
  );
}
