/** One simple command: its words with quotes removed, the heredoc bodies it reads, and whether `|` feeds it. */
type Command = { words: string[]; heredocs: string[]; piped: boolean };

/** Tested on one simple command, from its program on. */
const RISKY: readonly [RegExp, string][] = [
  [/^git\s+(?:-[cC]\s+\S+\s+)*(?:(?:push|rebase|reset\s+--hard|branch\s+-[a-zA-Z]*D)(?=\s|$)|clean\s+-[a-zA-Z]*f)/, "history-changing git command"],
  [/^(?:sudo|doas)\b/, "privilege escalation"],
  [/^(?:mkfs\S*|shutdown|reboot)\b|^dd\s+if=/, "disk or system command"],
  [/^(?:npm|pnpm|yarn|bun)\s+publish\b|^gh\s+(?:release|pr\s+merge|repo\s+delete)\b/, "publishing or remote change"],
  [/^(?:chmod|chown)\s+-R\b/, "recursive permission change"],
  [/^(?:kill|pkill|killall)\b/, "killing processes"],
];
/** Programs that run their arguments, or the heredoc they read, as shell code. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "ssh", "su"]);
/** Programs that run the command in their later words, as `xargs kill` or `timeout 5 rm -rf x`. */
const WRAPPERS = new Set(["xargs", "env", "nice", "nohup", "timeout", "exec", "command", "builtin", "time", "stdbuf", "ionice", "caffeinate", "watch"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const REDIRECT = /^(?:\d*|&)[<>]/;

/**
 * Splits shell text into simple commands, at `; & | ( )`, newlines, `$(...)` and backticks. Quotes and heredoc bodies
 * become words or bodies of their command, never commands; substitutions inside double quotes still run, so they are
 * commands of their own. `closed` is false when a quote, substitution or heredoc never ends.
 */
function lex(s: string, from: number, until?: ")" | "`"): { commands: Command[]; end: number; closed: boolean } {
  const commands: Command[] = [], nested: Command[] = [];
  const pending: { delimiter: string; strip: boolean; into: string[] }[] = [];
  let words: string[] = [], heredocs: string[] = [], word: string | undefined, piped = false, closed = true, depth = 0;
  const endWord = () => { if (word !== undefined) words.push(word); word = undefined; };
  const endCommand = (nextPiped = false) => { endWord(); if (words.length || heredocs.length) commands.push({ words, heredocs, piped }); words = []; heredocs = []; piped = nextPiped; };
  const substitute = (start: number, close: ")" | "`") => {
    const inner = lex(s, start, close);
    nested.push(...inner.commands);
    closed &&= inner.closed;
    word = `${word ?? ""}$()`;
    return inner.end;
  };
  let i = from;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === until && (until === "`" || depth === 0)) { endCommand(); return { commands: [...commands, ...nested], end: i, closed }; }
    if (c === "\\") { if (s[i + 1] !== "\n") word = `${word ?? ""}${s[i + 1] ?? ""}`; i++; }
    else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) { closed = false; word = `${word ?? ""}${s.slice(i + 1)}`; i = s.length; }
      else { word = `${word ?? ""}${s.slice(i + 1, end)}`; i = end; }
    } else if (c === '"') {
      word ??= "";
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\") { word += s[i + 1] ?? ""; i++; }
        else if (s.startsWith("$(", i)) i = substitute(i + 2, ")");
        else if (s[i] === "`") i = substitute(i + 1, "`");
        else word += s[i];
      }
      if (i >= s.length) closed = false;
    } else if (c === "$" && s[i + 1] === "(") i = substitute(i + 2, ")");
    else if (c === "`") i = substitute(i + 1, "`");
    else if (c === "#" && word === undefined) { const end = s.indexOf("\n", i); i = (end < 0 ? s.length : end) - 1; }
    else if (c === "<" && s.startsWith("<<", i) && s[i + 2] !== "<") {
      const match = /^<<(-?)[ \t]*(['"]?)([^\s'"<>;&|()]+)\2/.exec(s.slice(i));
      if (!match) { word = `${word ?? ""}<<`; i++; continue; }
      endWord();
      pending.push({ delimiter: match[3], strip: match[1] === "-", into: heredocs });
      i += match[0].length - 1;
    } else if (c === "\n") {
      endCommand();
      let position = i + 1;
      for (const heredoc of pending.splice(0)) {
        const lines: string[] = [];
        let ended = false;
        while (position < s.length && !ended) {
          const newline = s.indexOf("\n", position), lineEnd = newline < 0 ? s.length : newline;
          const line = s.slice(position, lineEnd);
          position = lineEnd + 1;
          if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) ended = true;
          else lines.push(line);
        }
        closed &&= ended;
        heredoc.into.push(lines.join("\n"));
      }
      i = position - 1;
    } else if (c === "&" && (s[i - 1] === ">" || s[i - 1] === "<" || s[i + 1] === ">")) word = `${word ?? ""}${c}`;
    else if (c === "|") { const pipe = s[i + 1] !== "|"; if (s[i + 1] === "|" || s[i + 1] === "&") i++; endCommand(pipe); }
    else if (c === "(") { depth++; endCommand(); }
    else if (c === ")") { depth = Math.max(0, depth - 1); endCommand(); }
    else if (c === ";" || c === "&") { if (s[i + 1] === c) i++; endCommand(); }
    else if (c === " " || c === "\t") endWord();
    else word = `${word ?? ""}${c}`;
  }
  endCommand();
  if (until || pending.length) closed = false;
  for (const heredoc of pending) heredoc.into.push("");
  return { commands: [...commands, ...nested], end: i, closed };
}

