import type { ReactNode } from "react";

export function Term({
  title,
  hint,
  bodyClassName = "",
  children,
}: {
  title: string;
  hint?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="term">
      <div className="term-bar">
        <div className="term-dots">
          <i />
          <i />
          <i />
        </div>
        <div className="term-title">{title}</div>
        <div className="term-hint">{hint}</div>
      </div>
      <div className={`term-body ${bodyClassName}`}>{children}</div>
    </div>
  );
}
