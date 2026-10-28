// `npm run render [-- slug ...] [--concurrency N] [--force]`: each tutorial
// to out/<slug>.mp4 (H.264, 1920 x 1080, 30 fps).
// `npm run still [-- slug [frame]]`: one frame to out/<slug>-<frame>.png.
//
// Before rendering, every step's shot and targets are checked against the
// captures (a video must not point at nothing). Rendering uses the Chrome
// headless shell Playwright already keeps (~/Library/Caches/ms-playwright),
// so Remotion downloads no browser; set REMOTION_BROWSER to use another.
//
// The machine is someone's work computer: on weekdays 08:00-16:00 Europe/
// Zagreb this renders at most one video, two frames at a time, unless
// --force.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CAPTURES, OUT, TUTORIALS } from '../capture/lib/paths.ts';
import { SCRIPTS } from '../src/scripts/index.ts';

const argv = process.argv.slice(2);
const still = argv.includes('--still');
const force = argv.includes('--force');
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--concurrency'));

function browser(): string | undefined {
  if (process.env.REMOTION_BROWSER) return process.env.REMOTION_BROWSER;
  const json = JSON.parse(readFileSync(join(TUTORIALS, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const rev = json.browsers.find((b) => b.name === 'chromium-headless-shell')?.revision;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright'));
  const dir = join(cache, `chromium_headless_shell-${rev}`);
  if (!existsSync(dir)) return undefined;
  for (const sub of readdirSync(dir)) {
    for (const exe of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
      const path = join(dir, sub, exe);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

function workingHours(): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zagreb',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const day = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return !['Sat', 'Sun'].includes(day) && hour >= 8 && hour < 16;
}

/** Every step's shot and targets exist in the captures. */
function check(slug: string): string[] {
  const script = SCRIPTS.find((s) => s.slug === slug)!;
  const file = join(CAPTURES, script.captures ?? slug, 'manifest.json');
  if (!existsSync(file)) return [`${slug}: not captured (npm run capture -- ${script.captures ?? slug})`];
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { shots: Record<string, { targets: Record<string, unknown> }> };
  const problems: string[] = [];
  for (const step of script.chapters.flatMap((c) => c.steps)) {
    const shot = manifest.shots[step.shot];
    if (!shot) {
      problems.push(`${slug}: no shot ${step.shot}`);
      continue;
    }
    const names = [step.focus, step.cursor, ...(Array.isArray(step.highlight) ? step.highlight : [step.highlight])];
    for (const name of names) if (name && !shot.targets[name]) problems.push(`${slug}/${step.shot}: no target ${name}`);
  }
  return problems;
}

const slugs = positional.length ? (still ? [positional[0]] : positional) : SCRIPTS.map((s) => s.slug);
const unknown = slugs.filter((s) => !SCRIPTS.some((t) => t.slug === s));
if (unknown.length) {
  console.error(`Unknown tutorial(s): ${unknown.join(', ')}`);
  process.exit(2);
}
const problems = slugs.flatMap(check);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
if (!still && slugs.length > 1 && workingHours() && !force) {
  console.error('Weekday working hours (08:00-16:00 Europe/Zagreb): render one video at a time, or pass --force.');
  process.exit(1);
}

spawnSync('node', [join(TUTORIALS, 'scripts', 'assets.ts')], { stdio: 'inherit' });
mkdirSync(OUT, { recursive: true });
const exe = browser();
const common = [...(exe ? ['--browser-executable', exe] : []), '--log=warn'];
const concurrency = flag('--concurrency') ?? (workingHours() ? '2' : '50%');
const remotion = join(TUTORIALS, 'node_modules', '.bin', 'remotion');

let failed = false;
for (const slug of slugs) {
  const args = still
    ? ['still', 'src/index.ts', slug, join(OUT, `${slug}-${positional[1] ?? '300'}.png`), `--frame=${positional[1] ?? '300'}`, ...common]
    : ['render', 'src/index.ts', slug, join(OUT, `${slug}.mp4`), '--codec=h264', '--crf=18', `--concurrency=${concurrency}`, ...common];
  console.log(`\n== ${slug}`);
  const result = spawnSync(remotion, args, { cwd: TUTORIALS, stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
