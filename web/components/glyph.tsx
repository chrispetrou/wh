// the model mark: a four-pointed star cut the same way as the logo, in
// the text's own color, set before the provider in the status line so
// "groq · openai/gpt-oss-120b" reads as the ai provider at a glance
export function ModelGlyph() {
  return (
    <span
      aria-hidden
      className="mr-1.5 inline-block size-3 shrink-0 bg-current align-[-2px]"
      style={{
        clipPath:
          "polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%)",
      }}
    />
  );
}

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
