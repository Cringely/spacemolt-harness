// PreToolUse hook (matcher: Agent|Task|Workflow) — the model-tier gate.
//
// Delegation rules have said for a long time that mechanical fetch-and-report work belongs on the
// cheap tier and that premium tiers are for judgment. The rule is prose, so it gets skipped
// silently rather than loudly. The failure this closes is not picking the wrong tier. It is not
// picking at all: a dispatch with no `model` inherits the session model, and an inherited default
// is indistinguishable from a decision once the run starts. Nothing in the transcript says "this
// agent is on the premium tier"; it just is.
//
// So this gate does NOT try to decide the right tier. That is judgment, and a guard that
// misclassifies a prompt produces false blocks, which is how a guard gets muted. It denies only
// the dispatch that names no tier at all. Naming one costs a single word and converts a wrong tier
// into a visible choice someone can argue with in review.
//
// Two checks:
//   1. An Agent/Task dispatch with no `model` denies. `subagent_type: "fork"` is exempt, because a
//      fork inherits the parent model by design and ignores a model override, so demanding the
//      field would be asking for a value with no effect.
//   2. A Workflow whose script contains `agent()` calls with no `model`, or with a model that is
//      not one of the accepted tiers, denies and names the offending call sites by line and label.
//      The scanner reads template literals properly: template text is data, `${ }` contents are
//      code, and the two nest, so a call whose prompt is an interpolated template is seen, a call
//      written inside an interpolation is seen, and `agent(` sitting in template prose is ignored.
//      Fan-out scripts that build prompts by interpolation are the shape this exists for, and they
//      were invisible until the walk grew a frame stack; see the SCANNER LIMIT note below for the
//      one construct it still declines to lex. A call site is the name `agent` in expression
//      position followed by an argument list, whether it is called plainly or with an optional-call
//      `agent?.(`; a source that DEFINES something named `agent` is not one, per the DEFINITION
//      LIMIT note.
//
//      The opts object is read the same way the call site is found, and for the same reason. An
//      earlier draft lexed the call site correctly and then ran plain regexes over the raw bytes of
//      its extent, which is the identical defect one layer down: `model:` inside a comment, inside
//      the prompt's own prose, or inside a nested `agent()` in the opts all read as a stated tier.
//      Two of those are false allows and one is a false block. So `model`, `effort`, `label` and
//      `phase` are only picked up as keys at code positions sitting directly in the call's own
//      argument list — same paren depth, one brace deeper, same template-frame depth. A key one
//      object deeper, one call deeper, or inside any string or comment is not this call's.
//
// NO EFFORT CHECK, and why it is not coming back. There used to be a third check: any agent on
// `sonnet` without `effort: "xhigh"` denied. The Agent tool's input schema carries no `effort`
// parameter at all, so on the path this hook fires on most often that denial had no legal answer.
// The only way past it was to escalate to a premium tier, which inverted the quality-per-dollar
// the rule was written to protect. Workflow's `agent()` does take an effort, so the check was
// satisfiable there and nowhere else. Operator directive 2026-09-05 dropped the mandate outright:
// prefer xhigh where the work justifies it, pick a sensible level otherwise. A softer "sonnet must
// state SOME effort" rule carries the identical defect and is not the replacement. The tier check
// stays, because naming a model is satisfiable on every surface. The scanner still records each
// call's declared `effort` as descriptive output; nothing judges it.
//
// MATCHER NOTE, and the part of it that is not verified. "Agent" and "Task" are observed tool
// names: agent-worktree-gate.ts in this same directory registers on `Agent|Task`, and Task is the
// older name for the same dispatch. "Workflow" is INFERRED from prose in the tool description, and
// no hook payload with `tool_name: "Workflow"` has ever been captured here to confirm it. If the
// real tool name differs, the Workflow branch below is inert rather than wrong: an unrecognised
// tool falls through to allow, so nothing breaks and nothing is protected. Treat that branch as
// untested against a live payload, not as precedent for a name anyone has seen.
//
// ESCAPE HATCH. `MODEL-OVERRIDE: <reason>` in the agent prompt, or anywhere in a workflow script,
// allows unconditionally. The reason text is required to be non-empty but is not judged, matching
// `ISOLATION-OVERRIDE:` in agent-worktree-gate.ts: the safeguard is that the override is written
// down and visible in the transcript, not that a regex can grade it. A gate with no in-band bypass
// gets muted in settings.json instead, silently, the first time it is wrong.
//
// WIRE CONTRACT, and where it differs from its siblings. A deny prints its reason on stderr and
// exits 2, which Claude Code reads as "block and hand the reason back to the model".
// agent-worktree-gate.ts and review-gate.ts instead exit 0 and emit a `hookSpecificOutput` deny on
// stdout. Both forms block; this one is kept because it is the form that was verified live against
// this gate's own payloads before promotion, and because it is the form test/model-tier-gate.test.ts
// asserts on. The code shape is otherwise the siblings': a pure exported `decide()` returning a
// `GateDecision`, with the process entrypoint behind `import.meta.main` so tests can import the
// decision logic without spawning anything.
//
// SCANNER LIMIT, stated narrowly because a vague one is worse than none. The walk does not lex
// regex literals, and it does not intend to: telling `/` apart as a regex opener or a division sign
// needs preceding-token context, the usual heuristic misreads `}` after a block and `)` after an
// `if (...)`, and a wrong guess swallows a region rather than merely skipping one. The cost is
// paid by four byte pairs that can appear inside a regex body, each of which opens a construct that
// was never there and swallows the source up to that construct's own terminator:
//   `/`/`      a backtick opens a template; the rest of the file up to the next backtick is unread
//   `/['"]/`   a quote opens a string; the rest of the line up to the next matching quote is unread
//   `/a\/*b/`  the `\/` `*` pair opens a BLOCK comment; the rest of the file to the next `*/`
//   `/\/\//`   a `\/` `/` pair opens a LINE comment; the rest of that line
// The last two are the ones an earlier draft of this note missed, and the line-comment case matters
// most in practice because `/^https?:\/\//` is the commonest regex there is — a call on the same
// line after it goes unread. Measured against the 51 real workflow scripts on this machine,
// regex-literal handling changes the call count on zero of them, so the trade is a construct that
// has never appeared against a class of failure that would. All four shapes are pinned in
// test/model-tier-gate.test.ts so the limit stays visible and any later attempt to lex regexes has
// to move a test on purpose. Everything else the scanner declines to read — an unterminated
// template, unbalanced parens — allows rather than guessing.
//
// DEFINITION LIMIT. A source that DEFINES something named `agent` must not read as a dispatch: a
// false block on a construct the operator did nothing wrong to write is how a gate gets muted, and
// this gate already refuses to classify prompts for that reason. The walk separates the two by
// asking whether the parens are a parameter list or an argument list — a parameter list is followed
// by the function body, so a `{` sits after the `)`; an argument list is followed by an operator, a
// terminator, or nothing. That covers `function agent() {}` with any of `async`, `*` or `export` in
// front, `get`/`set` accessors, and shorthand methods in both object literals and class bodies. Two
// residues, both pinned in test/model-tier-gate.test.ts:
//   - A call statement whose `)` is immediately followed by a BLOCK statement — `agent("x", {})`
//     then a bare `{ ... }` on the next line — reads as a definition and is not counted. Legal JS,
//     never written, and the failure is an allow rather than a block.
//   - A definition whose parens are NOT followed by a body is not recognised: TypeScript overload
//     signatures, ambient declarations and abstract members. None of those are valid in the `.js`
//     workflow scripts this scanner reads, so the shape cannot occur in its input.
// A definition is dropped from the results entirely rather than recorded as a satisfied call, so it
// neither blocks nor counts toward the "N of M calls" figure in the deny text.
//
// FAIL-OPEN CONTRACT. Malformed stdin, an unreadable `scriptPath`, unbalanced script source, an
// unrecognised tool name, and a script with zero `agent()` calls all allow. So do an unterminated
// template literal and source that nests template interpolation past the scanner's frame cap, both
// of which come back as zero call sites rather than a guess. So does a scanned
// `model:` whose value the scanner cannot read as a plain short literal, a variable reference or a
// string past twenty characters being the usual causes: the call still counts as having named a
// tier, and the tier vocabulary check is skipped for it rather than guessed at. A broken gate must
// never block real work. The error path logs one line to stderr and exits 0, which Claude Code
// reads as no opinion, so a gate that has stopped working is visible to an operator rather than
// invisibly absent.

