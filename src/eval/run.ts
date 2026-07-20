import { writeFileSync } from "node:fs";
import { makePlanner } from "../config/planner-factory";
import { estimateCostUsd } from "../server/usage";
import type { PlannerSpec } from "../config/config";
import type { Planner } from "../planner/types";
import { loadCases } from "./cases";
import { harvestCases } from "./harvest";
import { scoreGoalDiversity, scorePlan, SCORERS } from "./scorers";
import type { CandidatePlan, EvalCase, ScoreResult } from "./types";

// The offline planner eval runner (issue #263). Scores ANY planner against
// recorded game states -- zero live game traffic, zero game mutations. The
// planner arrives through the existing planner-factory seam (claude-subscription
// / ollama / openai-compat / mock), so putting a new candidate model on the
// scoreboard is one config line, not a code change. `bun test` never calls a
// real planner: the tests score the RECORDED plans (scoreRecorded below), which
// is also the ablation that proves the scorers still work.

export interface CaseResult {
  caseId: string;
  goal: string;
  wakeReason: string;
  scores: ScoreResult[];
  promptChars: number;
  responseChars: number;
  model?: string;
}

export interface ScorerTally {
  scorer: string;
  pass: number;
  fail: number;
  abstain: number;
  /** pass / (pass + fail). null when every case abstained -- an unmeasured scorer, not a perfect one. */
  passRate: number | null;
}

export interface EvalReport {
  cases: CaseResult[];
  perScorer: ScorerTally[];
  thrash: ScoreResult;
  /** Decided checks passed / decided checks. Abstentions are EXCLUDED, never counted as failures (M-34). */
  overall: number | null;
  decided: number;
  promptChars: number;
  responseChars: number;
  estimatedCostUsd: number;
  /** USD per passed check -- the cost-normalized number a model comparison actually turns on. */
  costPerPassedCheck: number | null;
}

/** Score a recorded plan per case. No planner, no tokens -- the regression path. */
export function scoreRecorded(cases: EvalCase[]): EvalReport {
  const results: CaseResult[] = [];
  for (const c of cases) {
    if (!c.recordedPlan) continue;
    results.push(caseResult(c, c.recordedPlan, 0, 0, undefined));
  }
  return summarize(results);
}

/** Score a live planner over the cases. The ONLY path that calls a model. */
export async function runEval(cases: EvalCase[], planner: Planner): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const res = await planner.plan(c.ctx);
    const candidate: CandidatePlan = {
      goal: res.plan.goal,
      steps: res.plan.steps.map((s) => ({ ...s, params: s.params as Record<string, unknown> })),
    };
    results.push(caseResult(c, candidate, res.promptChars, res.responseChars, res.model));
  }
  return summarize(results);
}

function caseResult(
  c: EvalCase, plan: CandidatePlan, promptChars: number, responseChars: number, model: string | undefined,
): CaseResult {
  return {
    caseId: c.id,
    goal: plan.goal,
    wakeReason: c.ctx.wake.reason,
    scores: scorePlan(plan, c),
    promptChars, responseChars, model,
  };
}

function summarize(results: CaseResult[]): EvalReport {
  const perScorer: ScorerTally[] = SCORERS.map((s) => ({ scorer: s({ goal: "", steps: [] }, EMPTY_CASE).scorer, pass: 0, fail: 0, abstain: 0, passRate: null }));
  const byName = new Map(perScorer.map((t) => [t.scorer, t]));
  for (const r of results) {
    for (const s of r.scores) {
      const t = byName.get(s.scorer);
      if (!t) continue;
      t[s.verdict]++;
    }
  }
  for (const t of perScorer) {
    const decided = t.pass + t.fail;
    t.passRate = decided ? t.pass / decided : null;
  }
  const thrash = scoreGoalDiversity(results.map((r) => ({ wakeReason: r.wakeReason, goal: r.goal })));
  const pass = perScorer.reduce((n, t) => n + t.pass, 0) + (thrash.verdict === "pass" ? 1 : 0);
  const fail = perScorer.reduce((n, t) => n + t.fail, 0) + (thrash.verdict === "fail" ? 1 : 0);
  const decided = pass + fail;
  const promptChars = results.reduce((n, r) => n + r.promptChars, 0);
  const responseChars = results.reduce((n, r) => n + r.responseChars, 0);
  const estimatedCostUsd = results.reduce(
    (n, r) => n + estimateCostUsd(r.promptChars, r.responseChars, r.model), 0,
  );
  return {
    cases: results,
    perScorer,
    thrash,
    overall: decided ? pass / decided : null,
    decided,
    promptChars,
    responseChars,
    estimatedCostUsd,
    costPerPassedCheck: pass ? estimatedCostUsd / pass : null,
  };
}