const start = (words: readonly string[]) => { let index = 0; while (index < words.length && (KEYWORDS.has(words[index]) || ASSIGNMENT.test(words[index]))) index++; return index; };
const programOf = (words: readonly string[]) => words[start(words)]?.replace(/^.*\//, "") ?? "";

/** True for a path strictly inside the temp directory, with no `..`, variable or leading glob that could leave it. */
function insideTemp(target: string) {
  const temp = process.env.TMPDIR?.replace(/\/*$/, "/");
  const root = ["/tmp/", "/private/tmp/", "$TMPDIR/", "${TMPDIR}/", ...(temp && temp !== "/" ? [temp] : [])].find((prefix) => target.startsWith(prefix));
  const rest = root === undefined ? "" : target.slice(root.length);
  return rest !== "" && !/^[*?[]/.test(rest) && !rest.includes("$") && !rest.split("/").includes("..");
}

function rmRisk(args: readonly string[]) {
  const targets: string[] = [];
  let forced = false, operands = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!operands && arg === "--") operands = true;
    else if (REDIRECT.test(arg)) { if (/^(?:\d*|&)[<>]+&?$/.test(arg)) index++; }
    else if (!operands && arg.startsWith("-")) forced ||= /^-[a-zA-Z]*[rRf]/.test(arg) || arg === "--recursive" || arg === "--force";
    else targets.push(arg);
  }
  // Removing scratch files under the temp directory is routine; any other target still needs a person.
  return forced && !(targets.length && targets.every(insideTemp)) ? "recursive or forced rm" : undefined;
}

function commandRisk(words: readonly string[], heredocs: readonly string[] = []): string | undefined {
  const name = programOf(words);
  if (!name) return undefined;
  const args = words.slice(start(words) + 1);
  if (name === "rm") return rmRisk(args);
  const hit = RISKY.find(([pattern]) => pattern.test([name, ...args].join(" ")))?.[1];
  if (hit) return hit;
  if (SHELLS.has(name)) {
    // `bash -c '...'`, `eval ...`, `ssh host '...'` and `bash <<EOF` run their text: check each tail of it as a script.
    for (let index = 0; index < args.length; index++) { const risk = riskOf(args.slice(index).join(" ")); if (risk) return risk; }
    for (const body of heredocs) { const risk = riskOf(body); if (risk) return risk; }
  }
  if (name === "find") {
    for (let index = 0; index < args.length; index++) if (/^-(?:exec|execdir|ok|okdir)$/.test(args[index])) { const risk = commandRisk(args.slice(index + 1)); if (risk) return risk; }
  } else if (WRAPPERS.has(name)) {
    let index = 0;
    while (index < args.length && (args[index].startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(args[index]) || ASSIGNMENT.test(args[index]) || args[index] === "{}")) index++;
    return commandRisk(args.slice(index));
  }
  return undefined;
}

/**
 * Why `command` needs a person's approval, or undefined when it does not. A pattern counts only as a command, so the same
 * words in a message, a quoted argument or a heredoc's text pass. Text the splitter cannot close (an unterminated quote,
 * substitution or heredoc) is checked word by word instead, so it fails closed.
 */
export function riskOf(command: string): string | undefined {
  const { commands, closed } = lex(command, 0);
  if (!closed) {
    const words = command.split(/[\s;&|()`'"]+/).filter(Boolean);
    for (let index = 0; index < words.length; index++) { const risk = commandRisk(words.slice(index)); if (risk) return risk; }
  }
  let pipeline: Command[] = [];
  for (const item of commands) {
    if (!item.piped) pipeline = [];
    const name = programOf(item.words);
    if (SHELLS.has(name)) {
      if (pipeline.some(({ words }) => /^(?:curl|wget)$/.test(programOf(words)))) return "piping a download into a shell";
      // `cat <<EOF | sh` runs the heredoc of an earlier command in the pipeline.
      for (const body of pipeline.flatMap(({ heredocs }) => heredocs)) { const risk = riskOf(body); if (risk) return risk; }
    }
    pipeline.push(item);
    const risk = commandRisk(item.words, item.heredocs);
    if (risk) return risk;
  }
  return undefined;
}
