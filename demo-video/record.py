#!/usr/bin/env python3
"""Screen-records the Experiment Steward demo on a private X display (:7).

Everything shown is a real run against the local Flagsmith instance. Keystrokes, including the
approval codes, are typed by this script (xdotool) to make the recording reproducible.
Outputs: raw.mkv (continuous) + timeline.json (captions, cuts) for edit.py.
"""
import json, os, subprocess, sys, time

DISPLAY = ':7'
ROOT = '/workspace/flagsmith-hackathon/demo'
REPO = '/workspace/flagsmith-hackathon/experiment-steward'
OUT = os.path.join(ROOT, 'raw')
os.makedirs(OUT, exist_ok=True)
ENV = dict(os.environ, DISPLAY=DISPLAY)
PLAN_ID = 'checkout-button-copy'
SEQ = '/tmp/demo/prompt_seq'

timeline = []
t0 = None

def now():
    return time.time() - t0

def mark(kind, **kw):
    timeline.append(dict(t=round(now(), 2), kind=kind, **kw))
    print(f'[{now():6.1f}] {kind} {kw}', flush=True)

def caption(text):
    mark('caption', text=text)

def x(*args):
    return subprocess.run(['xdotool', *args], env=ENV, capture_output=True, text=True).stdout.strip()

def seq():
    try:
        return int(open(SEQ).read().strip() or 0)
    except FileNotFoundError:
        return 0

def term_win():
    return x('search', '--name', '^demo$').split('\n')[0]

def type_cmd(cmd, delay=28, wait=True, hold=1.5, timeout=240):
    w = term_win()
    x('windowraise', w); x('windowfocus', '--sync', w)
    before = seq()
    x('type', '--delay', str(delay), '--window', w, cmd)
    time.sleep(0.35)
    x('key', '--window', w, 'Return')
    if wait:
        end = time.time() + timeout
        while seq() == before and time.time() < end:
            time.sleep(0.2)
        time.sleep(hold)

def type_text(text, delay=120, enter=True, hold=1.0):
    w = term_win()
    x('type', '--delay', str(delay), '--window', w, text)
    if enter:
        time.sleep(0.4)
        x('key', '--window', w, 'Return')
    time.sleep(hold)

def approval_code():
    out = subprocess.run(['node', '-e', f'import("./src/plan.ts").then(m=>console.log(m.approvalCode(JSON.parse(require("fs").readFileSync("plans/{PLAN_ID}.json")).plan)))'],
                         cwd=REPO, capture_output=True, text=True)
    return out.stdout.strip()

def approve(extra='', hold=2.5, think=3.0):
    """Human approval: run approve, read the card, type the code shown on it."""
    before = seq()
    type_cmd(f'steward approve {PLAN_ID}{extra} --as demo-reviewer', wait=False)
    time.sleep(think)  # time to read the card
    type_text(approval_code(), delay=160, enter=True, hold=0.2)
    end = time.time() + 30
    while seq() == before and time.time() < end:
        time.sleep(0.2)
    time.sleep(hold)

