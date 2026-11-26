# Using Experiment Steward from an AI coding agent

Paste this into your agent's instructions (Claude Code, Cursor, Codex, ...) when you want it to
run Flagsmith experiments for you. The agent does the tedious parts; a person approves each
change to Flagsmith.

1. Turn the request ("test the checkout button copy, success is a completed checkout") into a
   plan. Either run `npx steward plan --flag ... --variant key=value --event ... --hypothesis "..."`
   or write a plan JSON like `plans/example-cta-copy.json` and run `npx steward plan --file <it>`.
   Use a multivariate flag from the start, give every variation a key, and use the exact event
   name your code will send.
2. Show the human the approval card that `plan` printed, then **stop**. Do not run
   `steward approve` yourself: it needs an interactive terminal and the human's eyes on the card.
3. After the human approves, run `npx steward apply <id>`. It creates the flag, keyed
   variations, metric and an experiment that is not started.
4. Wire the code: evaluate the flag with `getExperimentFlag(<flag>, <stable user id>)` where the
   variation is shown, call `trackEvent(<event>, { identifier })` where success happens, and flush
   events before exit. Self-hosted: point `eventsApiUrl` at `<api>/api/`.
5. Ask the human to approve the start (`steward approve <id>`), then run `npx steward start <id>`.
6. Read results with `npx steward results <id>`. Report the verdict as printed. Never describe
   "Collecting data", "inconclusive" or an interval crossing zero as a win.
7. Ask the human for the ship decision (`steward approve <id> --decision <key>|control|disable`),
   then run `npx steward ship <id>`.

If any command prints `■ BLOCKED`, show the message to the human. Do not work around it.
