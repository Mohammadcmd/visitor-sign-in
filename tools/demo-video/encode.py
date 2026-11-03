"""Turns the slow-motion screencast frames into a smooth 30 fps MP4."""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, 'times.json')))
R, times = data['R'], data['times']
frames = sorted(f for f in os.listdir(os.path.join(HERE, 'frames')) if f.endswith('.jpg'))
assert len(frames) == len(times), (len(frames), len(times))

lines = []
for i, f in enumerate(frames):
    dur = (times[i + 1] - times[i]) * R if i + 1 < len(times) else 1.0
    lines.append(f"file 'frames/{f}'\nduration {max(dur, 0.001):.4f}")
lines.append(f"file 'frames/{frames[-1]}'")  # concat demuxer needs the last file repeated
open(os.path.join(HERE, 'list.txt'), 'w').write('\n'.join(lines) + '\n')

total = (times[-1] - times[0]) * R + 1.0
out = os.environ.get('OUT', os.path.join(HERE, 'visitor-sign-in-demo.mp4'))
subprocess.run([
    'ffmpeg', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
    '-vf', f'fps=30,fade=t=in:st=0:d=0.8,fade=t=out:st={total - 1.2:.2f}:d=1.2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out,
], cwd=HERE, check=True)
print(out, f'{total:.1f}s')