browser = subprocess.Popen(['node', os.path.join(ROOT, 'tools', 'browser.mjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def b(op, **kw):
    browser.stdin.write(json.dumps(dict(op=op, **kw)) + '\n'); browser.stdin.flush()
    r = browser.stdout.readline().strip()
    if r != 'ok':
        print('browser:', r, flush=True)

def show_browser():
    x('windowraise', x('search', '--class', 'google-chrome').split('\n')[-1])

def show_terminal():
    w = term_win(); x('windowraise', w); x('windowfocus', w)

def env_key():
    for line in open(os.path.join(REPO, '.env')):
        if 'FLAGSMITH_ENVIRONMENT_KEY=' in line:
            return line.strip().split('=', 1)[1]
    raise SystemExit('no env key')

def project():
    for line in open(os.path.join(REPO, '.env')):
        if 'FLAGSMITH_PROJECT=' in line:
            return line.strip().split('=', 1)[1]

BASE = f'http://localhost:8000/project/{project()}/environment/{env_key()}'

# ---- prepare browser off-screen (terminal on top) -----------------------------------------
b('goto', url=f'{BASE}/features')
b('wait', ms=1500)
show_terminal()
type_cmd('clear', hold=0.3)

rec = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'x11grab', '-framerate', '30', '-video_size', '1920x1080',
                        '-draw_mouse', '0', '-i', DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                        os.path.join(OUT, 'raw.mkv')], stdin=subprocess.PIPE)
t0 = time.time()
time.sleep(1.0)
mark('start')

# ---- 1. the agent drafts a plan -----------------------------------------------------------
caption('An AI coding agent turns "test the checkout button copy" into an experiment plan')
type_cmd('steward plan --name "Checkout button copy" --flag checkout_cta --control-value Checkout '
         '--variant buy_now="Buy now" --event checkout_completed --drafted-by "AI coding agent" '
         '--hypothesis "A direct label (Buy now) increases completed checkouts"', delay=9, hold=6.5)

caption('No approval yet, so Steward refuses to write anything to Flagsmith')
type_cmd(f'steward apply {PLAN_ID}', hold=3.0)
caption('The agent cannot approve its own plan: approval needs a person at a terminal')
type_cmd(f'steward approve {PLAN_ID} < /dev/null | tail -1', hold=3.5)
type_cmd('clear', hold=0.2)

# ---- 2. human approval 1/3, then apply through the Flagsmith CLI ----------------------------
caption('Approval 1/3: a human reads the card and types its code')
approve(think=4.0, hold=2.0)
type_cmd('clear', hold=0.2)
caption('Steward creates the flag, keyed variation, metric and experiment via the Flagsmith CLI')
type_cmd(f'STEWARD_TRANSPORT=cli steward apply {PLAN_ID}', hold=5.0)

# ---- 3. Flagsmith side: created, not started ----------------------------------------------
caption('In Flagsmith: a multivariate flag with a keyed variation ...')
b('goto', url=f'{BASE}/features'); b('wait', ms=800)
show_browser(); time.sleep(3.5)
caption('... and an experiment that exists but has NOT started')
b('goto', url=f'{BASE}/experiments'); b('wait', ms=1200); time.sleep(3.5)
show_terminal(); type_cmd('clear', hold=0.2)

# ---- 4. approval 2/3, start, first trickle of traffic ---------------------------------------
caption('Approval 2/3: starting locks the flag and turns on the rollout')
approve(think=3.0, hold=1.0)
type_cmd(f'steward start {PLAN_ID}', hold=2.5)
type_cmd('clear', hold=0.2)
caption('Simulated shoppers via @flagsmith/nodejs: stable IDs, exposures + conversion events')
type_cmd(f'steward traffic {PLAN_ID} --users 60 --prefix shopper --rates control=0.10,buy_now=0.20 | grep -v "…"', hold=2.0)
caption("Steward reads Flagsmith's analysis and says plainly when it is too early")
type_cmd(f'steward results {PLAN_ID}', hold=5.0)
caption('A premature "ship it" is blocked before anyone is even asked to approve')
type_cmd(f'steward approve {PLAN_ID} --decision buy_now', hold=4.0)

# ---- wait out Flagsmith's 5-minute refresh limit (cut from the video) ----------------------
mark('cut_start')
type_cmd('clear', hold=0.2, timeout=5)
time.sleep(5 * 60 + 5)
mark('cut_end')

caption('Later: 1,500 more simulated shoppers, each with its own stable ID')
type_cmd(f'steward traffic {PLAN_ID} --users 1500 --prefix customer --seed 7 --rates control=0.10,buy_now=0.20 | grep -v "…"', hold=2.0)
type_cmd('clear', hold=0.2)
caption("Steward refreshes Flagsmith's results and applies Flagsmith's own thresholds")
type_cmd(f'steward results {PLAN_ID}', hold=6.0)
verdict = subprocess.run(['node', '-e', f'Promise.all([import("./src/report.ts")]).then(([r])=>{{const x=JSON.parse(require("fs").readFileSync("plans/{PLAN_ID}.json"));console.log(r.interpret(x.plan,x.lastResults).canShipVariant??"none")}})'],
                         cwd=REPO, capture_output=True, text=True).stdout.strip()
mark('verdict', value=verdict)

# ---- 5. Flagsmith dashboard shows the same numbers -----------------------------------------
caption('The same numbers in the Flagsmith dashboard')
b('goto', url=f'{BASE}/experiments'); b('click', text='Checkout button copy'); b('waitText', text='Analysis'); b('wait', ms=600)
show_browser(); time.sleep(3.0)
b('scrollTo', text='Credible Interval'); time.sleep(3.5)
show_terminal(); type_cmd('clear', hold=0.2)

# ---- 6. approval 3/3 and ship ----------------------------------------------------------------
if verdict == 'buy_now':
    caption('Approval 3/3: the card shows the evidence next to the decision')
    approve(' --decision buy_now', think=5.0, hold=1.5)
    type_cmd('clear', hold=0.2)
    caption('Ship: Flagsmith ends the experiment and rolls "Buy now" out')
else:
    caption('Not conclusive, so the reviewer approves keeping control')
    approve(' --decision control', think=5.0, hold=1.5)
    type_cmd('clear', hold=0.2)
    caption('Ship: Flagsmith ends the experiment and keeps control')
type_cmd(f'steward ship {PLAN_ID}', hold=3.5)
caption('Every approval and every Flagsmith API call is in the audit log')
type_cmd(f'steward log {PLAN_ID}', hold=5.0)

b('goto', url=f'{BASE}/experiments'); b('click', text='Completed'); b('wait', ms=800); b('click', text='Checkout button copy'); b('waitText', text='Results'); b('wait', ms=600)
caption('Flagsmith: experiment completed with the approved decision')
show_browser(); time.sleep(4.0)
mark('end')

rec.stdin.write(b'q'); rec.stdin.flush(); rec.wait(timeout=60)
browser.stdin.close()
json.dump(timeline, open(os.path.join(OUT, 'timeline.json'), 'w'), indent=1)
print('done', now())
