#!/usr/bin/env python3
"""Edits raw/raw.mkv + raw/timeline.json into the submission video (1080p mp4, burned-in captions)."""
import json, os, subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = '/workspace/flagsmith-hackathon/demo'
RAW = os.path.join(ROOT, 'raw')
WORK = os.path.join(ROOT, 'work'); os.makedirs(WORK, exist_ok=True)
OUT = os.path.join(ROOT, 'experiment-steward-demo.mp4')
W, H = 1920, 1080
BG = (13, 17, 23)
INTER = '/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf'
MONO = [p for p in subprocess.run(['fc-list', ':family=JetBrains Mono:style=Regular', 'file'], capture_output=True, text=True).stdout.split('\n') if p][0].rstrip(': ')

def font(size, weight='Regular'):
    f = ImageFont.truetype(INTER, size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

def card(path, blocks):
    img = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(img)
    y = blocks[0][0]
    for _, text, f, color in blocks:
        for line in text.split('\n'):
            box = d.textbbox((0, 0), line, font=f)
            d.text(((W - (box[2] - box[0])) // 2, y), line, font=f, fill=color)
            y += int((box[3] - box[1]) * 1.55) + 4
        y += 22
    img.save(path)

def run(*args):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args], check=True)

def still(png, secs, out, fade=True):
    run('-loop', '1', '-framerate', '30', '-t', str(secs), '-i', png,
        '-vf', f'fade=t=in:st=0:d=0.4,fade=t=out:st={secs-0.4}:d=0.4,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', out)

WHITE, GREY, ACCENT, GREEN = (230, 237, 243), (150, 160, 175), (149, 108, 255), (63, 185, 80)

card(f'{WORK}/title.png', [
    (330, 'Experiment Steward', font(110, 'Bold'), WHITE),
    (0, 'Human-approved Flagsmith experiments for AI coding agents', font(46), GREY),
    (0, 'Toggle Wars  ·  Track 2: AI Agents + Feature Flags', font(36, 'Medium'), ACCENT),
])
card(f'{WORK}/problem.png', [
    (230, 'The problem', font(72, 'Bold'), WHITE),
    (0, 'An AI coding agent can set up an A/B test in seconds.\nIt should not change your feature flags on its own.\nAnd "93% chance to win" is not a win.', font(46), GREY),
    (0, 'Experiment Steward: the agent drafts the plan  →  a human approves each Flagsmith write\n→  Flagsmith runs and measures the experiment  →  Steward explains the result honestly', font(36, 'Medium'), GREEN),
])
card(f'{WORK}/outro.png', [
    (170, 'How it uses Flagsmith', font(68, 'Bold'), WHITE),
    (0, 'Native Experimentation on self-hosted Flagsmith (Flagsmith-database warehouse)\n'
        'Management API, directly or through the Flagsmith CLI v2 (flagsmith api)\n'
        '@flagsmith/nodejs: getExperimentFlag (exposures) + trackEvent (conversions)\n'
        "Flagsmith's own Bayesian results, read with Flagsmith's thresholds\n"
        'Three human approvals: create  ·  start  ·  ship', font(40), GREY),
    (0, 'github.com/muimuiYoHo/experiment-steward', font(48, 'SemiBold'), ACCENT),
    (0, 'Built with an AI coding assistant. Real run against a local Flagsmith; keystrokes were scripted for the recording.', font(28), GREY),
])

INTRO = [('title', 4.5), ('problem', 10.0)]
OUTRO = [('outro', 9.0)]
for name, secs in INTRO + OUTRO:
    still(f'{WORK}/{name}.png', secs, f'{WORK}/{name}.mp4')

tl = json.load(open(f'{RAW}/timeline.json'))
t = {e['kind']: e['t'] for e in tl if e['kind'] != 'caption'}
segments = [(t['start'], t['cut_start']), (t['cut_end'], t['end'] + 0.3)]
for extra in json.load(open(f'{ROOT}/extra_cuts.json')) if os.path.exists(f'{ROOT}/extra_cuts.json') else []:
    new = []
    for a, b in segments:
        ca, cb = extra
        if cb <= a or ca >= b: new.append((a, b))
        else:
            if ca > a: new.append((a, ca))
            if cb < b: new.append((cb, b))
    segments = new

FREEZE_AFTER_SEG = int(os.environ.get('FREEZE_AFTER_SEG', '-1'))  # insert a held still after this segment index
FREEZE_SECS = 3.0
def to_edit(x):
    """Raw time -> body time, or None if x falls in a cut."""
    acc = 0.0
    for i, (a, b) in enumerate(segments):
        if a <= x <= b: return acc + (x - a)
        acc += b - a
        if i == FREEZE_AFTER_SEG: acc += FREEZE_SECS
    return None

clips = []
for i, (a, b) in enumerate(segments):
    out = f'{WORK}/seg{i}.mp4'
    run('-ss', f'{a:.2f}', '-to', f'{b:.2f}', '-i', f'{RAW}/raw.mkv', '-vf', 'format=yuv420p', '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', out)
    clips.append(out)

if FREEZE_AFTER_SEG >= 0:
    still(f'{WORK}/freeze.png', FREEZE_SECS, f'{WORK}/freeze.mp4')
    clips.insert(FREEZE_AFTER_SEG + 1, f'{WORK}/freeze.mp4')
intro_len = sum(s for _, s in INTRO)
body_len = sum(b - a for a, b in segments) + (FREEZE_SECS if FREEZE_AFTER_SEG >= 0 else 0)
caps = [e for e in tl if e['kind'] == 'caption']
events = []
for k, c in enumerate(caps):
    start = to_edit(c['t'])
    if start is None:  # caption inside a cut: skip it
        continue
    if c['text'].startswith(('In Flagsmith', '... and', 'The same numbers', 'Flagsmith: experiment completed')):
        start += 3.5  # the browser is raised a few seconds after the caption is logged
    nxt = [to_edit(caps[j]['t']) for j in range(k + 1, len(caps))]
    nxt = [n for n in nxt if n is not None and n > start]
    end = min(nxt[0] if nxt else body_len, start + 14)
    events.append((intro_len + start, intro_len + end - 0.05, c['text']))

def ts(x):
    h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f'{h}:{m:02d}:{s:05.2f}'

ass = ['[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {W}', f'PlayResY: {H}', '',
       '[V4+ Styles]',
       'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
       'Style: Cap,Inter,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,60,60,46,1',
       '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
for a, b, text in events:
    ass.append(f'Dialogue: 0,{ts(a)},{ts(b)},Cap,,0,0,0,,{text}')
open(f'{WORK}/captions.ass', 'w').write('\n'.join(ass) + '\n')

with open(f'{WORK}/list.txt', 'w') as f:
    for name, _ in INTRO: f.write(f"file '{WORK}/{name}.mp4'\n")
    for c in clips: f.write(f"file '{c}'\n")
    for name, _ in OUTRO: f.write(f"file '{WORK}/{name}.mp4'\n")
run('-f', 'concat', '-safe', '0', '-i', f'{WORK}/list.txt', '-c', 'copy', f'{WORK}/joined.mp4')
fontsdir = os.path.dirname(INTER)
run('-i', f'{WORK}/joined.mp4', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', f"subtitles={WORK}/captions.ass:fontsdir={fontsdir}", '-shortest',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', OUT)
dur = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT], capture_output=True, text=True).stdout.strip()
print('wrote', OUT, 'duration', dur, 'segments', [(round(a, 1), round(b, 1)) for a, b in segments])
