// `npm run stack [start|stop|status|env]`: the tutorials' own local Supabase
// stack, apart from every other one on this machine.
//
// The repository's `supabase/` is copied to `tutorials/.stack/supabase/`
// (gitignored) and only the copy is changed: project id `rail-tutorials`,
// every port 5542x (shadow 55420), the web dev server's callback allowed,
// and no `.temp/` (the GoTrue version pinned there rejects the CLI's local
// HS256 service key, which the admin API below needs). Docker volumes are
// named by the project id, so this stack never sees another stack's data,
// and `stop` stops this one only.
//
// The stack's keys go to `tutorials/.stack/env.json` - never into a commit.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PORTS, PROJECT_ID, REPO, STACK_DIR, WEB_URL } from '../capture/lib/paths.ts';

const EXCLUDE = 'studio,imgproxy,logflare,vector,supavisor,postgres-meta';

function supabase(args: string[], inherit = true): string {
  const result = spawnSync('supabase', [...args, '--workdir', STACK_DIR], {
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`supabase ${args.join(' ')} failed${inherit ? '' : `: ${result.stderr}`}`);
  }
  return result.stdout ?? '';
}

/** Set `key = value` in the `[section]` of a config.toml (first match). */
function setKey(toml: string, section: string, key: string, value: string): string {
  const lines = toml.split('\n');
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const header = /^\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (header) {
      inSection = header[1] === section;
      continue;
    }
    if (inSection && new RegExp(`^${key}\\s*=`).test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  throw new Error(`config.toml: no ${key} in [${section}]`);
}

function prepare(): void {
  const target = join(STACK_DIR, 'supabase');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(STACK_DIR, { recursive: true });
  cpSync(join(REPO, 'supabase'), target, { recursive: true });
  rmSync(join(target, '.temp'), { recursive: true, force: true });
  let toml = readFileSync(join(target, 'config.toml'), 'utf8');
  toml = toml.replace(/^project_id = .*$/m, `project_id = "${PROJECT_ID}"`);
  toml = setKey(toml, 'api', 'port', String(PORTS.api));
  toml = setKey(toml, 'db', 'port', String(PORTS.db));
  toml = setKey(toml, 'db', 'shadow_port', String(PORTS.shadow));
  toml = setKey(toml, 'db.pooler', 'port', String(PORTS.pooler));
  toml = setKey(toml, 'studio', 'port', String(PORTS.studio));
  toml = setKey(toml, 'inbucket', 'port', String(PORTS.inbucket));
  toml = setKey(toml, 'analytics', 'port', String(PORTS.analytics));
  toml = setKey(toml, 'edge_runtime', 'inspector_port', String(PORTS.inspector));
  // Local links (a confirmation mail, a redirect) point at the dev server.
  toml = setKey(toml, 'auth', 'site_url', JSON.stringify(WEB_URL));
  toml = setKey(
    toml,
    'auth',
    'additional_redirect_urls',
    JSON.stringify([`${WEB_URL}/auth/callback**`, `${WEB_URL.replace('localhost', '127.0.0.1')}/auth/callback**`]),
  );
  // No seed file exists in the repository; the demo data is loaded through the app.
  writeFileSync(join(target, 'config.toml'), toml);
  if (!existsSync(join(target, 'seed.sql'))) writeFileSync(join(target, 'seed.sql'), '-- tutorials: no seed\n');
}

function writeEnv(): void {
  const out = supabase(['status', '-o', 'env'], false);
  const env: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  const keys = { API_URL: env.API_URL, ANON_KEY: env.ANON_KEY, SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY };
  if (!keys.API_URL || !keys.ANON_KEY || !keys.SERVICE_ROLE_KEY) throw new Error('supabase status: keys missing');
  if (!keys.API_URL.includes(String(PORTS.api))) throw new Error(`unexpected API URL ${keys.API_URL}`);
  writeFileSync(join(STACK_DIR, 'env.json'), `${JSON.stringify(keys, null, 2)}\n`);
  console.log(`Stack ${PROJECT_ID} up: ${keys.API_URL} (keys in ${join(STACK_DIR, 'env.json')})`);
}

const command = process.argv[2] ?? 'start';
switch (command) {
  case 'start': {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    prepare();
    supabase(['start', '-x', EXCLUDE]);
    writeEnv();
    break;
  }
  case 'stop':
    if (!existsSync(join(STACK_DIR, 'supabase'))) prepare();
    supabase(['stop']);
    break;
  case 'status':
    supabase(['status']);
    break;
  case 'env':
    writeEnv();
    break;
  default:
    console.error('usage: npm run stack [start|stop|status|env]');
    process.exit(2);
}