import { readFileSync } from "node:fs";

/** Tiers this project accepts as an answer to "which model". */
export const VALID_TIERS = ["haiku", "sonnet", "opus", "fable"];

/** Conscious in-band bypass. See the header's ESCAPE HATCH note. */
export const OVERRIDE_TOKEN = "MODEL-OVERRIDE:";
const OVERRIDE_RE = /MODEL-OVERRIDE:[ \t]*\S/;

const RULE = [
  "Tiering rule: any fetch-and-report job (listing, tailing, grepping, running a build or a test,",
  'checking a service, collecting a diff, querying an API) gets model: "haiku". Reserve the premium',
  "tiers for judgment work: review, architecture, arbitration, synthesis across several agents.",
  "A search agent is judgment despite looking mechanical, because choosing search breadth is not",
  "fetching.",
  "",
  "Effort is not part of this rule and is not checked. Prefer xhigh where the work justifies it and",
  "a sensible level otherwise.",
  "",
  "See the model-tier row in the rule catalog in guardrails.md.",
].join("\n");

export type GateDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

const ALLOW: GateDecision = { action: "allow" };

function hasOverride(text: unknown): boolean {
  return typeof text === "string" && OVERRIDE_RE.test(text);
}

// ---------------------------------------------------------------------------
// Scanning a workflow script for agent() calls that never name a tier.
//
// Regex alone is wrong here, at both levels. `agent(` appears inside string literals, comments and
// template prose in these scripts — this file's own block message would trip a naive matcher — and
// so does `model:`. So one walk does all of it: it tracks string, comment and template state, keeps
// a paren stack so each call's extent falls out of the same pass, and reads each call's opts as
// they go by, from code positions only and only at that call's own argument depth.
// ---------------------------------------------------------------------------

