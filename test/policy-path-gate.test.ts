// D3 policy-path fence (#114, stage-1 plan Batch B) — offline tests.
//
// The fence: when the headless service user (SERVICE_USER) commits, every
// staged path must sit on HEADLESS_WRITE_ALLOWLIST (the doc-steward surface).
// ALLOWLIST semantics are the load-bearing part: anything not listed is
// rejected, so a novel path fails closed instead of leaking through a stale
// denylist. POLICY_PATHS (charters, briefs, guardrails, AGENTS.md) is the
// council's fence list; the disjointness test here is what keeps a future
// allowlist edit from silently re-opening that leak.
//
// Pure-fn tests hit src/scheduler/policy-paths.ts directly; CLI tests spawn
// scripts/policy-path-gate.ts against a temp git repo (isolated git config,
// zero network). Headless simulation uses POLICY_GATE_TEST_USERNAME — the
// one-directional test override documented in the gate script header: it can
// only ADD headlessness, never hide the real service user.

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HEADLESS_WRITE_ALLOWLIST,
  POLICY_PATHS,
  SERVICE_USER,
  checkStagedEntries,
  checkStagedPaths,
  isHeadless,
  parseStagedRaw,
  pathMatchesPattern,
} from "../src/scheduler/policy-paths";

// --- pure fn ----------------------------------------------------------------

describe("checkStagedPaths — allowlist semantics", () => {
  test("a staged charter path is rejected — the (c) leak, highest-severity pre-mortem seal", () => {
    const r = checkStagedPaths(["docs/charters/soc-monitor.md"]);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual(["docs/charters/soc-monitor.md"]);
  });

  test("novel paths are rejected — allowlist never decays into a denylist", () => {
    // Neither path is a policy path; they are simply NOT ON THE LIST. If this
    // test starts passing paths through, the fence has become a denylist.
    const r = checkStagedPaths(["src/x.ts", "docs/wiki/new-page.md"]);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual(["src/x.ts", "docs/wiki/new-page.md"]);
  });

  test("the doc-steward surface passes — fence must not over-block legitimate steward PRs", () => {
    const r = checkStagedPaths([
      "docs/STATE.md",
      "docs/milestones.md",
      // nested ** entries: catches the glob matcher breaking (e.g. an exact-
      // match regression) and stranding steward asset/archive commits
      "docs/assets/road-to-fleet/wave-3.svg",
      "docs/archive/decisions-2026-07.md",
    ]);
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([]);
  });

  test("only the service username is headless — fence must not brick workstation commits", () => {
    expect(isHeadless(SERVICE_USER)).toBe(true);
    expect(isHeadless("workstation-user")).toBe(false);
    expect(isHeadless("")).toBe(false);
  });

  test("a symlink staged at an allowlisted path is rejected — the mode is checked, not just the path string", () => {
    // A 120000 index entry at docs/STATE.md aliases an arbitrary file; on the
    // Linux deploy target the steward's next legitimate STATE write would
    // mutate the aliased charter through the link.
    const r = checkStagedEntries([{ mode: "120000", path: "docs/STATE.md" }]);
    expect(r.ok).toBe(false);
    expect(r.rejected[0]).toContain("docs/STATE.md");
    expect(r.rejected[0]).toContain("120000");
  });

  test("deleting an allowlisted path stays allowed — a deletion lands nothing; archival moves must not brick", () => {
    expect(checkStagedEntries([{ mode: "000000", path: "docs/assets/old.svg" }]).ok).toBe(true);
  });

  test("parseStagedRaw refuses rename records — if --no-renames ever regresses, the gate fails closed, not open", () => {
    // R record shape (two paths). Impossible while the gate passes
    // --no-renames; if that flag is ever dropped this null keeps the failure
    // a refusal instead of a destination-only check.
    expect(parseStagedRaw(":100644 100644 abc123 def456 R100\0src.md\0dst.md\0")).toBeNull();
  });

  test("POLICY_PATHS and HEADLESS_WRITE_ALLOWLIST are disjoint — a future allowlist edit cannot re-open the leak", () => {
    // Probe path: a concrete path each pattern certainly matches. Checking
    // probes in BOTH directions covers every shape pair (exact vs exact,
    // exact under a **, ** nested under a **).
    const probe = (pattern: string) =>
      pattern.endsWith("/**") ? `${pattern.slice(0, -2)}__probe__` : pattern;
    for (const policy of POLICY_PATHS) {
      expect(
        HEADLESS_WRITE_ALLOWLIST.some((allow) => pathMatchesPattern(probe(policy), allow)),
      ).toBe(false);
    }
    for (const allow of HEADLESS_WRITE_ALLOWLIST) {
      expect(POLICY_PATHS.some((policy) => pathMatchesPattern(probe(allow), policy))).toBe(false);
    }
  });
});

