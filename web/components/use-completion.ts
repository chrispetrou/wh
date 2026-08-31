// the completion menu's state: which menu the input opens (a slash
// command, its options, a branch, a log row, a pr), the keyboard
// selection in it, the lazily fetched branch list, and the keys that
// move through it. what a chosen row does is the terminal's business.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { chatStore } from "@/lib/chat-store";
import {
  branchSlot,
  COMMANDS,
  menuFor,
  prSlot,
  rowSlot,
  stageOf,
  type Menu,
} from "@/lib/terminal/menu";

export function useCompletion({
  storeKey,
  owner,
  repo,
  input,
  setInput,
}: {
  storeKey: string;
  owner: string;
  repo: string;
  input: string;
  setInput: (v: string) => void;
}) {
  // completion menu (fx-style dropdown for commands, options, branches)
  const [menuSel, setMenuSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const branchList = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.branchList(storeKey),
    () => undefined
  );
  const branchFetchRef = useRef(false);
  const logRows = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.logRows(storeKey),
    () => undefined
  );
  const prRows = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.prRows(storeKey),
    () => undefined
  );

  const slot = menuDismissed ? null : branchSlot(input);
  const slashMenu = menuDismissed ? null : menuFor(input);
  const branchRows =
    slot && branchList
      ? branchList
          .filter(
            (b) =>
              b.toLowerCase().startsWith(slot.partial.toLowerCase()) &&
              b !== slot.partial
          )
          .slice(0, 12)
      : [];
  const rslot = menuDismissed || !logRows?.length ? null : rowSlot(input);
  const rowRows = rslot
    ? logRows!
        .map((_, i) => String(i + 1))
        .filter((r) => r.startsWith(rslot.partial) && r !== rslot.partial)
        .slice(0, 12)
    : [];
  const pslot = menuDismissed || !prRows?.length ? null : prSlot(input);
  const prNums = pslot
    ? prRows!
        .map((p) => String(p.num))
        .filter((n) => n.startsWith(pslot.partial) && n !== pslot.partial)
        .slice(0, 12)
    : [];
  const menu: Menu | null =
    slashMenu ??
    (slot && branchRows.length
      ? { stage: "branch", rows: branchRows, prefix: slot.prefix }
      : rslot && rowRows.length
        ? { stage: "row", rows: rowRows, prefix: rslot.prefix }
        : pslot && prNums.length
          ? { stage: "pr", rows: prNums, prefix: pslot.prefix }
          : null);

  // branch names load lazily the first time a slot appears
  useEffect(() => {
    if (!slot || branchList || branchFetchRef.current) return;
    branchFetchRef.current = true;
    fetch(`/api/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json())
      .then((j: { branches?: string[]; tags?: string[] }) =>
        chatStore.setBranches(storeKey, [...(j.branches ?? []), ...(j.tags ?? [])])
      )
      .catch(() => chatStore.setBranches(storeKey, []));
  }, [slot, branchList, owner, repo, storeKey]);

  const changeInput = (v: string) => {
    setInput(v);
    setMenuDismissed(false);
    // value stages default to "what you typed" so custom refs are never
    // hijacked by a listed suggestion; arrows opt into the list
    const st = stageOf(v);
    setMenuSel(st === "cmd" || st === undefined ? 0 : -1);
  };

  // the keys that belong to the menu while it is open; true when one was
  // taken. enter with no selection in the arg stage is left to the
  // terminal, which submits the typed text
  const menuKey = (e: React.KeyboardEvent, apply: (m: Menu, row: string) => void): boolean => {
    if (!menu) return false;
    const minSel = menu.stage === "cmd" ? 0 : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMenuSel(Math.min(menuSel + 1, menu.rows.length - 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setMenuSel(Math.max(menuSel - 1, minSel));
      return true;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const row = menu.rows[Math.max(menuSel, 0)];
      if (menu.stage === "cmd") {
        const spec = COMMANDS.find((c) => c.name === row);
        changeInput(spec?.args ? `${row} ` : row);
      } else if (menu.stage === "branch" || menu.stage === "row" || menu.stage === "pr") {
        changeInput(`${menu.prefix ?? ""}${row}`);
      } else {
        changeInput(`${menu.spec?.name} ${row}`);
      }
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuDismissed(true);
      return true;
    }
    if (e.key === "Enter" && !(menu.stage !== "cmd" && menuSel < 0)) {
      e.preventDefault();
      apply(menu, menu.rows[Math.max(menuSel, 0)]);
      return true;
    }
    return false;
  };

  return {
    menu,
    menuSel,
    setMenuSel,
    dismiss: () => setMenuDismissed(true),
    changeInput,
    branchList,
    logRows,
    prRows,
    menuKey,
  };
}
