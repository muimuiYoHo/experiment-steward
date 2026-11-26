# PROGRESS

Times are Asia/Tokyo (JST).

## Done
- 2026-11-26 11:45 Local Flagsmith 2.295.2 via the official docker-compose plus a host-network override (this sandbox blocks Docker bridge traffic). `experimentation_enabled: true`; Flagsmith-database warehouse connected.
- 2026-11-26 11:48 Probed the full loop by hand on the real instance: CLI feature with a keyed variant, metric, experiment, start, Node SDK exposures and conversions, refresh, results, complete. Probe resources deleted afterwards.
- 2026-11-26 11:53 Core implementation: plan, validation and hash; approval state machine; Flagsmith adapter with HTTP and CLI transports; apply/start/results/ship; SDK traffic; results interpreter; CLI with approval cards.
- 2026-11-26 12:00 Test suite (now 30 tests, all passing), local bootstrap script, exposure/quarantine check, AGENTS.md, example plan, LICENSE.
- 2026-11-26 12:01 Two full dry runs against the real instance. The dashboard shows the same numbers as `steward results`, and ship rolls the variant out to everyone.
- 2026-11-26 12:06 README: problem, safety model, how Flagsmith is used (endpoint table), setup, commands, how to read results, limitations, AI-assistance statement.
- 2026-11-26 12:16 Demo take 1 recorded. Issues found: browser stalls, glyphs rendering as tofu, small font, and an inconclusive result at n=800 (correctly blocked from shipping). Fixed for take 2.

## In progress
- 2026-11-26 12:35 Demo take 3 recording (takes 1–2 kept in ../demo/raw-take*; take 2 had a good result but older card layout). Then edit to mp4 (2–3 minutes) with ../demo/edit.py.

## Blockers
- None. Still needed from the user: push to GitHub, upload the video, submit on WeMakeDevs.

## Next
- Edit and verify the video; final README check; final commit.
