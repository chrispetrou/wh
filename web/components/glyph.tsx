// the logo glyph: the clip-path square from site/index.html
export function Glyph() {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 shrink-0 bg-foreground"
      style={{
        clipPath: "polygon(0 0, 100% 0, 100% 100%, 35% 100%, 35% 35%, 0 35%)",
      }}
    />
  );
}
