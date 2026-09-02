"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

// true after hydration, false on the server and during the hydration
// pass. the snapshot pair does the flip, so no setState-in-effect
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
