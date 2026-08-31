// the slash commands: everything that is not a question about the repo.
// keys, models, effort, theme, fonts, the transcript (/copy, /export,
// /clear), the session. one switch over a context the terminal hands
// in, so the component keeps only what react needs.

import { chatStore, type ChatLine } from "@/lib/chat-store";
import { DEFAULT_MODELS, EFFORTS, MODEL_RE, modelFamily } from "@/lib/explain/providers";
import { keyStore } from "@/lib/key-store";
import type { Emit } from "@/lib/terminal/emit";
import { HELP, helpLines, WD_HELP } from "@/lib/terminal/help";
import {
  effortIgnored,
  keyLines,
  modelName,
  modelSuggestionLines,
  providerInfo,
  usageInfoRow,
  usageLines,
} from "@/lib/terminal/info";
import { flat } from "@/lib/terminal/lines";
import { effortArgs, FONTS, PROVIDERS } from "@/lib/terminal/menu";
import { applyFont, applyFontSize, applyLigatures, prefs } from "@/lib/terminal/prefs";
import { currentTheme, switchTheme, type Theme } from "./theme-toggle";

export interface SlashContext {
  owner: string;
  repo: string;
  login?: string;
  storeKey: string;
  lines: ChatLine[];
  busy: boolean;
  lastCmd(): string;
  emit: Emit;
  router: { push(path: string): void };
  setHasKey(v: boolean): void;
  saveKey(value: string, echoText: string): void;
  run(command: string, raw?: boolean): Promise<void>;
  changeInput(v: string): void;
  focusInput(): void;
}