// --- CLI against a temp git repo -------------------------------------------

const root = join(import.meta.dir, "..");
const GATE = join(root, "scripts", "policy-path-gate.ts");
const MODULE = join(root, "src", "scheduler", "policy-paths.ts");
const HOOK = join(root, ".githooks", "pre-commit");

// Shim bun-absent branch: driven by invoking sh on the hook under a PATH that
// holds git but NOT bun, so `command -v bun` fails and the shim falls to its
// sh-side username check. Needs a resolvable sh and a git dir that does not
// also contain a bun binary; otherwise those two tests skip.
const shPath = Bun.which("sh");
const gitExe = Bun.which("git");
const gitDir = gitExe === null ? null : dirname(gitExe);
const bunFreePath =
  shPath !== null && gitDir !== null && Bun.which("bun", { PATH: gitDir }) === null
    ? gitDir
    : null;

const gitOk = (() => {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();
// The pre-commit hook is a sh script. git-for-windows runs hooks through its
// own bundled sh, so on win32 a PATH probe for `sh` proves nothing; probe on
// POSIX only (image context: L-20 class, skip when the runtime lacks git/sh).
const shOk =
  process.platform === "win32"
    ? true
    : (() => {
        try {
          return spawnSync("sh", ["-c", "exit 0"]).status === 0;
        } catch {
          return false;
        }
      })();

/** Temp git repo with fully isolated config (no global hooksPath/gpgsign/
 *  templateDir leaking in) and the gate + module + shim copied at the repo
 *  layout the shim's `exec bun scripts/policy-path-gate.ts` and the script's
 *  relative import expect — the same wiring production gets. */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "policy-gate-"));
  const emptyCfg = join(dir, "empty-gitconfig");
  writeFileSync(emptyCfg, "");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyCfg,
    GIT_CONFIG_SYSTEM: emptyCfg,
  };
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  const put = (rel: string, content: string) => {
    mkdirSync(join(repo, dirname(rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  };
  /** Run the gate CLI as the hook would: cwd = repo root. */
  const gate = (headless: boolean) =>
    spawnSync(process.execPath, [GATE, "--staged"], {
      cwd: repo,
      env: headless ? { ...env, POLICY_GATE_TEST_USERNAME: SERVICE_USER } : env,
      encoding: "utf8",
    });
  git("init", "--initial-branch=main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.hooksPath", ".githooks");
  // Production layout: the shim resolves the repo root and runs the checkout's
  // own copy of the gate, so the fixture carries both files.
  mkdirSync(join(repo, "scripts"));
  copyFileSync(GATE, join(repo, "scripts", "policy-path-gate.ts"));
  mkdirSync(join(repo, "src", "scheduler"), { recursive: true });
  copyFileSync(MODULE, join(repo, "src", "scheduler", "policy-paths.ts"));
  // Install the real shim (B2). Guarded copy so a missing hook file shows up
  // as the true failure — the headless commit below LANDING — not an ENOENT.
  if (existsSync(HOOK)) {
    mkdirSync(join(repo, ".githooks"));
    copyFileSync(HOOK, join(repo, ".githooks", "pre-commit"));
    chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
  }
  return { repo, env, git, put, gate };
}

describe.skipIf(!gitOk || !shOk)("policy-path-gate CLI + pre-commit shim (temp git repo)", () => {
  let fx: ReturnType<typeof makeFixture>;

  beforeAll(() => {
    fx = makeFixture();
    fx.put("docs/charters/test-charter.md", "# charter v1\n");
    fx.put("docs/STATE.md", "# state v1\n");
    fx.git("add", "-A");
  });

  // Tests in this describe run in order and share the fixture: this first one
  // creates the initial commit the CLI tests diff against — and because the
  // shim is already installed, it IS the workstation-pass wiring test.
  test("hook: workstation commit staging a charter passes — fence must not brick normal dev commits", () => {
    const first = fx.git("commit", "-m", "scaffold");
    expect(first.status).toBe(0);
  });

  test("headless + staged charter: exit 1, reject named on stderr", () => {
    fx.put("docs/charters/test-charter.md", "# charter v2 (tampered)\n");
    fx.git("add", "docs/charters/test-charter.md");
    const r = fx.gate(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/charters/test-charter.md");
    fx.git("reset");
  });

  test("headless + staged steward surface: exit 0", () => {
    fx.put("docs/STATE.md", "# state v2\n");
    fx.git("add", "docs/STATE.md");
    const r = fx.gate(true);
    expect(r.status).toBe(0);
    fx.git("reset");
  });

  test("workstation + staged charter: exit 0 — fence dormant off the service user", () => {
    fx.put("docs/charters/test-charter.md", "# charter v3\n");
    fx.git("add", "docs/charters/test-charter.md");
    const r = fx.gate(false);
    expect(r.status).toBe(0);
    fx.git("reset");
  });

  // --- B2: the shim itself, end to end through `git commit` ----------------
  // Catches shim wiring rot (non-executable hook, wrong path resolution)
  // turning the fence decorative.

  test("hook: headless commit staging a charter is rejected and no commit lands", () => {
    fx.put("docs/charters/test-charter.md", "# charter v4 (tampered)\n");
    fx.git("add", "docs/charters/test-charter.md");
    const commit = spawnSync("git", ["commit", "-m", "tamper"], {
      cwd: fx.repo,
      env: { ...fx.env, POLICY_GATE_TEST_USERNAME: SERVICE_USER },
      encoding: "utf8",
    });
    expect(commit.status).not.toBe(0);
    expect(commit.stderr + commit.stdout).toContain("docs/charters/test-charter.md");
    // The block must be real, not stderr noise: still exactly one commit.
    expect(fx.git("rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
    fx.git("reset");
  });

  // --- review fixes: rename coalescing + non-file modes + service-user seam -

  test("headless rename of a charter into the allowlist: rejected, deleted charter path named — rename detection must not coalesce it away", () => {
    // Reviewer probe: `git mv` a charter, byte-identical, to an allowlisted
    // destination. Without --no-renames, git reports only the destination
    // path (allowlisted — the commit would land); the deleted charter path
    // must surface and reject.
    fx.git("reset", "--hard");
    mkdirSync(join(fx.repo, "docs", "archive"), { recursive: true });
    const mv = fx.git("mv", "docs/charters/test-charter.md", "docs/archive/smuggled.md");
    expect(mv.status).toBe(0);
    const r = fx.gate(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/charters/test-charter.md");
    fx.git("reset", "--hard");
  });

  test("headless symlink forged at an allowlisted path: rejected — a 120000 entry must not land even where the path is allowed", () => {
    // Forge the index entry directly (`update-index --cacheinfo`), so the
    // probe works regardless of host core.symlinks: a symlink blob staged AT
    // docs/STATE.md aliases the charter, and on the Linux deploy target the
    // steward's next STATE write would mutate the charter through the link.
    fx.put(".symlink-target.txt", "docs/charters/test-charter.md");
    const blob = fx.git("hash-object", "-w", ".symlink-target.txt").stdout.trim();
    const forge = fx.git("update-index", "--add", "--cacheinfo", `120000,${blob},docs/STATE.md`);
    expect(forge.status).toBe(0);
    const r = fx.gate(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/STATE.md");
    expect(r.stderr).toContain("120000");
    fx.git("reset", "--hard");
    rmSync(join(fx.repo, ".symlink-target.txt"));
  });

  // The bun-absent branch, spanning the service-user seam: headless is injected
  // with the TS SERVICE_USER const, so if the shim's SM_USER default ever
  // drifts from policy-paths.ts the headless run exits 0 and this fails.
  const runShimBunAbsent = (headless: boolean) => {
    const env: Record<string, string | undefined> = { ...fx.env };
    for (const k of Object.keys(env)) if (k.toLowerCase() === "path") delete env[k];
    env["PATH"] = bunFreePath ?? "";
    if (headless) env["POLICY_GATE_TEST_USERNAME"] = SERVICE_USER;
    return spawnSync(
      shPath ?? "sh",
      [join(fx.repo, ".githooks", "pre-commit").replaceAll("\\", "/")],
      { cwd: fx.repo, env, encoding: "utf8" },
    );
  };

  test.skipIf(bunFreePath === null)(
    "shim, bun absent + service user: exit 1 — the fence is never silently missing exactly where it matters",
    () => {
      const r = runShimBunAbsent(true);
      expect(r.stderr).toContain("bun not found");
      expect(r.status).toBe(1);
    },
  );

  test.skipIf(bunFreePath === null)(
    "shim, bun absent + workstation user: exit 0 — a degraded PATH must not brick dev commits",
    () => {
      const r = runShimBunAbsent(false);
      expect(r.status).toBe(0);
    },
  );

  // A 100644 hook is SILENTLY SKIPPED by git on Linux — the deploy host —
  // so the executable bit in the index is itself load-bearing wiring. Needs
  // the real repo's index; skip in the image context (.git excluded, L-20).
  const inRepo =
    gitOk &&
    spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    }).stdout?.trim() === "true";

  test.skipIf(!inRepo)("hook: .githooks/pre-commit is committed executable (100755)", () => {
    const r = spawnSync("git", ["-C", root, "ls-files", "-s", ".githooks/pre-commit"], {
      encoding: "utf8",
    });
    expect(r.stdout.split(" ")[0]).toBe("100755");
  });
});
