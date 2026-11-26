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

## Done (continued)
- 2026-11-26 12:50 Demo take 3 recorded (real winner: buy_now, 1,560 identities, >99% chance to be best) and edited: ../demo/experiment-steward-demo.mp4, 2:39, 1080p. Frames checked for legibility and content.

## In progress
- Nothing.

## Blockers
- None. Needs the owner: push the repo, upload the video, submit on WeMakeDevs.

## Next
- After pushing, run the README steps once on a clean machine if time allows.
