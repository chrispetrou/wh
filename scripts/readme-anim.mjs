// readme animations for wh: ten terminal clips as self-contained animated
// svgs (css keyframes, no js, no gif), dark and light.
//
//   node scripts/readme-anim.mjs            writes readme/*.svg
//
// strings, colors, and glyphs come from cli/src/output.rs,
// cli/src/commands/*.rs, web/app/globals.css and CLAUDE.md.

const CW = 7.8, LH = 22, FS = 13, PADT = 15;

export const THEMES = {
  dark: { term: '#111111', page: '#0d0d0d', fg: '#e8e8e8', mut: '#7a7a7a', faint: '#3a3a3a', line: '#222222', green: '#69db7c', amber: '#e0b420', accent: '#91a7ff', sel: '#1c2333', lanes: ['#91a7ff', '#f06595'] },
  light: { term: '#fcfcfc', page: '#ffffff', fg: '#1a1a1a', mut: '#8a8a8a', faint: '#c8c8c8', line: '#e6e6e6', green: '#2f9e44', amber: '#b08900', accent: '#4263eb', sel: '#eef2ff', lanes: ['#4263eb', '#c2255c'] }
};

const FONT = "ui-monospace,SFMono-Regular,'SF Mono','Cascadia Mono','JetBrains Mono',Menlo,Consolas,monospace";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Anim {
  constructor(o = {}) {
    this.width = o.width || 720;
    this.padx = o.padx == null ? 16 : o.padx;
    this.top = o.top || 0;
    this.hold = o.hold || 1.8;
    this.t = 0; this.row = 0; this.els = []; this.statics = []; this.rails = [];
    this.prompt = o.prompt || '~/repo $';
  }
  xc(c) { return +(this.padx + c * CW).toFixed(2); }
  ytop(r) { return this.top + PADT + r * LH; }
  text(col, txt, cls, t, row) {
    this.els.push({ k: 't', x: this.xc(col), y: this.ytop(row == null ? this.row : row) + 15, cls: cls || '', s: txt, t });
    return this;
  }
  rect(o) { this.els.push({ k: 'r', ...o }); return this; }
  blank(n = 1) { this.row += n; return this; }
  wait(s) { this.t += s; return this; }
  out(segs, gap = 0.14) {
    for (const [c, s, cls] of segs) this.text(c, s, cls, this.t);
    this.row++; this.t += gap; return this;
  }
  cmd(txt, o = {}) {
    const p = o.prompt == null ? this.prompt : o.prompt;
    const pcls = o.promptCls == null ? 'o' : o.promptCls;
    const cps = o.cps || 0.07;
    const t0 = this.t, r = this.row;
    if (p) this.text(0, p, pcls, t0);
    const col = p ? p.length + 1 : 0, chars = [...txt];
    chars.forEach((ch, i) => { if (ch !== ' ') this.text(col + i, ch, o.cls == null ? 'c' : o.cls, t0 + i * cps, r); });
    const tEnd = t0 + chars.length * cps;
    this.els.push({ k: 'cur', x: this.xc(col), y: this.ytop(r) + 3, n: chars.length, t0, t1: tEnd, hide: tEnd + 0.35 });
    this.row++; this.t = tEnd + (o.after == null ? 0.55 : o.after);
    return this;
  }
  stream(lines, cls, o = {}) {
    const wps = o.wps || 0.085;
    for (const line of lines) {
      let col = o.col || 0;
      for (const w of line.split(' ')) { if (w) this.text(col, w, cls || '', this.t); col += w.length + 1; this.t += wps; }
      this.row++; this.t += 0.05;
    }
    this.t += 0.1; return this;
  }
  render(theme, label) {
    const T = +(this.t + this.hold).toFixed(2);
    const h = Math.round(this.ytop(this.row) + PADT);
    const c = THEMES[theme];
    const kf = [], rules = [], seen = new Set();
    const rv = (t) => {
      const p1 = Math.max(0, +(t / T * 100).toFixed(3));
      const p2 = +(Math.min(t + 0.16, T) / T * 100).toFixed(3);
      const key = 'r' + String(p1).replace('.', '_') + 'x' + String(p2).replace('.', '_');
      if (!seen.has(key)) {
        seen.add(key);
        kf.push(`@keyframes ${key}{0%,${p1}%{opacity:0}${p2}%,100%{opacity:1}}`);
        rules.push(`.${key}{opacity:0;animation:${key} ${T}s linear infinite}`);
      }
      return key;
    };
    const paint = (v) => v === 'LINE' ? c.line : v === 'FG' ? c.fg : v === 'ACCENT' ? c.accent : v === 'MUT' ? c.mut : v;
    const body = [];
    this.els.forEach((e, i) => {
      if (e.k === 't') {
        const k = rv(e.t), pre = /^\s|\s\s/.test(e.s) ? 'xml:space="preserve" ' : '';
        body.push(`<text ${pre}class="rv ${e.cls} ${k}" x="${e.x}" y="${e.y}">${esc(e.s)}</text>`);
      } else if (e.k === 'r') {
        const k = rv(e.t || 0);
        body.push(`<rect fill="${paint(e.fill)}"${e.stroke ? ` stroke="${paint(e.stroke)}"` : ''} class="rv ${k}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}"${e.rx ? ` rx="${e.rx}"` : ''}/>`);
      } else if (e.k === 'cur') {
        const n = 'k' + i;
        const p0 = +(e.t0 / T * 100).toFixed(3), p1 = +(e.t1 / T * 100).toFixed(3);
        const pv = Math.max(0, +(p0 - 0.2).toFixed(3));
        const ph = Math.min(+(e.hide / T * 100).toFixed(3), 99.3);
        kf.push(`@keyframes ${n}{${p0}%{transform:translateX(0)}${p1}%,100%{transform:translateX(${(e.n * CW).toFixed(2)}px)}}`);
        kf.push(`@keyframes ${n}v{0%,${pv}%{opacity:0}${p0}%,${ph}%{opacity:1}${(ph + 0.3).toFixed(3)}%,100%{opacity:0}}`);
        rules.push(`.${n}{animation:${n} ${T}s steps(${e.n}) infinite,blink 1s steps(1) infinite}`);
        rules.push(`.${n}v{opacity:0;animation:${n}v ${T}s linear infinite}`);
        body.push(`<g class="cv ${n}v"><rect fill="${c.fg}" class="${n}" x="${e.x}" y="${e.y}" width="7" height="15"/></g>`);
      }
    });
    const css = [
      `text{fill:${c.fg};white-space:pre}`,
      `.o{fill:${c.mut}}.g{fill:${c.green}}.a{fill:${c.amber}}.x{fill:${c.accent}}.f{fill:${c.faint}}`,
      `.c{font-weight:600}.b{font-weight:600}.inv{fill:${c.term}}.sm{font-size:12px}`,
      '@keyframes blink{50%{opacity:0}}',
      rules.join('\n'),
      kf.join('\n'),
      '@media (prefers-reduced-motion:reduce){*{animation:none!important}.rv{opacity:1!important}.cv{opacity:0!important}}'
    ].join('\n');
    const statics = this.statics.map((f) => typeof f === 'function' ? f(c, h) : f).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${h}" viewBox="0 0 ${this.width} ${h}" font-family="${FONT}" font-size="${FS}" role="img" aria-label="${esc(label)}">
<style>
${css}
</style>
<rect width="${this.width}" height="${h}" fill="${c.term}"/>
<rect x="0.5" y="0.5" width="${this.width - 1}" height="${h - 1}" fill="none" stroke="${c.line}" rx="4"/>
${statics}
${body.join('\n')}
</svg>`;
  }
}

// the web frames sit in browser chrome plus the app shell (app-shell.tsx,
// tab-bar.tsx, glyph.tsx)
function webChrome(A) {
  const BAR = 30, HEAD = 44, TABS = 27;
  A.top = BAR + HEAD + TABS; A.padx = 24;
  A.statics.push((c) => `<rect x="0.5" y="0.5" width="${A.width - 1}" height="${BAR}" fill="${c.page}" stroke="${c.line}" rx="4"/>
<rect x="0.5" y="${BAR}" width="${A.width - 1}" height="1" fill="${c.line}"/>
<circle cx="20" cy="15" r="4" fill="none" stroke="${c.faint}"/><circle cx="34" cy="15" r="4" fill="none" stroke="${c.faint}"/><circle cx="48" cy="15" r="4" fill="none" stroke="${c.faint}"/>
<rect x="70" y="7" width="${A.width - 140}" height="16" fill="${c.term}" stroke="${c.line}" rx="3"/>
<text class="o sm" x="80" y="19">localhost:3000/repos/demo/wh</text>
<path d="M 24 ${BAR + 15} h 14 v 14 h -9.1 v -9.1 h -4.9 z" fill="${c.fg}"/>
<text class="b" x="46" y="${BAR + 27}">wh</text><text class="f" x="70" y="${BAR + 27}">/</text><text class="o" x="82" y="${BAR + 27}">demo/wh</text>
<text class="o sm" x="${A.width - 100}" y="${BAR + 27}">demo</text><text class="o sm" x="${A.width - 52}" y="${BAR + 27}">logout</text>
<rect x="0.5" y="${BAR + HEAD}" width="${A.width - 1}" height="1" fill="${c.line}"/>
<rect x="16" y="${BAR + HEAD + 4}" width="34" height="19" fill="${c.sel}" rx="3"/>
<text class="b sm" x="23" y="${BAR + HEAD + 18}">wh</text><text class="f sm" x="60" y="${BAR + HEAD + 18}">+</text>
<rect x="0.5" y="${BAR + HEAD + TABS}" width="${A.width - 1}" height="1" fill="${c.line}"/>`);
  return A;
}

export const SPECS = {
  // wh new: created worktree / copied / green arrow (commands/new.rs)
  new: () => {
    const A = new Anim();
    A.cmd('wh new feat/auth');
    A.out([[0, 'created worktree ../repo.feat-auth', '']], 0.35);
    A.out([[0, 'copied .env .env.local', '']], 0.35);
    A.out([[0, '→', 'g'], [2, 'ready feat/auth checked out', '']]);
    return A;
  },
  // wh ls: column widths from ls.rs render() (name+2, status+2)
  ls: () => {
    const A = new Anim();
    A.cmd('wh ls');
    const rows = [['main', 'clean', ''], ['feat/auth', 'clean', ''], ['fix/nav-323', '2 dirty', 'ahead 3'], ['spike/wasm', 'clean', 'behind 12']];
    for (const [n, s, e] of rows) {
      const segs = [[0, n, ''], [13, s, '']];
      if (e) segs.push([22, '·  ' + e, 'o']);
      A.out(segs, 0.3);
    }
    return A;
  },
  // wh switch: the /dev/tty picker (switch.rs draw()): muted question,
  // inverse-video selected row, then the green line on stderr
  switch: () => {
    const A = new Anim();
    A.cmd('wh switch');
    A.out([[0, '? select worktree', 'o']], 0.35);
    const q = A.row - 1, t0 = A.t;
    [...'au'].forEach((ch, i) => A.text(18 + i, ch, '', t0 + i * 0.18, q));
    A.els.push({ k: 'cur', x: A.xc(18), y: A.ytop(q) + 3, n: 2, t0, t1: t0 + 0.36, hide: t0 + 1.1 });
    A.t = t0 + 1;
    A.text(20, '▏', 'o', A.t, q);
    A.rect({ x: A.xc(0) - 2, y: A.ytop(A.row) + 2, w: +(22 * CW).toFixed(1), h: 19, fill: 'FG', t: A.t });
    A.text(0, '› feat/auth', 'inv', A.t);
    A.text(15, 'clean', 'inv', A.t);
    A.row++; A.t += 0.6;
    A.out([[0, '→', 'g'], [2, 'switched ../repo.feat-auth', '']]);
    return A;
  },
  // wh rm: skipped (muted), would remove, the [y/N] prompt, then pruned
  rm: () => {
    const A = new Anim();
    A.cmd('wh rm');
    A.out([[0, 'skipped ../repo.fix-nav-323 (fix/nav-323): 2 dirty', 'o']], 0.35);
    A.out([[0, 'would remove ../repo.feat-auth (feat/auth)', '']], 0.5);
    A.cmd('y', { prompt: 'remove 1 worktree? [y/N]', promptCls: '', cls: '', after: 0.5 });
    A.out([[0, 'removed ../repo.feat-auth (feat/auth)', '']], 0.35);
    A.out([[0, '→', 'g'], [2, 'pruned 1 worktree', '']]);
    return A;
  },
  // wh explain: status line, amber labels, the answer streamed word by
  // word, closing elapsed/model/tokens (commands/explain.rs)
  explain: () => {
    const A = new Anim();
    A.cmd('wh explain HEAD~3..');
    A.out([[0, 'reading 3 commits · 14 files · +212 −87', 'o']], 0.5);
    A.out([[0, 'summary', 'a']], 0.2);
    A.stream(['Moves session handling from cookies to signed jwts, so a', 'restart no longer signs everyone out. Login and refresh', 'issue tokens; the cookie path is gone.']);
    A.out([[0, 'watch out', 'a']], 0.2);
    A.stream(['logout() no longer clears server state, so a stolen token', 'stays valid until it expires.']);
    A.out([[0, '· 8.4s · claude-opus-5 · 1.2k in · 340 out', 'o']]);
    return A;
  },
  changelog: () => {
    const A = new Anim();
    A.cmd('wh explain --changelog v1.1..v1.2');
    A.out([[0, 'reading 24 commits · 61 files · +1840 −520', 'o']], 0.5);
    A.out([[0, 'added', 'a']], 0.2);
    A.stream(['Signed jwt sessions, kept across a restart.', 'wh rm --force removes squash-merged branches.']);
    A.out([[0, 'changed', 'a']], 0.2);
    A.stream(['explain streams its answer line by line.']);
    A.out([[0, 'fixed', 'a']], 0.2);
    A.stream(['switch keeps the query when you backspace.']);
    A.out([[0, '· 6.1s · claude-opus-5 · 3.4k in · 210 out', 'o']]);
    return A;
  },
  describe: () => {
    const A = new Anim();
    A.cmd('wh explain --describe');
    A.out([[0, 'reading 6 commits · 19 files · +324 −96', 'o']], 0.5);
    A.out([[0, 'title', 'a']], 0.2);
    A.stream(['sessions: move from cookies to signed jwts']);
    A.out([[0, 'description', 'a']], 0.2);
    A.stream(['Sessions survive a restart: login and refresh now issue', 'signed tokens, and the cookie path is gone. Old cookies', 'are ignored, so everyone signs in once after deploy.']);
    A.out([[0, 'testing', 'a']], 0.2);
    A.stream(['cargo test, then sign in and restart the server.']);
    A.out([[0, '· 7.2s · gpt-5-mini · 2.1k in · 380 out', 'o']]);
    return A;
  },
  // wh init zsh: POSIX_WRAPPER verbatim from commands/init.rs
  init: () => {
    const A = new Anim();
    A.cmd('wh init zsh');
    const wrapper = [
      ['# wh shell integration: add to your rc file', 'o'],
      ['#   eval "$(wh init zsh)"', 'o'],
      ['wh() {', ''],
      ['  if [ "$1" = "switch" ]; then', ''],
      ['    local _wh_dir', ''],
      ['    _wh_dir="$(command wh "$@")" && cd "$_wh_dir"', ''],
      ['  else', ''],
      ['    command wh "$@"', ''],
      ['  fi', ''],
      ['}', '']
    ];
    for (const [s, cls] of wrapper) A.out([[0, s, cls]], 0.13);
    A.blank(); A.wait(0.5);
    A.cmd('eval "$(wh init zsh)"', { cps: 0.045 });
    A.cmd('wh switch auth', { cps: 0.055 });
    A.out([[0, '→', 'g'], [2, 'switched ../repo.feat-auth', '']]);
    return A;
  },
  // web: log draws the graph in the transcript, then explain 3
  // (terminal-chat.tsx, log-block.tsx)
  'web-log': () => {
    const A = webChrome(new Anim({ prompt: 'demo/wh $' }));
    A.out([[0, '▜ wh · demo/wh', 'o']], 0.4);
    A.cmd('log');
    const NUMX = 2, RAILX = 6, DESCX = 10, AUTHX = 62, AGEX = 70, SHAX = 77;
    const headRow = A.row, tHead = A.t;
    A.out([[NUMX, '#', 'o'], [DESCX, 'description', 'o'], [AUTHX, 'author', 'o'], [AGEX, 'age', 'o'], [SHAX, 'sha', 'o']], 0.14);
    A.rect({ x: A.xc(0), y: A.ytop(headRow) + LH - 2, w: A.width - A.padx * 2, h: 1, fill: 'LINE', t: tHead });
    const rows = [
      { n: 1, chip: ['main', 'x'], s: 'switch: keep the query on backspace', a: 'demo', age: '2h', sha: '4f1c8ab', rail: 'v1' },
      { n: 2, chip: null, s: 'merge feat/auth', a: 'demo', age: '6h', sha: 'b7d0e42', rail: 'merge', merge: true, mut: true },
      { n: 3, chip: null, s: 'explain: stream the answer line by line', a: 'demo', age: '8h', sha: '9c1f2ab', rail: 'v' },
      { n: 4, chip: null, s: 'rm: --force for squash-merged branches', a: 'alice', age: '1d', sha: '2e5a9c7', rail: 'v' },
      { n: 5, chip: ['v1.2', 'o'], s: 'sessions: signed jwts, no cookie path', a: 'demo', age: '2d', sha: 'c04b81f', rail: 'end' }
    ];
    const lx = (l) => 7 + l * 14; // PAD, LANE_W from log-block.tsx
    for (const r of rows) {
      const top = A.ytop(A.row), rx = A.xc(RAILX), t = A.t;
      let d;
      if (r.rail === 'v1') d = `M ${rx + lx(0)} ${top} L ${rx + lx(0)} ${top + LH} M ${rx + lx(1)} ${top} L ${rx + lx(1)} ${top + LH}`;
      else if (r.rail === 'merge') d = `M ${rx + lx(0)} ${top} L ${rx + lx(0)} ${top + LH} M ${rx + lx(1)} ${top} C ${rx + lx(1)} ${top + 11} ${rx + lx(0)} ${top + 11} ${rx + lx(0)} ${top + 11}`;
      else if (r.rail === 'end') d = `M ${rx + lx(0)} ${top} L ${rx + lx(0)} ${top + 11}`;
      else d = `M ${rx + lx(0)} ${top} L ${rx + lx(0)} ${top + LH}`;
      A.rails.push({ d, merge: !!r.merge, cx: rx + lx(0), cy: top + 11 });
      let col = DESCX;
      const segs = [[NUMX, String(r.n), 'o']];
      if (r.chip) {
        segs.push([col + 0.4, r.chip[0], r.chip[1]]);
        A.rect({ x: A.xc(DESCX), y: top + 3, w: +((r.chip[0].length + 0.8) * CW).toFixed(1), h: 16, rx: 3, fill: 'none', stroke: r.chip[1] === 'x' ? 'ACCENT' : 'MUT', t });
        col += r.chip[0].length + 2;
      }
      segs.push([col, r.s, r.mut ? 'o' : ''], [AUTHX, r.a, 'o'], [AGEX, r.age, 'o'], [SHAX, r.sha, 'o']);
      A.out(segs, 0.14);
    }
    A.statics.push((c) => A.rails.map((p) => `<path d="${p.d}" fill="none" stroke="${c.lanes[0]}" stroke-width="1.5"/>` +
      (p.merge
        ? `<circle cx="${p.cx}" cy="${p.cy}" r="3" fill="${c.term}" stroke="${c.lanes[0]}" stroke-width="1.5"/>`
        : `<circle cx="${p.cx}" cy="${p.cy}" r="3.4" fill="${c.lanes[0]}"/>`)).join('\n'));
    A.out([[0, '↑↓ select · enter open · esc back', 'f']], 0.5);
    A.cmd('explain 3');
    A.out([[0, 'row 3: 9c1f2ab explain: stream the answer line by line', 'o']], 0.2);
    A.out([[0, 'reading 1 commit · 3 files · +42 −7', 'o']], 0.45);
    A.out([[0, 'summary', 'a']], 0.2);
    A.stream(['Explain now prints each line as it arrives instead of', 'waiting for the whole answer, and section labels stay amber.']);
    A.out([[0, '· 4.2s · claude-opus-5 · 640 in · 180 out', 'o']]);
    return A;
  },
  'web-pr': () => {
    const A = webChrome(new Anim({ prompt: 'demo/wh $' }));
    A.out([[0, '▜ wh · demo/wh', 'o']], 0.4);
    A.cmd('what changed in pr #42');
    A.out([[0, 'reading 4 commits · 11 files · +180 −64', 'o']], 0.18);
    A.out([[0, 'pr: sessions: signed jwts, no cookie path', 'o']], 0.5);
    A.out([[0, 'summary', 'a']], 0.2);
    A.stream(['Sessions move from cookies to signed jwts, so a restart', 'no longer signs everyone out. Login and refresh issue', 'tokens; the cookie path is gone.']);
    A.out([[0, 'watch out', 'a']], 0.2);
    A.stream(['logout() no longer clears server state, so a stolen token', 'stays valid until it expires.']);
    A.out([[0, '· 5.6s · claude-opus-5 · 1.1k in · 260 out', 'o']]);
    return A;
  }
};

export const LABELS = {
  new: 'wh new', ls: 'wh ls', switch: 'wh switch', rm: 'wh rm',
  explain: 'wh explain', changelog: 'wh explain --changelog',
  describe: 'wh explain --describe', init: 'wh init zsh',
  'web-log': 'web: log, then explain 3', 'web-pr': 'web: what changed in pr #42'
};

export function buildAll() {
  const out = [];
  for (const [name, build] of Object.entries(SPECS)) {
    for (const theme of ['dark', 'light']) {
      out.push({ name, theme, label: LABELS[name], svg: build().render(theme, LABELS[name]) });
    }
  }
  return out;
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
if (isNode && process.argv[1] && process.argv[1].endsWith('readme-anim.mjs')) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir('readme', { recursive: true });
  for (const f of buildAll()) {
    await writeFile(`readme/${f.name}-${f.theme}.svg`, f.svg);
    console.log(`readme/${f.name}-${f.theme}.svg`);
  }
}
