// cuts a unified diff (and its numstat) down to one path or directory,
// before preprocessing. sections split on `diff --git ` exactly like the
// shared spec, so this is a pure text operation.

export interface Filtered {
  diff: string;
  numstat: string;
  kept: number;
  total: number;
}

function under(file: string, path: string): boolean {
  const dir = path.replace(/\/+$/, "");
  return file === path || file === dir || file.startsWith(`${dir}/`);
}

export function filterDiff(diff: string, numstat: string, path: string): Filtered {
  const sections: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else if (sections.length) sections[sections.length - 1].push(line);
  }
  const keptSections = sections.filter((sec) => {
    const i = sec[0].lastIndexOf(" b/");
    return under(i >= 0 ? sec[0].slice(i + 3) : sec[0], path);
  });
  const rows = numstat.split("\n").filter(Boolean);
  const keptRows = rows.filter((r) => under(r.split("\t").slice(2).join("\t"), path));
  let out = keptSections.map((s) => s.join("\n")).join("\n");
  if (out && !out.endsWith("\n")) out += "\n";
  return { diff: out, numstat: keptRows.join("\n"), kept: keptSections.length, total: sections.length };
}
