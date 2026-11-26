# Demo video

`experiment-steward-demo.mp4` (about 2:39, 1080p) is a screen recording of a real run against a local
Flagsmith instance: terminal (xterm) on the left layer, Flagsmith dashboard (Chrome) switched in.
It is not committed here because of its size; it is attached to the hackathon submission.

The recording is scripted so it can be reproduced:

- `record.py` types the commands (xdotool) into a terminal on a private X display and records it with ffmpeg.
  It also types the approval codes, which a person would type in normal use. It waits out Flagsmith's
  5-minute refresh limit between the first and second `steward results`.
- `browser.mjs` drives the dashboard tab through Chrome DevTools (playwright-core).
- `edit.py` cuts the 5-minute wait, adds the title/problem/outro cards and the burned-in captions.

Every number in the video is produced by Flagsmith and printed by `steward results`.
