"use client";

import { useSyncExternalStore } from "react";

// a shared clock for relative ages: one coarse interval for the whole
// page (ages are worded in minutes and up), running only while some
// block is subscribed. reading Date.now() in render is impure; this
// keeps the read in a store snapshot instead
let now = Date.now();
const subs = new Set<() => void>();
let iv: ReturnType<typeof setInterval> | undefined;

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!iv) {
    now = Date.now();
    iv = setInterval(() => {
      now = Date.now();
      subs.forEach((f) => f());
    }, 30_000);
  }
  return () => {
    subs.delete(cb);
    if (!subs.size && iv) {
      clearInterval(iv);
      iv = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    // blocks never carry rows in server html (the chat store is empty
    // there), so this value is never visible
    () => 0
  );
}
