// guard on docs/, which is a trust boundary. these pages are mdx, and mdx is
// jsx: raw html in a page becomes real dom on the live docs origin. the site
// generates its content-security-policy *from* its built output, so an inline
// script that reaches a page gets its own sha256 minted into that page's
// script-src. the site repo is private, so this script is the only feedback a
// contributor gets before review: say what is wrong and where, every time.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// resolved from this file, not the cwd, so it works from any directory
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'docs');
// paths are reported from the repo root, whatever directory this was run from
const at = (f) => relative(REPO, f);

// unsafe markup. kept in step with scripts/check-content.mjs in the site repo.
const RULES = [
  [/<\s*(script|iframe|object|embed|form|base|meta|link)\b/i, 'raw html element'],
  [/\son[a-z]+\s*=/i, 'inline event handler'],
  [/javascript\s*:/i, 'javascript: url'],
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
  [/data:text\/html/i, 'data: html url'],
];

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) yield* walk(join(p, name));
  } else if (/\.mdx?$/.test(p)) yield p;
}

if (!existsSync(ROOT)) {
  console.error('docs/ is missing');
  process.exit(1);
}

let bad = 0;
const problem = (file, line, msg) => {
  bad++;
  console.log(line ? `${at(file)}:${line}: ${msg}` : `${at(file)}: ${msg}`);
};

const files = [...walk(ROOT)];

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');

  // frontmatter: the site renders `description` as the intro under the h1, so
  // a missing one is a visibly broken page, not a lint nit.
  const fm = raw.startsWith('---\n') ? raw.slice(4).split('\n---')[0] : null;
  if (fm === null) {
    problem(file, 1, 'no frontmatter block (needs title and description)');
  } else {
    for (const key of ['title', 'description']) {
      const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
      if (!m) problem(file, 1, `frontmatter is missing \`${key}\``);
      else if (!m[1].trim()) problem(file, 1, `frontmatter \`${key}\` is empty`);
    }
  }

  let fenced = false;
  lines.forEach((line, i) => {
    // fenced code blocks render as text, not markup
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const [re, what] of RULES) {
      if (re.test(line)) {
        problem(file, i + 1, `${what}: ${line.trim().slice(0, 100)}`);
        break;
      }
    }
    // brand rule: commas, colons or parens instead
    if (/[\u2014\u2013]/.test(line)) problem(file, i + 1, `em or en dash: ${line.trim().slice(0, 100)}`);
  });
}

// sidebar: every meta.json entry must resolve, and every page must be reachable
// from one. an unlisted page still builds, it is just invisible in the nav,
// which is the failure people hit and cannot see without rendering the site.
const listed = new Set();
const metas = [];
(function findMetas(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) findMetas(full);
    else if (name === 'meta.json') metas.push(full);
  }
})(ROOT);

for (const meta of metas) {
  const dir = dirname(meta);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(meta, 'utf8'));
  } catch (e) {
    problem(meta, null, `invalid json: ${e.message}`);
    continue;
  }
  if (!Array.isArray(parsed.pages)) {
    problem(meta, null, 'no `pages` array');
    continue;
  }
  for (const entry of parsed.pages) {
    if (/^---.*---$/.test(entry)) continue; // section label
    const name = entry.startsWith('...') ? entry.slice(3) : entry;
    const asPage = join(dir, `${name}.mdx`);
    const asDir = join(dir, name);
    if (existsSync(asPage)) listed.add(asPage);
    else if (existsSync(asDir) && statSync(asDir).isDirectory()) {
      // `...folder` splices in that folder's own meta order
      if (!existsSync(join(asDir, 'meta.json')))
        problem(meta, null, `\`${entry}\` refers to ${name}/, which has no meta.json`);
    } else {
      problem(meta, null, `\`${entry}\` does not resolve to ${name}.mdx or ${name}/`);
    }
  }
}

for (const file of files) {
  if (!listed.has(file)) {
    const meta = join(dirname(file), 'meta.json');
    problem(
      file,
      null,
      `not listed in ${at(meta)}, so it will not appear in the sidebar`,
    );
  }
}

if (bad) {
  console.error(`\n${bad} problem(s) in docs/`);
  process.exit(1);
}
console.log(`docs check: ${files.length} pages, ${metas.length} meta.json, all listed and clean`);