export interface AgentCall {
  line: number;
  hasModel: boolean;
  model: string;
  effort: string;
  label: string;
}

/**
 * Lexer state. Six states matter for finding a call site, not four: plain code, a quoted string in
 * the two non-template flavours, the two comment forms, template TEXT, and the code inside a
 * template's `${ }`. The last two are what an earlier draft got wrong. Template text and
 * interpolation code alternate, and they nest arbitrarily deep, so the state has to be a stack
 * rather than a flag.
 *
 * A `template` frame means the bytes are template text (data). An `interp` frame means we are back
 * in code inside `${ }`, and its `depth` counts the braces opened since, so the `}` of an object
 * literal or a block does not end the interpolation. Code mode is "stack empty, or the top frame is
 * an interpolation"; everything else is data.
 */
type Frame = { kind: "template" } | { kind: "interp"; depth: number };

/**
 * Nesting cap. Real scripts nest two or three deep; a source that needs hundreds is either
 * generated or hostile, and either way the honest answer is "cannot scan this", which allows. See
 * the header's FAIL-OPEN CONTRACT.
 */
const MAX_FRAMES = 256;

interface Lexer {
  src: string;
  i: number;
  line: number;
  stack: Frame[];
  overflow: boolean;
}

function newLexer(src: string, at: number): Lexer {
  return { src, i: at, line: 1, stack: [], overflow: false };
}

/** True when the byte at `lx.i` is code rather than string, template text, or comment. */
function inCode(lx: Lexer): boolean {
  const top = lx.stack[lx.stack.length - 1];
  return top === undefined || top.kind === "interp";
}

