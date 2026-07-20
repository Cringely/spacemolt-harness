# Security controls register — SSDF + SLSA + OpenSSF Scorecard

This page is the project's control register: which security framework(s) we align to, which
controls implement them, how strongly each is enforced, and where the gaps are. It was produced
by a two-seat security team (framework analyst + read-only posture auditor, 2026-07-13; decision
entry in `docs/decisions.md`) at operator direction. `security-baseline.md` remains the policy —
this page is the *evidence map* against external frameworks.

## Adopted frameworks, and the job each one does

- **NIST SSDF (SP 800-218, with 800-218A as the AI lens)** — the practice checklist and shared
  vocabulary. Its practice groups (PO prepare, PS protect software, PW produce well-secured, RV
  respond to vulnerabilities) are the audit bar at milestone gates. SSDF is the enduring US
  procurement standard (EO 14028 lineage), so conformance literacy is itself a transferable skill
  this project exists to build.
- **SLSA Build track — landed at L2, "L3-shaped"** (operator reframe on #171: the control, not
  the level) — the one new *enforced* technical control: provenance attestation generated in CI,
  verified **fail-closed** by the pull-based deployer before any image runs. Digest-pinning
  proves *which* image; provenance proves *how it was built*. Native GitHub attestations (the
  L3 path) need Enterprise Cloud on private repos — entitlement verified absent, so the signer
  is key-based cosign (key held only in Actions secrets), honestly labeled L2.
- **OpenSSF Scorecard (selected checks, CLI, no badge)** — the continuous-enforcement layer:
  converts convention-only repo invariants (pinned SHAs, least-privilege tokens, no
  `pull_request_target`) from "reviewed at gates" to machine-checked on every change. Private
  repo: CLI/JSON only; the aggregate score, badge, and publish API are public-repo signaling we
  deliberately ignore.

