"use client";

import { useEffect } from "react";

// keeps --vvh equal to the visual viewport height so app surfaces can
// fill the screen and stay above software keyboards
export function ViewportVar() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
  return null;
}