function push(lx: Lexer, f: Frame): void {
  if (lx.stack.length >= MAX_FRAMES) { lx.overflow = true; return; }
  lx.stack.push(f);
}

/**
 * Advance past exactly one lexical unit, maintaining `line` and the frame stack. Always moves `i`
 * forward by at least one byte, which is what keeps every caller's loop terminating on any input.
 */
function step(lx: Lexer): void {
  const src = lx.src;
  const n = src.length;
  const c = src[lx.i];
  const top = lx.stack[lx.stack.length - 1];

  // --- template text: everything is data except an escape, `${`, and the closing backtick.
  if (top !== undefined && top.kind === "template") {
    if (c === "\\") {
      if (src[lx.i + 1] === "\n") lx.line++;
      lx.i += 2;
      return;
    }
    if (c === "\n") { lx.line++; lx.i++; return; }
    if (c === "$" && src[lx.i + 1] === "{") { push(lx, { kind: "interp", depth: 0 }); lx.i += 2; return; }
    if (c === "`") { lx.stack.pop(); lx.i++; return; }
    // Comment markers, quotes and braces inside template text are ordinary characters.
    lx.i++;
    return;
  }

  // --- code, either at top level or inside a `${ }`.
  if (c === "\n") { lx.line++; lx.i++; return; }

  if (c === "/" && src[lx.i + 1] === "/") {
    while (lx.i < n && src[lx.i] !== "\n") lx.i++;
    return;
  }
  if (c === "/" && src[lx.i + 1] === "*") {
    lx.i += 2;
    while (lx.i < n && !(src[lx.i] === "*" && src[lx.i + 1] === "/")) {
      if (src[lx.i] === "\n") lx.line++;
      lx.i++;
    }
    lx.i = Math.min(lx.i + 2, n); // unterminated: the rest of the file is comment
    return;
  }
  if (c === '"' || c === "'") { skipQuoted(lx, c); return; }
  if (c === "`") { push(lx, { kind: "template" }); lx.i++; return; }

  // Brace depth is only tracked inside an interpolation, where it decides which `}` ends it.
  if (top !== undefined && top.kind === "interp") {
    if (c === "{") { top.depth++; lx.i++; return; }
    if (c === "}") {
      if (top.depth === 0) lx.stack.pop();
      else top.depth--;
      lx.i++;
      return;
    }
  }

  lx.i++;
}

/**
 * Skip a `'`- or `"`-quoted string. A backtick inside one is data, which is the case that makes
 * `${ q("\`") }` work. Deliberately tolerant of an unescaped newline (invalid JS): a real script
 * cannot contain one, and running to the closing quote keeps the walk deterministic on junk.
 */
function skipQuoted(lx: Lexer, quote: string): void {
  const src = lx.src;
  const n = src.length;
  let i = lx.i + 1;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { if (src[i + 1] === "\n") lx.line++; i += 2; continue; }
    if (c === "\n") { lx.line++; i++; continue; }
    if (c === quote) { i++; break; }
    i++;
  }
  lx.i = i;
}

/**
 * A call site whose opening paren has been seen and whose closing paren has not. `parens`, `braces`
 * and `frames` are the depths that identify this call's own argument list, so a key found at
 * exactly `parens`, `braces + 1` and `frames` belongs to it and one found anywhere else does not.
 */
interface PendingCall {
  seq: number;
  line: number;
  parens: number;
  braces: number;
  frames: number;
  hasModel: boolean;
  model: string;
  effort: string;
  label: string;
  phase: string;
}

function isIdStart(ch: number): boolean {
  return (ch >= 97 && ch <= 122) || (ch >= 65 && ch <= 90) || ch === 95 || ch === 36;
}

function isIdPart(ch: number): boolean {
  return isIdStart(ch) || (ch >= 48 && ch <= 57);
}

/** End of the identifier starting at `at`. Identifiers hold no newline and no lexical state. */
function identEnd(src: string, at: number): number {
  let j = at + 1;
  while (j < src.length && isIdPart(src.charCodeAt(j))) j++;
  return j;
}

