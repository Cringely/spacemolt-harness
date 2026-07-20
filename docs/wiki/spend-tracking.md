# Spend tracking: where our LLM tokens go

We run on a flat Claude subscription, not metered pay-per-call billing. That is cheaper, but it hides a number we still want: how much work each part of the system is burning through. This page explains the small tool that recovers that number.

## The problem

Two things spend our Claude quota. The first is the workstation sessions, meaning the PM loop and every subagent it dispatches, running here in Claude Code. The second is the durable scheduler on its own always-on host (a small system container), which fires headless `claude -p` jobs on a cron schedule. Neither hands us a dollar bill. But both write down how many tokens they used, and tokens have a published price, so we can reconstruct an estimate.

## The ledger

`spend-tally.ts` (in `scripts/`) reads both sources and writes one row per unit of spend into `spend-ledger.jsonl` at the repo root. That file is the single source of truth for spend, and it is gitignored: it is machine-local and never committed. Each row is small: the day, which source it came from, the model family, the token counts, and an estimated cost in US dollars.

The estimate is an API-equivalent value, not an invoice. It answers "if we had paid list price for these tokens, what would they have cost?" That makes it a proxy for how much quota a run consumed, useful for spotting which agents are expensive and how spend trends week to week. It is not what Anthropic charges us (the subscription is flat), so read it as a relative gauge, not a bank statement.

## Using it

```
bun scripts/spend-tally.ts sync     # pull both sources, update the ledger
bun scripts/spend-tally.ts report   # print today / last 7 days / total
```

`sync` reaches out over SSH to the scheduler host for its run logs. If the box is unreachable it says so loudly and still records the workstation sessions, so a network blip never loses data. `report` is fully offline. It reads only the ledger file, makes no network or LLM calls, and breaks the totals down by source and by model.

## A caveat worth knowing

The scheduler's run logs today record that a job ran (when, which job, whether it succeeded) but not how many tokens it used. So scheduler rows currently show up in the ledger at a $0 estimate: they count the runs without pricing them. When the scheduler starts recording token counts, the same tool picks them up automatically and the dollar figures fill in. The workstation-session numbers, which do carry token counts, are real estimates today.

## The bigger picture

The pilot's planner and the whole dev fleet draw from one shared weekly quota. When a week runs hot, this ledger is how we see which side is spending it, so the throttling decision (cut task count, never review quality) is made on numbers instead of guesses.
