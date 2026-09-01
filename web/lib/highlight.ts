// syntax highlighting support for the file view: an extension map that
// decides whether highlight.js is loaded at all (unknown files stay
// plain and skip the import), and a per-line splitter that repairs the
// spans hljs opens across newlines. pure, no react, no static hljs
// import: the component passes the lazily imported module in.

const LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  rb: "ruby",
  php: "php",
  sql: "sql",
  kt: "kotlin",
  swift: "swift",
};

const BASENAMES: Record<string, string> = {
  makefile: "makefile",
  dockerfile: "dockerfile",
};

export function langFor(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const base = BASENAMES[name.toLowerCase()];
  if (base) return base;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGS[name.slice(dot + 1).toLowerCase()] ?? null;
}

// hljs highlights the whole text as one html string of nested spans over
// escaped text. splitting on newlines naively would break tokens that
// span lines (block comments, template strings), so open spans are
// closed at each newline and reopened on the next line
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let line = "";
  const re = /<span[^>]*>|<\/span>|\n/g;
  let last = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    line += html.slice(last, m.index);
    last = re.lastIndex;
    const tok = m[0];
    if (tok === "\n") {
      out.push(line + "</span>".repeat(stack.length));
      line = stack.join("");
    } else if (tok === "</span>") {
      stack.pop();
      line += tok;
    } else {
      stack.push(tok);
      line += tok;
    }
  }
  out.push(line + html.slice(last) + "</span>".repeat(stack.length));
  return out;
}

// the shape of the lazily imported hljs module, kept to what is used
interface Hljs {
  highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string };
}

export function highlightLines(code: string, lang: string, hljs: Hljs): string[] | null {
  try {
    return splitHighlighted(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
  } catch {
    return null; // the component falls back to plain text
  }
}