**Rejected, with reasons** (full analysis in the decision entry): NIST CSF 2.0 (org-risk
governance for boards/insurers this project doesn't have — awareness, not fixes), OWASP SAMM
(maturity-interviews a human org; would score us on ceremony we deliberately declined), OpenSSF
Best Practices Badge (public-signaling questionnaire), Allstar (fleet policy app; for one repo
it's a third-party write-access grant that duplicates a scheduled Scorecard run).

## Control inventory (strength: CODE = enforced-by-code · CI = enforced-by-CI · CONV = convention-only)

| Theme | Control | Strength | Framework ref | Evidence |
|---|---|---|---|---|
| Supply chain | 1 runtime dep (zod); frozen lockfile everywhere | CODE | SSDF PW.4 / Scorecard Pinned-Deps | package.json; Dockerfile:30,46; container.yml:66 |
| Supply chain | `bun audit` fails the image build | CI | SSDF RV.1 / Scorecard Vulnerabilities | scripts/preflight.ts:11 |
| Supply chain | Base images by digest; CLI by version, npm-not-curl; apt limited to ca-certificates (unpinned by design — see 2026-07-17 delta) | CODE | SLSA dependencies / SSDF PW.4 | Dockerfile:20-30,66-74; test/image-contents.test.ts |
| Supply chain | Actions pinned to commit SHAs | CI | Scorecard Pinned-Deps | container.yml:65,78,112,121,140; enforced continuously by the security.yml scorecard gate |
| Supply chain | Dependency-change-as-task (no agent runs `bun add`) | CONV → #210 | SSDF PW.4.1 | security-baseline.md:13 |
| CI/CD | `pull_request` never `pull_request_target`; fork PRs read-only | CI | Scorecard Dangerous-Workflow | container.yml:10-13,73 |
| CI/CD | Least-privilege tokens; `packages:write` publish-only | CI | SSDF PS.1 / Scorecard Token-Permissions | container.yml:43-44,107-110 |
| CI/CD | Test gate travels in the Dockerfile (unbypassable) | CODE | SSDF PW.8 | Dockerfile:32-39 |
| CI/CD | Image provenance + fail-closed deploy verification | CI (signing live) + **pending host-apply** — #171 | SLSA Build L2 ("L3-shaped") | container.yml:126-185 (push→attest→release ordering); deployer gate + cosign public key live in the operator's private GitOps repo |
| Secrets | Gitignored `secrets/`, env-inheritance only, none in build | CONV+CI | SSDF PS.1 | security-baseline.md:9; container.yml:20 |
| Secrets | Full-history gitleaks scan: every push, PR, weekly; any hit fails | CI | SSDF PS.1 / RV | security.yml gitleaks job (binary pinned + checksummed) |
| Runtime | Non-root UID, nologin; HTTP bounds (limit clamp, hours allowlist, 500-char instruct) | CODE | SSDF PW.6 | Dockerfile:57-58; server.ts:25-38,46-50,101-118 |
| Runtime | Compose hardening (`no-new-privileges`, `cap_drop` ALL, `read_only`, no published ports, secrets via files) | CODE (host) | SSDF PW.6 | production compose + its drift-check now live in the operator's private GitOps repo; the in-repo drift-checker was retired 2026-07-20 with the compose's relocation (#478 re-homes it to the private CI); see the 2026-07-20 delta |
| LLM boundary | All game text quoted+truncated; standing "never instructions" rule; identity canary; PlanSchema + registry-only executor backstops | CODE | SSDF 800-218A (untrusted input / AI-output review) | digest.ts:20-33,216-224; security-baseline.md:27 |
| Access | Main PR-only (versioned pre-push hook) | CODE (local) | Scorecard Branch-Protection (false-negative: hook invisible to it — documented, not fixed) | .githooks/pre-push:7-11 |
| Access | Dashboard in-process authn (second barrier behind the reverse proxy and SSO): shared-secret `X-Dashboard-Token` required on every route, constant-time compare, fail-closed startup | CODE (implemented, **pending deploy** — #173) | SSDF PW.6 / defense-in-depth rule | server.ts:131-133 (gate before routing), server.ts:66-91 (fail-closed loader), server.ts:95-102 (sha256+timingSafeEqual); secret + reverse-proxy header injection in the production compose (operator's private GitOps repo) |
| Detect | Chain-integrity halt authority (any agent, non-overridable pre-triage) | CONV | SSDF RV / CSF-Detect analog | team-structure.md security function |
| Recover | Health-gated auto-deploy, auto-rollback to pinned sha7 | infra | SSDF RV.2 | decisions.md (auto-deploy entry) |

**Known accepted risks** (per the deployment-proportionality rule): prompt-injection residual
(bounded by structural backstops, honestly documented); Scorecard's Branch-Protection
false-negative on private repos; no SBOM (single consumer, one dependency); the enterprise
control families deliberately skipped (risk register, SoD, IR tabletops — one human, no SOC).

## Oversight (how this stays alive — countermeasures from the analyst's pre-mortem)

The pre-mortem for this adoption is specific: the mapping becomes a wiki page nobody re-audits,
and deploy verification gets left warn-only after one false positive. The countermeasures are
structural, not aspirational:

1. **Deploy-time provenance verification ships fail-closed from day one** (#171). A verification
   that only warns is a verification that doesn't exist.
2. **The SSDF gap analysis is a dated milestone-gate artifact.** At every plan gate the security
   audit produces a delta against this register (what moved tier, what regressed), appended —
   not overwritten — so drift is visible. An audit that doesn't update this page didn't happen.
3. **Scorecard regression job** (#172, live in security.yml) machine-checks the repo-hygiene
   invariants on every push to main and weekly: Dangerous-Workflow and action-SHA-pinning fail
   the job, everything else is a reported score. (The issue's committed-baseline-JSON sketch was
   dropped at implementation — see the 2026-07-14 #172 delta below for why.)
4. **Security-relevant PR classes get the security lens**: changes touching workflows,
   Dockerfile, secrets handling, the HTTP surface, or the LLM boundary are flagged in the PR
   body and the reviewer brief includes the relevant register rows (charter work, #164).

## Register deltas (appended, never overwritten)

- **2026-07-13 — #173 closed in code, pending deploy.** The dashboard's in-process second
  barrier (ranked gap #1 of the posture audit) moved GAP → CODE. What landed: every route in
  `src/server/server.ts` — HTML, API reads, `POST /instruct`, the WS upgrade — now requires an
  `X-Dashboard-Token` header matching a secret loaded at startup from a `_FILE`-style path
  (`HARNESS_DASHBOARD_TOKEN_FILE`), compared constant-time (sha256 both sides, then
  `timingSafeEqual`, so neither value nor length leaks). Startup is fail-closed but deploy-safe:
  knob set with a missing/empty file refuses to start; knob absent starts open with one loud
  warning, so the health-gated auto-deploy can ship this image before the host secret exists.
  The reverse proxy stamps the header at the proxy (a custom-request-header middleware,
  after the SSO forward-auth), so the browser flow through the SSO provider is unchanged while direct
  front-network calls get 401. "Pending deploy" means: the barrier is live only once the PM
  provisions `${SECRETSDIR}/spacemolt/dashboard_token` + `DASHBOARD_TOKEN` in the stack `.env`
  and applies the updated compose (APPLY.md steps 1 and 3). Residual accepted: the token value
  transits the host-side `.env` and container labels (reverse-proxy labels have no `_FILE` mechanism)
  — exposure equivalent to what docker-inspect access already grants; documented in
  `.env.example` and both compose files. Staging deliberately stays disabled (no reverse proxy there
  to inject the header; LAN-IP bind remains its control).
- **2026-07-13 — #173 delta: the healthcheck is a caller too.** Deploying the barrier image
  (PR #202, ea2c134) flapped production: the Dockerfile HEALTHCHECK hit `/api/agents` with no
  token, got 401, the container went unhealthy, the health-gated auto-deploy rolled back, and
  the cron re-detected the new image — an infinite rollback loop. Fix (producer-side, in the
  HEALTHCHECK CMD): when `HARNESS_DASHBOARD_TOKEN_FILE` is set, the check reads it and sends
  `X-Dashboard-Token`; unset, it sends no header. Side effect: a mis-provisioned token file
  now shows up as UNHEALTHY instead of silently wrong, converting PR #202's named residual
  (no detection for barrier misconfig) into detection.
- **2026-07-14 — #171: provenance CI-side closed, deployer gate designed pending host-apply.**
  The SLSA row moved GAP → CI + pending-host-apply. What landed: the publish job now pushes the
  sha7 tag, signs a SLSA v1 provenance attestation against the exact pushed digest with
  key-based cosign v2.6.3 (`--tlog-upload=false` — private repo, nothing to public Rekor), and
  only THEN releases the `latest-main` rolling tag, so the deployer's watched tag can never
  point at an unattested digest. Entitlement finding that set the design: GitHub-native
  attestations require Enterprise Cloud on private repos (this is a personal-plan private repo),
  so `actions/attest-build-provenance` + `gh attestation verify` were unavailable — key-based
  cosign per the issue's named fallback, landing at L2 "L3-shaped" per the operator's
  the-control-not-the-level calibration. Signing key: generated 2026-07-14, private half only in
  Actions secrets (`COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD`) + the operator's gitignored
  `secrets/`; public half committed under the `deploy/` production tree (relocated
  2026-07-20 to the operator's private GitOps repo). "Pending
  host-apply" means: the fail-closed gate in `spacemolt-redeploy.sh` (verify before pull/pin/up;
  failure = keep running image + urgent ntfy; rollback skips only the attestation check while
  keeping the local digest-identity recheck against the digest persisted at its original verify;
  pulled-tag digest re-checked against the verified digest to close the tag-swap window) is a
  complete runbook (relocated 2026-07-20 to the operator's private GitOps repo) that the
  PM applies there — apply AFTER the first signed image publishes. Until then images are
  signed but unverified. Residual: the predicate is workflow-self-attested (no isolated builder
  = the L3 gap); a long-lived key can be exfiltrated where keyless identity can't — accepted,
  it's the only path that keeps a private repo out of the public transparency log without
  Enterprise entitlements. NOT covered here: the dependency-change-as-task CI gate the issue
  folded in — split out to #210 (row above now CONV → #210), which carries that remainder with
  its own severity/policy decision.
- **2026-07-14 — #172 closed: the continuous-enforcement layer is live, and the compose row was
  stale.** Three CI checks landed in `.github/workflows/security.yml` — a separate workflow on
  purpose (container.yml owns build/publish and the concurrent #171 provenance change owns that
  file). (1) **Scorecard** on push-to-main + weekly, private-repo mode (no publish/badge; JSON
  consumed in the job log and stored as an artifact). Report-only EXCEPT two hard gates:
  Dangerous-Workflow must score 10, and any "GitHubAction not pinned by hash" finding fails.
  The issue sketched a committed baseline JSON; dropped at implementation — scorecard output
  embeds run dates and commit SHAs so a byte-baseline churns every run, and a score-threshold
  baseline can mask an action-pinning regression behind an unrelated improvement in the same
  check. Gating the two invariants directly is smaller and names what it protects. (2)
  **gitleaks** v8.30.1 (binary version-pinned and checksum-verified) over the full history on
  every push, PR, and weekly; adoption-day verification: 255 commits scanned, no leaks
  (2026-07-14). Any finding fails the job. (3) The **compose drift-check**
  (`scripts/check-compose-hardening.ts`), wired BOTH into `bun test` (fastest seam: fails on a
  developer's machine pre-commit) and as a security.yml job (container.yml's path gate excludes
  `deploy/**`, so a compose-only PR needs its own CI hook). This drift-check was retired
  2026-07-20 when its subject compose left the repo; see the 2026-07-20 delta below and #478.
  **Re-baseline:** the compose row's
  "asserted, unverified in-repo" claim was stale when this work started — the hardening has been
  in-repo since the #173 stack landed (compose.yaml:29-33: `no-new-privileges`, `cap_drop: ALL`,
  `read_only`; line 131: deliberately no `ports:`). Row moved CONV → CODE+CI.
  `docker-compose.staging.yml` is deliberately NOT drift-checked: its published LAN-IP-bound
  port (line 54) is the receipted staging control. Remaining from the issue's trailing "Also"
  line: the bun-audit severity policy in preflight — not shipped here (needs its own policy
  decision; flagged in the PR).
- **2026-07-14 — gitleaks allowlist for the vendored upstream docs (`.gitleaks.toml`).** The
  game-reference vendoring (#217) turned main's gitleaks job red: 6 `generic-api-key` findings,
  all in `docs/game-reference/upstream/api.md` (lines 360, 614, 666, seen twice because the scan
  covers history and the tree landed in two commits). Every one is the game's own placeholder in
  its login example — a `"password"` field whose value is a hex-looking placeholder literal (the
  exact string is in the allowlist regex in `.gitleaks.toml`; it is deliberately NOT repeated here,
  because quoting a secret-shaped literal in our own prose makes our own doc trip the scanner —
  which is exactly what happened on the first attempt) — not a credential.
  The gate keeps its "any finding fails" posture; what changed is one narrow allowlist in a new
  repo-root `.gitleaks.toml`, and the config is an AND of two conditions: the finding must sit
  under `docs/game-reference/upstream/` AND its secret must be the literal `a1b2c3d4e5f6...`
  placeholder. The path half is honest because that tree is written byte-for-byte from the game's
  public docs by `scripts/refresh-game-reference.ts` and is never hand-authored, so a secret of
  ours cannot legitimately originate there. The regex half is what keeps it from becoming a
  blind spot: a path-only rule would hide any secret shape anywhere in that tree — including one
  upstream might someday publish, or one a bad merge drops in. **Scope, stated plainly:** this
  allowlist can hide exactly one string, in exactly one directory. It cannot hide a real secret
  in `src/`, `deploy/`, `secrets/`, `.env`, any other doc, or any other value in the vendored
  tree. Its brittleness is deliberate — if upstream rewrites its example, the job goes red again
  and a human re-reads the new text, which is the review we want. Verified with gitleaks v8.30.1
  (the CI-pinned version) over all 283 commits: 0 findings with the config; a planted 64-hex
  secret in `src/config.ts` AND a second one planted inside the allowlisted upstream tree were
  both still caught (exit 1), so the gate is muted, not disabled.
- **2026-07-17 — #356: the runtime image gains its first apt-installed OS package
  (ca-certificates).** The codex CLI (a Rust binary) failed every HTTPS call in production
  because `node:22-bookworm-slim` ships an empty `/etc/ssl/certs`; node, bun, and the claude CLI
  bundle their own Mozilla roots, so no other path ever exercised the system store. The fix
  installs `ca-certificates` in the runtime stage (single RUN, `--no-install-recommends`, apt
  lists cleaned), pinned by a drift test in test/image-contents.test.ts. This is a new
  supply-chain surface the existing rows did not cover: those name base-image digests, npm
  version pins, and the frozen lockfile, none of which speak to apt packages. Posture: the
  package is deliberately version-unpinned — a CA store is trust and revocation data whose value
  is Debian's security updates, and freezing it would defeat the fix. Scope guard: the
  containerize plan's rejection of apt for toolchain packages stands; ca-certificates is the one
  exception because no npm-installable or cross-stage-COPY substitute safely matches the runtime
  stage's own libc/openssl. Decision entry: docs/decisions.md 2026-07-17 (#356).
- **2026-07-20 — operational deploy artifacts relocated out of this repo (public-repo prep).**
  The `deploy/` production tree (production compose, `APPLY.md`, `APPLY-provenance.md`,
  cosign public key) and `docs/wiki/scheduler-runbook.md` were operational runbooks for the
  operator's private infrastructure with near-zero public value and a concentration of topology detail
  (internal IPs, GitOps paths, secret-directory layout). They now live in the operator's private
  GitOps repo; this register's cross-links to them re-point there. The controls themselves are
  unchanged (they run on the host); only the in-repo reference copies moved. Follow-on: the
  compose-hardening drift-checker (`scripts/check-compose-hardening.ts` + its test + the
  `security.yml` job) guarded the relocated compose. With its subject gone its `bun test` case
  already skipped (the `skipIf` for the container build context, so zero coverage) while the CLI
  and the `security.yml` job would fail closed with no file to read. **Resolved 2026-07-20: the
  checker trio was retired** rather than repointed at the private compose — the drift gate now
  belongs beside the file it guards. #478 re-homes an equivalent check to the private GitOps CI;
  until #478 is done, the invariant rides on manual review of the private compose.