// A scorer's NAME is the one thing we need before any case has been scored (to
// build the tally table). Every scorer returns its name on any input, including
// this empty one -- so the table is derived from the scorer list itself and can
// never drift from it.
const EMPTY_CASE: EvalCase = {
  id: "",
  ctx: { persona: "", goals: [], wake: { reason: "no_plan" }, statusSummary: "", recentEvents: [] },
};

export function formatReport(r: EvalReport, label: string): string {
  const pct = (v: number | null) => (v === null ? "  n/a" : `${(v * 100).toFixed(0).padStart(4)}%`);
  const lines: string[] = [
    `Offline planner eval -- ${label}`,
    `${r.cases.length} case(s), ${r.decided} decided check(s)`,
    "",
    "scorer                        pass fail abst   rate",
  ];
  for (const t of r.perScorer) {
    lines.push(
      `${t.scorer.padEnd(28)} ${String(t.pass).padStart(4)} ${String(t.fail).padStart(4)} ` +
      `${String(t.abstain).padStart(4)} ${pct(t.passRate)}`,
    );
  }
  lines.push(`${"goal_diversity (sequence)".padEnd(28)} ${r.thrash.verdict.toUpperCase()} -- ${r.thrash.reason}`);
  lines.push("");
  for (const c of r.cases) {
    const fails = c.scores.filter((s) => s.verdict === "fail");
    if (!fails.length) continue;
    lines.push(`FAIL ${c.caseId} ("${c.goal}")`);
    for (const f of fails) lines.push(`  ${f.scorer}: ${f.reason}`);
  }
  lines.push("");
  lines.push(`OVERALL ${pct(r.overall)}  (abstentions excluded -- an unmeasurable check is never a failure)`);
  lines.push(
    `COST    $${r.estimatedCostUsd.toFixed(4)} (${r.promptChars} prompt / ${r.responseChars} response chars)` +
    (r.costPerPassedCheck !== null ? `  =  $${r.costPerPassedCheck.toFixed(5)} per passed check` : ""),
  );
  return lines.join("\n");
}

// --- CLI --------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE = `bun run eval:planner [options]

  --cases <path>       eval cases JSON (default test/fixtures/eval-cases.json)
  --recorded           score each case's RECORDED plan; calls no model (default when no --provider)
  --provider <p>       mock | claude-subscription | codex-subscription | ollama | openai-compat  -- calls that planner LIVE
  --model <m>          model id for the provider
  --base-url <url>     openai-compat base url
  --api-key-file <p>   optional bearer-token file for openai-compat
  --secrets <dir>      secrets dir (default secrets)
  --ollama-url <url>   default http://127.0.0.1:11434

  --harvest <db.sqlite> --agent <id> [--out <path>]   harvest cases from an events DB and exit`;

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes("--help")) { console.log(USAGE); return; }

  const harvestDb = flag(args, "harvest");
  if (harvestDb) {
    const agentId = flag(args, "agent");
    if (!agentId) { console.error("--harvest needs --agent <id>"); process.exit(2); }
    const cases = harvestCases(harvestDb, agentId);
    const out = flag(args, "out");
    const json = JSON.stringify(cases, null, 2);
    if (out) { writeFileSync(out, json); console.log(`harvested ${cases.length} case(s) -> ${out}`); }
    else console.log(json);
    return;
  }

  const cases = loadCases(flag(args, "cases") ?? "test/fixtures/eval-cases.json");
  const provider = flag(args, "provider");
  if (!provider || args.includes("--recorded")) {
    console.log(formatReport(scoreRecorded(cases), "recorded plans (no model called)"));
    return;
  }
  const spec: PlannerSpec = {
    provider: provider as PlannerSpec["provider"],
    model: flag(args, "model"),
    base_url: flag(args, "base-url"),
    api_key_file: flag(args, "api-key-file"),
  };
  const planner = makePlanner(spec, {
    secretsDir: flag(args, "secrets") ?? "secrets",
    ollamaUrl: flag(args, "ollama-url") ?? "http://127.0.0.1:11434",
  });
  const report = await runEval(cases, planner);
  console.log(formatReport(report, `${spec.provider}${spec.model ? ` / ${spec.model}` : ""}`));
  // A failing candidate must not merely print red -- exit non-zero so this can
  // gate a model swap (issue #263: "no further live model swap until #263 gates
  // it") from a script without a human reading the table.
  if (report.overall !== null && report.overall < 1) process.exit(1);
  if (report.thrash.verdict === "fail") process.exit(1);
}

if (import.meta.main) await main();