/**
 * Skip whitespace and comments from a code position. Used for the two "what comes next" questions
 * the walk asks without moving: is there a `(` after this `agent`, and a `:` after this key. Always
 * either advances or returns, so it terminates on any input including an unterminated comment.
 */
function skipTrivia(src: string, at: number): number {
  const n = src.length;
  let j = at;
  for (;;) {
    while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
    if (src[j] === "/" && src[j + 1] === "/") {
      while (j < n && src[j] !== "\n") j++;
      continue;
    }
    if (src[j] === "/" && src[j + 1] === "*") {
      const k = src.indexOf("*/", j + 2);
      j = k < 0 ? n : k + 2;
      continue;
    }
    return j;
  }
}

/**
 * Contents of the quoted literal at `at`, bounded by `max` characters. `truncate` picks the answer
 * for a literal that runs past the bound: null for a tier value, where "could not read it" is the
 * honest answer and fails open, and the partial text for a label, which is only ever printed.
 */
function literalAt(src: string, at: number, max: number, truncate: boolean): string | null {
  const q = src[at];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  const limit = Math.min(src.length, at + max + 2);
  let out = "";
  let j = at + 1;
  while (j < limit) {
    const c = src[j];
    if (c === "\\") { out += c + (src[j + 1] ?? ""); j += 2; continue; }
    if (c === q) return out;
    if (c === "\n") return truncate ? out : null;
    out += c;
    j++;
  }
  return truncate ? out : null;
}

/** A tier or effort value: a plain short literal, or "" for anything the scanner cannot read. */
const SHORT_LITERAL = /^[A-Za-z0-9_-]{1,20}$/;

function tierValue(src: string, afterColon: number): string {
  const raw = literalAt(src, skipTrivia(src, afterColon), 20, false);
  return raw !== null && SHORT_LITERAL.test(raw) ? raw : "";
}

function textValue(src: string, afterColon: number, max: number): string {
  return literalAt(src, skipTrivia(src, afterColon), max, true) ?? "";
}

/** Fold one `key: value` of a call's own opts object into the pending call. First one wins. */
function recordKey(call: PendingCall, name: string, src: string, afterColon: number): void {
  if (name === "model") {
    if (!call.hasModel) call.model = tierValue(src, afterColon);
    call.hasModel = true;
  } else if (name === "effort") {
    if (!call.effort) call.effort = tierValue(src, afterColon);
  } else if (name === "label") {
    if (!call.label) call.label = textValue(src, afterColon, 60);
  } else if (name === "phase") {
    if (!call.phase) call.phase = textValue(src, afterColon, 40);
  }
}

/** Index of the `:` following a key token, or -1 when the token is not a key. */
function colonAfter(src: string, at: number): number {
  const j = skipTrivia(src, at);
  return src[j] === ":" ? j : -1;
}

/**
 * One pass over the source. Finds every `agent(` call site at a code position, bracket-matches it
 * against the same walk rather than a second one, and reads its opts as they go by.
 *
 * The single pass is not only tidiness. An earlier draft re-lexed from each call site to end of
 * file to find its closing paren, which is O(n squared) on a script with many call sites and a
 * quadratic blowup on one with an unbalanced paren — measured at multi-minute stalls on a 268KB
 * input. A hook that stalls past its timeout blocks every dispatch, which is worse than the bug it
 * was fixing. Here each byte is visited once and the paren stack does the matching, so cost is
 * linear in source length with no reachable pathological input.
 */
