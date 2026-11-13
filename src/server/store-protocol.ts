// Constants shared by the store API's two ends: the harness server
// (src/server/server.ts) and the scheduler-side caller (scripts/strategy-store.ts).
//
// Deliberately ZERO imports. scripts/strategy-store.ts is the strategy job's
// gate, and the job reads its exit code as 1 = skip, 2 = error. It used to
// import these from server.ts, whose import graph pulls in zod; a checkout
// with a missing or mismatched node_modules then crashed the script at import
// time, before any catch could run, and bun's uncaught-exception exit (1) read
// as a SKIP, so the review silently never ran (Cringely/spacemolt#1139,
// #1143). Keep this module free of imports so the caller's graph stays zod-free.

// docs/wiki/security-baseline.md: "The dashboard instruction box gets a
// length bound -- it's a prompt-injection channel into our own planner,
// contained but worth the guard." 500 chars covers a real operator directive
// (a sentence or two) while bounding how much attacker-adjacent text can ride
// into Agent.replan()'s goals.push(instruction) -> digest.ts prompt splice
// per call. Enforced server-side (the trust boundary); the scheduler caller
// imports the SAME number to fail fast: one bound, two enforcement points.
export const INSTRUCTION_MAX_LENGTH = 500;

// #114 A1: the store API's own bearer header, a SEPARATE secret from the
// dashboard token -- different consumer (the scheduler host's cron job), so a
// leak of one credential never grants the other's access.
export const STORE_TOKEN_HEADER = "X-Store-Token";
