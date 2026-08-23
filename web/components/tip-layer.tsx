"use client";

import { useEffect } from "react";

// one shared tooltip for every element carrying data-tip. fixed
// positioning so it works inside scroll containers (the tab bar);
// shows on hover after a beat, and on keyboard focus immediately.
export function TipLayer() {
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "tip";
    document.body.appendChild(tip);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const show = (el: Element) => {
      const label = el.getAttribute("data-tip");
      if (!label) return;
      const r = el.getBoundingClientRect();
      tip.textContent = label;
      // measure first, then clamp the box (not its center) to the viewport
      const w = tip.offsetWidth;
      const x = Math.min(
        Math.max(r.left + r.width / 2 - w / 2, 8),
        window.innerWidth - w - 8
      );
      tip.style.left = `${x}px`;
      tip.style.top = `${r.bottom + 6}px`;
      tip.classList.add("on");
    };
    const hide = () => {
      clearTimeout(timer);
      tip.classList.remove("on");
    };
    const overWith = (delay: number) => (e: Event) => {
      const el = (e.target as Element).closest?.("[data-tip]");
      hide();
      if (el) timer = setTimeout(() => show(el), delay);
    };
    const over = overWith(350);
    const focus = overWith(0);

    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("mousedown", hide);
    document.addEventListener("keydown", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("keydown", hide);
      window.removeEventListener("scroll", hide, true);
      tip.remove();
    };
  }, []);
  return null;
}