export function scanAgentCalls(src: string): AgentCall[] {
  const n = src.length;
  const lx = newLexer(src, 0);
  const done: { seq: number; call: AgentCall }[] = [];
  const open: PendingCall[] = [];
  let parens = 0;
  let braces = 0;
  let pendingParen = -1;
  let pendingLine = 0;
  let seq = 0;
  // The walk is single-pass and every branch advances, so this only fires if that invariant is ever
  // broken. Cheap insurance against a hook that hangs a dispatch instead of allowing it.
  let budget = n * 2 + 1000;

  while (lx.i < n) {
    if (lx.overflow || budget-- <= 0) return [];

    if (inCode(lx)) {
      const c = src[lx.i];
      const top = open[open.length - 1];
      // True when a key token here would sit directly in `top`'s own opts object.
      const atOpts =
        top !== undefined &&
        parens === top.parens &&
        braces === top.braces + 1 &&
        lx.stack.length === top.frames;

      if (isIdStart(src.charCodeAt(lx.i))) {
        const end = identEnd(src, lx.i);
        const name = src.slice(lx.i, end);
        if (name === "agent") {
          // Identifier boundary: `subagent(` never reaches here (it lexes as one identifier), but
          // `x.agent(` does, so the preceding byte still has to be checked. Whitespace and comments
          // between the name and the paren are legal JS and are stepped over, and so is an
          // optional-call `?.`: `agent?.("x", {})` is a real dispatch that inherits the session
          // model, which is exactly what this gate exists to catch. Nothing else is accepted in that
          // hop — `agent?.run(` is a different callee and `agent ? (a) : b` is a ternary, both of
          // which fail the `?.` pair test and then the `(` test.
          const prev = lx.i > 0 ? src[lx.i - 1] : " ";
          if (!/[\w$.]/.test(prev)) {
            let p = skipTrivia(src, end);
            if (src[p] === "?" && src[p + 1] === ".") p = skipTrivia(src, p + 2);
            if (src[p] === "(") { pendingParen = p; pendingLine = lx.line; }
          }
        } else if (atOpts) {
          const colon = colonAfter(src, end);
          if (colon >= 0) recordKey(top, name, src, colon + 1);
        }
        lx.i = end;
        continue;
      }

      if (c === '"' || c === "'") {
        // A quoted key (`{"model": "haiku"}`) is legal and reads as a tier. Stepping first keeps
        // line tracking in one place; the literal's extent is then just the span we moved over.
        const start = lx.i;
        step(lx);
        if (atOpts && lx.i - start <= 66) {
          const colon = colonAfter(src, lx.i);
          if (colon >= 0) recordKey(top, src.slice(start + 1, Math.max(start + 1, lx.i - 1)), src, colon + 1);
        }
        continue;
      }

      if (c === "(") {
        parens++;
        if (lx.i === pendingParen) {
          open.push({
            seq: seq++,
            line: pendingLine,
            parens,
            braces,
            frames: lx.stack.length,
            hasModel: false,
            model: "",
            effort: "",
            label: "",
            phase: "",
          });
          pendingParen = -1;
        }
        lx.i++;
        continue;
      }

      if (c === ")") {
        // Only the innermost pending call can close here, and only at its own depth. Calls nest
        // (`parallel(() => agent(...))`, an `agent()` passed as an opt), so each closes in turn.
        // `===` rather than `<=` is a statement of intent, not a live guard: `parens` only ever
        // falls at a `)`, so the first `)` after a call opened at depth d is that call's own, and
        // `parens < top.parens` is unreachable. Relaxing it changes nothing on 40,000 random
        // delimiter-soup sources or on any of the 54 real workflow scripts, so there is no input to
        // pin it with; the reasoning is the pin.
        if (top !== undefined && top.parens === parens) {
          open.pop();
          // Parameter list or argument list — the one question that separates a definition of
          // something named `agent` from a call to it. A parameter list is followed by the function
          // body, so the next code byte after the `)` is a `{`; an argument list is followed by an
          // operator, a terminator, or nothing. That single test covers every definition shape at
          // once — `function agent(p) {}` with any of `async`, `*` or `export` in front, the
          // accessors `get agent() {}` and `set agent(v) {}`, and the shorthand method in both an
          // object literal (`{ agent(p, q) {} }`) and a class body — without the walk having to know
          // whether the enclosing brace is a block or an object literal, which it does not track.
          // Looking backwards for a `function`/`get`/`set`/`async` keyword would need that context
          // and would still miss the shorthand, which has no keyword at all. A definition is dropped
          // rather than recorded: it is not a dispatch, so it is neither a call site nor a
          // violation. See the DEFINITION LIMIT note in the header for what this misreads.
          if (src[skipTrivia(src, lx.i + 1)] !== "{") {
            done.push({
              seq: top.seq,
              call: {
                line: top.line,
                hasModel: top.hasModel,
                model: top.model,
                effort: top.effort,
                label: top.label || (top.phase ? `phase ${top.phase}` : "unlabelled"),
              },
            });
          }
        }
        if (parens > 0) parens--;
        lx.i++;
        continue;
      }

      if (c === "{") { braces++; step(lx); continue; }

      if (c === "}") {
        // The `}` that ends an interpolation has no `{` of its own — `${` opened it in template
        // text — so it must not decrement the code brace depth.
        const frame = lx.stack[lx.stack.length - 1];
        const closesInterp = frame !== undefined && frame.kind === "interp" && frame.depth === 0;
        if (!closesInterp && braces > 0) braces--;
        step(lx);
        continue;
      }
    }

    const before = lx.i;
    step(lx);
    if (lx.i <= before) lx.i = before + 1;
  }

  // A call still open at EOF was never closed: unbalanced or unterminated source, which is
  // unscannable and therefore allows. Report in source order, not closing order, since a nested
  // call closes before the one containing it.
  done.sort((a, b) => a.seq - b.seq);
  return done.map((d) => d.call);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Pure decision over an Agent/Task dispatch's `tool_input`. Unrecognizable input allows. */
export function checkAgent(input: unknown): GateDecision {
  if (typeof input !== "object" || input === null) return ALLOW;
  const t = input as Record<string, unknown>;

  // A fork inherits the parent model by design and ignores a model override, so demanding one
  // would be asking for a field with no effect.
  if (t.subagent_type === "fork") return ALLOW;

  const model = typeof t.model === "string" ? t.model.trim() : "";
  if (model) {
    if (!VALID_TIERS.includes(model)) {
      return {
        action: "deny",
        reason: [
          `BLOCKED: this dispatch names model "${model}", which is not a tier this project accepts.`,
          `Valid: ${VALID_TIERS.join(", ")}.`,
        ].join("\n"),
      };
    }
    // No override check here, and none is needed: a valid tier is the whole requirement, so there
    // is nothing left for an override to waive. It was read at this point only to waive the effort
    // mandate. An unrecognized tier above is deliberately not waivable, which is the one place
    // checkAgent is stricter than checkWorkflow.
    return ALLOW;
  }

  if (hasOverride(t.prompt)) return ALLOW;

  return {
    action: "deny",
    reason: [
      "BLOCKED: this dispatch does not state a model tier, so it silently inherits the session model.",
      "",
      RULE,
      "",
      'Add model: "haiku" (or sonnet/opus/fable) to the dispatch.',
      "If the session model really is the right tier, say so explicitly by passing it.",
      `To dispatch without choosing, put \`${OVERRIDE_TOKEN} <reason>\` in the prompt. The reason is required.`,
    ].join("\n"),
  };
}

/**
 * Pure decision over a Workflow's `tool_input`. `readFile` is injected so tests can exercise the
 * `scriptPath` branch without touching disk; the process entrypoint passes a real reader that
 * returns null on any failure.
 */
export function checkWorkflow(
  input: unknown,
  readFile: (p: string) => string | null,
): GateDecision {
  if (typeof input !== "object" || input === null) return ALLOW;
  const t = input as Record<string, unknown>;

  // A predefined workflow invoked by name is somebody else's script; we did not author its tiers.
  const inlineScript = typeof t.script === "string" ? t.script : null;
  const scriptPath = typeof t.scriptPath === "string" ? t.scriptPath : null;
  if (!inlineScript && !scriptPath) return ALLOW;

  const src = inlineScript ?? (scriptPath ? readFile(scriptPath) : null);
  if (!src) return ALLOW; // unreadable, so fail open

  if (hasOverride(src)) return ALLOW;

  const calls = scanAgentCalls(src);
  if (calls.length === 0) return ALLOW; // nothing to spawn, or unparsable, so fail open

  const bare = calls.filter((c) => !c.hasModel);
  // The same tier vocabulary checkAgent enforces, applied per call site. Without this a misspelled
  // `"sonet"` in a fan-out script reads as a stated tier and inherits the session model anyway,
  // which is the failure this whole gate exists to close. A value the scanner could not read comes
  // back empty and is left alone, per the header's FAIL-OPEN CONTRACT. One deliberate difference
  // from checkAgent: a script-level override waives this check, because the override is read before
  // the script is scanned at all.
  const unknownTier = calls.filter((c) => c.hasModel && c.model && !VALID_TIERS.includes(c.model));
  if (bare.length === 0 && unknownTier.length === 0) return ALLOW;

  const lines: string[] = ["BLOCKED: this workflow's agent tiers are not all stated and valid.", ""];

  if (bare.length > 0) {
    const shown = bare.slice(0, 12);
    lines.push(
      `${bare.length} of ${calls.length} agent() calls name no model, so they inherit the session`,
      "model. On a fan-out that is the expensive default, and it is a default rather than a decision.",
      ...shown.map((c) => `  line ${c.line}  ${c.label}`),
    );
    if (bare.length > shown.length) lines.push(`  ... and ${bare.length - shown.length} more`);
    lines.push("");
  }

  if (unknownTier.length > 0) {
    const shown = unknownTier.slice(0, 12);
    lines.push(
      `${unknownTier.length} call(s) name a model that is not a tier this project accepts.`,
      `Valid: ${VALID_TIERS.join(", ")}.`,
      ...shown.map((c) => `  line ${c.line}  ${c.label}: "${c.model}"`),
    );
    if (unknownTier.length > shown.length) lines.push(`  ... and ${unknownTier.length - shown.length} more`);
    lines.push("");
  }

  lines.push(
    RULE,
    "",
    'Name a tier on each opts object, for example { label: "...", model: "sonnet" }.',
    "A typical split: measurement and fetching on haiku, verification on sonnet, synthesis on the",
    "premium tier.",
    `To run without choosing, put \`${OVERRIDE_TOKEN} <reason>\` anywhere in the script.`,
  );
  return { action: "deny", reason: lines.join("\n") };
}

/**
 * The gate's whole policy over a PreToolUse stdin payload, pure apart from the injected reader.
 * Unrecognizable input and any tool this gate does not judge both allow.
 */
export function decide(
  payload: unknown,
  readFile: (p: string) => string | null = () => null,
): GateDecision {
  if (typeof payload !== "object" || payload === null) return ALLOW;
  const p = payload as Record<string, unknown>;

  // Defense in depth: only judge the dispatch tools, whatever the matcher says. See the header's
  // MATCHER NOTE for which of these names is observed and which is inferred.
  const tool = p.tool_name;
  if (tool === "Agent" || tool === "Task") return checkAgent(p.tool_input);
  if (tool === "Workflow") return checkWorkflow(p.tool_input, readFile);
  return ALLOW;
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text();
    if (raw.trim() === "") process.exit(0);

    const readFile = (path: string): string | null => {
      try { return readFileSync(path, "utf8"); } catch { return null; }
    };

    const decision = decide(JSON.parse(raw), readFile);
    if (decision.action === "deny") {
      console.error(decision.reason);
      process.exit(2);
    }
  } catch (err) {
    // Fail open: log and allow. A broken gate must never block real work. Exit 0 with nothing on
    // stdout is Claude Code's "no opinion", so the dispatch proceeds; the stderr line keeps a
    // silently broken gate visible to an operator reading hook output.
    console.error(`model-tier-gate: hook error, allowing dispatch: ${String(err)}`);
  }
  process.exit(0);
}