export function runSlash(ctx: SlashContext, raw: string) {
  const { owner, repo, login, storeKey, lines, busy } = ctx;
  const { push, muted, echo, ok, err } = ctx.emit;
  const [cmd, ...rest] = raw.slice(1).split(" ");
  const arg = rest.join(" ").trim();
  switch (cmd.toLowerCase()) {
    case "help":
      echo(raw);
      push(helpLines(HELP));
      break;
    case "repos":
      echo(raw);
      ctx.router.push("/repos");
      break;
    case "clear":
      chatStore.setAll(storeKey, []);
      chatStore.clearContext(storeKey);
      chatStore.setLogRows(storeKey, undefined); // row numbers left with the screen
      chatStore.setPrRows(storeKey, undefined);
      chatStore.setLive(storeKey, undefined);
      chatStore.clearExpanded(storeKey);
      chatStore.setDraft(storeKey, undefined);
      break;
    case "usage": {
      echo(raw);
      const [verb, which] = arg.split(/\s+/);
      const how = "usage: /usage reset [provider] starts the count over";
      if (!arg) {
        muted(
          keyStore.providers().length
            ? [...usageLines(), how]
            : ["no key set; the count starts when one is saved."]
        );
      } else if (verb !== "reset") {
        muted([how]);
      } else if (!which) {
        keyStore.resetUsage();
        ok("usage", "count started over for every key");
      } else {
        const target = PROVIDERS.find((p) => p === which);
        if (!target) {
          muted([how]);
        } else if (!keyStore.hasKey(target)) {
          muted([`no ${target} key stored.`]);
        } else {
          keyStore.resetUsage(target);
          ok("usage", `count started over for ${target}`);
        }
      }
      break;
    }
    case "key": {
      const usage = "usage: /key <value> adds or replaces, /key clear [provider] removes";
      const [verb, which] = arg.split(/\s+/);
      if (!arg) {
        echo(raw);
        muted([...keyLines(), usage]);
      } else if (verb === "clear" && !which) {
        keyStore.removeKey();
        ctx.setHasKey(false);
        echo(raw);
        muted(["all keys removed from this browser."]);
      } else if (verb === "clear") {
        echo(raw);
        const target = PROVIDERS.find((p) => p === which);
        if (!target) {
          muted([usage]);
        } else if (!keyStore.hasKey(target)) {
          muted([`no ${target} key stored.`]);
        } else {
          keyStore.removeKey(target);
          ctx.setHasKey(keyStore.providers().length > 0);
          muted([`${target} key removed from this browser.`, `now: ${providerInfo()}`]);
        }
      } else {
        ctx.saveKey(arg, "/key ***");
      }
      break;
    }
    case "model": {
      echo(raw);
      const m = arg.trim();
      const active = keyStore.active();
      if (!m) {
        muted([
          `model: ${providerInfo()}`,
          "usage: /model <name> or /model default; another provider's model switches to it",
          ...modelSuggestionLines(),
        ]);
      } else if (!active) {
        muted(["paste an api key first."]);
      } else if (m.toLowerCase() === "default") {
        keyStore.setModel(active, "");
        ok("model", `${modelName()} (${active} default)`);
      } else if (!MODEL_RE.test(m)) {
        muted(["that does not look like a model id."]);
      } else {
        // ids of unknown family (llama-*, mixtral-*) stay on the active provider
        const target = modelFamily(m) ?? active;
        if (!keyStore.hasKey(target)) {
          muted([`no ${target} key yet; /key <value> adds one.`]);
        } else {
          keyStore.setActive(target);
          keyStore.setModel(target, m === DEFAULT_MODELS[target] ? "" : m);
          ok("model", `${m}${target !== active ? ` (switched to ${target})` : ""}`);
          const notes: string[] = [];
          // said once; after that the green line is the whole story
          if (!prefs.get("wd_model_hint")) {
            prefs.set("wd_model_hint", "seen");
            notes.push("it is sent per request, like the key.");
          }
          // providers with effort levels get the /effort menu right away,
          // so model and effort are one flow; esc keeps the current level
          if (EFFORTS[target].length) {
            notes.push(
              `effort: ${keyStore.effort(target) || "provider default"} · pick a level below, esc keeps it`
            );
            ctx.changeInput("/effort ");
            ctx.focusInput();
          }
          if (notes.length) muted(notes);
        }
      }
      break;
    }
    case "effort": {
      echo(raw);
      const level = arg.toLowerCase();
      const levels = effortArgs().slice(1);
      const active = keyStore.active();
      if (!active) {
        muted(["paste an api key first."]);
      } else if (effortIgnored() && level !== "default") {
        muted([`your key is ${active}: its models take no effort level.`]);
      } else if (!level) {
        muted([
          `effort: ${keyStore.effort(active) || "provider default"} (${active})`,
          `usage: /effort ${levels.join("|")} or /effort default`,
          "higher levels think longer; not every model accepts effort.",
        ]);
      } else if (level === "default") {
        keyStore.setEffort(active, "");
        ok("effort", `${active} default`);
      } else if (levels.includes(level)) {
        keyStore.setEffort(active, level);
        ok("effort", `${level} for ${active}`);
      } else {
        muted([`usage: /effort ${levels.join("|")} or /effort default`]);
      }
      break;
    }
    case "theme": {
      echo(raw);
      const t = arg.toLowerCase();
      if (t === "auto" || t === "light" || t === "dark") {
        switchTheme(t as Theme);
        ok("theme", t);
      } else {
        muted([`theme is ${currentTheme()}. usage: /theme auto|light|dark`]);
      }
      break;
    }
    case "account":
      echo(raw);
      muted(
        login
          ? [`signed in as ${login}`, `github.com/${login}`]
          : ["not signed in"]
      );
      break;
    case "info": {
      echo(raw);
      const c = chatStore.context(storeKey);
      muted([
        `repo      ${owner}/${repo}`,
        `provider  ${providerInfo()}`,
        `keys      ${keyStore.providers().join(", ") || "none"}`,
        `usage     ${usageInfoRow()}`,
        `theme     ${currentTheme()}`,
        `font      ${prefs.get("wd_font") || "default"} · ${prefs.get("wd_fontsize") || "13"}px · ligatures ${prefs.get("wd_lig") === "off" ? "off" : "on"}`,
        `context   ${c ? `active (${c.length} messages), follow-ups on` : "none, run a command first"}`,
      ]);
      break;
    }
    case "font":
      echo(raw);
      if (FONTS.includes(arg.toLowerCase())) {
        applyFont(arg.toLowerCase());
        ok("font", arg.toLowerCase());
      } else {
        muted([
          `font is ${prefs.get("wd_font") || "default"}. usage: /font ${FONTS.join("|")}`,
        ]);
      }
      break;
    case "fontsize": {
      echo(raw);
      const n = parseInt(arg, 10);
      if (arg === "default") {
        applyFontSize("default");
        ok("font size", "default");
      } else if (n >= 11 && n <= 18) {
        applyFontSize(String(n));
        ok("font size", `${n}px`);
      } else {
        muted(["usage: /fontsize 11..18 or default"]);
      }
      break;
    }
    case "ligatures": {
      echo(raw);
      const lig = arg.toLowerCase();
      if (lig === "on" || lig === "off") {
        applyLigatures(lig === "on");
        ok("ligatures", `${lig} (visible with fira or jetbrains)`);
      } else {
        muted(["usage: /ligatures on|off"]);
      }
      break;
    }
    case "show": {
      echo(raw);
      const last = ctx.lastCmd();
      if (!last) {
        muted(["nothing to show yet, run a repo command first."]);
      } else {
        muted([`payload for: ${last}`]);
        void ctx.run(last, true);
      }
      break;
    }
    case "copy": {
      // the last answer: everything after the last prompt line, minus
      // status chatter (the muted lines), so a paste is just the text
      let start = lines.length;
      while (start > 0 && !lines[start - 1].prefix) start--;
      const answer = lines
        .slice(start)
        .filter((l) => l.cls !== "o")
        .map(flat);
      echo(raw);
      if (!answer.length) {
        muted(["nothing to copy yet."]);
        break;
      }
      navigator.clipboard
        .writeText(answer.join("\n") + "\n")
        .then(() => ok("copied", `${answer.length} ${answer.length === 1 ? "line" : "lines"}`))
        .catch(() => err("clipboard unavailable, select the text instead"));
      break;
    }
    case "export": {
      echo(raw);
      const text = lines.map(flat).join("\n");
      const blob = new Blob([text + "\n"], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `wd-${owner}-${repo}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
      ok("saved", a.download);
      break;
    }
    case "wd":
      echo(raw);
      push(helpLines(WD_HELP));
      break;
    case "stop":
      echo(raw);
      if (busy) chatStore.abort(storeKey);
      else muted(["nothing running."]);
      break;
    case "logout":
      echo(raw);
      muted(["signing out..."]);
      void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
        window.location.href = "/";
      });
      break;
    default:
      echo(raw);
      muted([`unknown command: /${cmd}. try /help`]);
  }
}
