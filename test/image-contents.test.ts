import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Drift gate for #290: the charters tell an operator to run
// `docker exec ... bun run scripts/strategy-review-gate.ts` (and the matching
// -mark.ts cursor writer), but the runtime image shipped /app/src only --
// 'Module not found' at the very first gated strategy review, and without the
// marker CLI the review cursor could never advance (every future gate returns
// run=true). #280's "active once the next image deploys" assumption was wrong
// because nothing pinned the image contents to what the charters reference.
// This test pins it: the runtime stage must COPY scripts/.
//
// Container-context gate (same convention as roadmap-drift.test.ts): the
// Dockerfile's test stage does not copy the Dockerfile itself, so inside the
// image build this input is absent -- skip there. Every developer `bun test`
// and repo CI still run it, which is where Dockerfile edits happen.
const dockerfilePath = join(import.meta.dir, "..", "Dockerfile");
const dockerfilePresent = existsSync(dockerfilePath);
const dockerfile = dockerfilePresent
  ? readFileSync(dockerfilePath, "utf8").replace(/\r\n/g, "\n")
  : "";

describe.skipIf(!dockerfilePresent)("runtime image contents (#290)", () => {
  test("the runtime stage ships scripts/ so chartered CLIs can run in the container", () => {
    // Slice from the runtime stage's FROM: an earlier stage copying scripts/
    // (the test stage already does) must not satisfy this gate.
    const runtimeStart = dockerfile.indexOf("AS runtime");
    expect(runtimeStart).toBeGreaterThan(-1);
    const runtime = dockerfile.slice(runtimeStart);
    expect(runtime).toMatch(/^COPY scripts \.\/scripts$/m);
  });

  test("the runtime stage installs ca-certificates (codex reads the system TLS store)", () => {
    // codex (Rust) resolves TLS roots from /etc/ssl/certs; node/bun/claude
    // bundle their own, so nothing else catches the omission — codex just
    // fails every HTTPS call at runtime ("error sending request",
    // prod 2026-07-17). Slice from the runtime FROM: an install in an
    // earlier stage ships nothing to the final image.
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtime).toMatch(/apt-get install -y --no-install-recommends ca-certificates/);
  });

  test("the chartered gate CLIs exist where the charters point", () => {
    // The two container-run CLIs named by docs/charters/strategy-reviewer.md.
    // If they move (e.g. under src/), the charters and the COPY above must
    // move with them -- this failure is the reminder.
    expect(existsSync(join(import.meta.dir, "..", "scripts", "strategy-review-gate.ts"))).toBe(true);
    expect(existsSync(join(import.meta.dir, "..", "scripts", "strategy-review-mark.ts"))).toBe(true);
  });
});
