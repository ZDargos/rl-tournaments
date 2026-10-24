// End-to-end test: real server (Discord disabled, dev login) + built website in Chromium.
// Flow: organizer creates a 1v1 bracket in the UI, four players register in the UI, the organizer
// starts it, players report and confirm every match, and the tournament completes.
// Usage: npm run build && npm run test:e2e
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = new URL('..', import.meta.url).pathname;
const API = 'http://localhost:8787';
const WEB = 'http://localhost:4173';
const GUILD = '200000000000000001';
const tmp = mkdtempSync(join(tmpdir(), 'rlt-e2e-'));
const procs = [];
let failures = 0;
const step = (msg) => console.log(`• ${msg}`);
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ ${msg}`); } };

function start(cmd, args, env, cwd = root) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.logs = () => out;
  procs.push(p);
  return p;
}
async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}
async function apiAs(page, path) {
  const token = await page.evaluate(() => localStorage.getItem('rlt.session'));
  const r = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  return r.json();
}

async function http(token, method, path, body) {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function devToken(n, name, admin = false) {
  const r = await fetch(`${API}/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: String(100000000000000500n + BigInt(n)), username: name, guildId: GUILD, admin }) });
  return (await r.json()).token;
}

async function waitStatus(page, matchId, status, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = await apiAs(page, `/api/matches/${matchId}`);
    if ((m.match ?? m).status === status) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`match ${matchId} never reached ${status}`);
}

async function main() {
  // Secrets must never reach the static bundle.
  const dist = join(root, 'apps/web/dist/assets');
  const bundle = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
  step('static bundle');
  check(!/DISCORD_(BOT_TOKEN|CLIENT_SECRET)|client_secret/i.test(bundle), 'website bundle contains no bot token / client secret references');

  const server = start('node', ['apps/server/dist/index.js'], {
    NODE_ENV: 'development', PORT: '8787', DATABASE_PATH: join(tmp, 'e2e.db'), BACKUP_DIR: join(tmp, 'backups'),
    DISCORD_DISABLED: 'true', DEV_LOGIN: 'true', WEB_URL: WEB, PUBLIC_API_URL: API, JOB_INTERVAL_SECONDS: '2', LOG_LEVEL: 'warn',
  });
  const viteBin = join(dirname(require.resolve('vite/package.json', { paths: [join(root, 'apps/web')] })), 'bin/vite.js');
  start('node', [viteBin, 'preview', '--port', '4173', '--strictPort'], {}, join(root, 'apps/web'));
  await waitFor(`${API}/health`);
  await waitFor(WEB);

  const browser = await chromium.launch();
  const ctxs = [];
  async function login(n, name, admin) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    ctxs.push(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failures++; console.log(`  ✗ page error (${name}): ${e.message}`); });
    await page.goto(`${WEB}/#/login`);
    await page.getByLabel('Discord user id').fill(`10000000000000000${n}`);
    await page.getByLabel('Username').fill(name);
    await page.getByLabel('Server id').fill(GUILD);
    const box = page.getByLabel('Server admin');
    if ((await box.isChecked()) !== admin) await box.click();
    await page.getByRole('button', { name: 'Dev login' }).click();
    await page.waitForURL((u) => !u.hash.startsWith('#/login'));
    await page.getByText(name).first().waitFor();
    return page;
  }

  step('organizer logs in and creates a tournament');
  const org = await login(0, 'Organizer', true);
  await org.getByRole('link', { name: 'Create', exact: true }).click();
  await org.getByLabel('Discord server').selectOption(GUILD);
  await org.getByLabel('Name').first().fill('E2E Cup');
  await org.getByLabel('Team size').selectOption('1');
  await org.getByLabel('Publish now').check();
  await org.getByRole('button', { name: 'Create tournament' }).click();
  await org.waitForURL(/#\/t\/\d+\/manage/);
  const tid = Number(/#\/t\/(\d+)/.exec(org.url())[1]);
  check(tid > 0, `tournament #${tid} created, manage page open`);
  await org.getByRole('button', { name: 'Open registration' }).click();
  await org.getByText('Registration open').first().waitFor();
  check(true, 'registration opened');

  step('four players register through the website');
  const players = [];
  for (let i = 1; i <= 4; i++) {
    const p = await login(i, `Player${i}`, false);
    await p.goto(`${WEB}/#/t/${tid}`);
    await p.getByRole('button', { name: 'Join tournament' }).click();
    await p.getByText('Registered!').first().waitFor();
    players.push(p);
  }
  const det = await apiAs(org, `/api/tournaments/${tid}`);
  check(det.entries.filter((e) => e.status === 'confirmed').length === 4, '4 confirmed entries');

  step('a non-organizer cannot manage');
  await players[0].goto(`${WEB}/#/t/${tid}/manage`);
  check(await players[0].getByText('Only organizers can manage this tournament').waitFor().then(() => true, () => false), 'manage page refused for a player');
  const forbidden = await fetch(`${API}/api/tournaments/${tid}/actions/start`, { method: 'POST', headers: { authorization: `Bearer ${await players[0].evaluate(() => localStorage.getItem('rlt.session'))}`, 'content-type': 'application/json' }, body: '{}' });
  check(forbidden.status === 403, `API refuses start by a player (HTTP ${forbidden.status})`);

  step('organizer starts the tournament');
  await org.reload();
  if (await org.getByRole('button', { name: 'Close registration' }).isVisible()) {
    await org.getByRole('button', { name: 'Close registration' }).click();
    await org.getByText('Registration closed').first().waitFor();
  }
  await org.getByRole('button', { name: 'Start tournament' }).click();
  await org.getByRole('button', { name: 'Confirm', exact: true }).click();
  // Wait for the state itself: "In progress" also appears in the lifecycle help text.
  let started = null;
  for (let i = 0; i < 60 && started !== 'in_progress'; i++) {
    started = (await apiAs(org, `/api/tournaments/${tid}`)).tournament.state;
    if (started !== 'in_progress') await new Promise((r) => setTimeout(r, 250));
  }
  check(started === 'in_progress', `tournament in progress (state: ${started})`);

  step('players report and confirm every match');
  const byUser = new Map(players.map((p, i) => [`10000000000000000${i + 1}`, p]));
  for (let round = 0; round < 5; round++) {
    const d = await apiAs(org, `/api/tournaments/${tid}`);
    if (d.tournament.state === 'completed') break;
    const ready = d.matches.filter((m) => ['ready', 'in_progress'].includes(m.status) && m.a && m.b);
    for (const m of ready) {
      const reporter = byUser.get(m.a.players[0].userId);
      const confirmer = byUser.get(m.b.players[0].userId);
      await reporter.goto(`${WEB}/#/m/${m.id}`);
      const inputs = reporter.locator('input[type=number]');
      await inputs.nth(0).fill('3'); await inputs.nth(1).fill('1');
      // Bo3 needs a second game; Bo1 (e.g. a configured final) is decided by the first.
      if (m.bestOf > 1) {
        await reporter.getByRole('button', { name: '+ Add game' }).click();
        await inputs.nth(2).fill('2'); await inputs.nth(3).fill('0');
      }
      await reporter.getByRole('button', { name: 'Submit result' }).click();
      await waitStatus(org, m.id, 'awaiting_confirmation');
      await confirmer.goto(`${WEB}/#/m/${m.id}`);
      await confirmer.getByRole('button', { name: 'Confirm result' }).click();
      await waitStatus(org, m.id, 'completed');
      const done = (await apiAs(org, `/api/matches/${m.id}`)).match;
      check(Math.max(done.winsA, done.winsB) === Math.ceil(m.bestOf / 2), `series score ${done.winsA}-${done.winsB} is a valid Bo${m.bestOf} result`);
      check(true, `match #${m.id} (${m.label}, Bo${m.bestOf}) reported by ${m.a.name}, confirmed by ${m.b.name}`);
    }
  }
  const fin = await apiAs(org, `/api/tournaments/${tid}`);
  check(fin.tournament.state === 'completed', `tournament completed (state: ${fin.tournament.state})`);
  const champ = fin.placements?.find((p) => p.placement === 1);
  check(!!champ, `champion recorded: ${champ?.name}`);

  step('public view, export and mobile layout');
  const anon = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true });
  ctxs.push(anon);
  const ap = await anon.newPage();
  const widthIssues = () => ap.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [...document.querySelectorAll('.card, .btn, h1, h2, .tabs, table')]
      .filter((el) => !el.closest('.table-wrap, .bracket-scroll, .tabs') || el.matches('.tabs'))
      .filter((el) => el.getBoundingClientRect().right > vw + 1);
    return { vw, scroll: document.documentElement.scrollWidth - vw, bad: bad.slice(0, 5).map((el) => el.className || el.tagName) };
  });
  for (const path of [`/t/${tid}`, `/m/${fin.matches[0].id}`, '/']) {
    await ap.goto(`${WEB}/#${path}`);
    await ap.locator('.card').first().waitFor();
    const w = await widthIssues();
    check(w.vw <= 400 && w.scroll <= 1 && w.bad.length === 0, `375px layout fits on ${path} (viewport ${w.vw}px, overflow ${w.scroll}px${w.bad.length ? `, overflowing: ${w.bad.join(' | ')}` : ''})`);
  }
  await ap.goto(`${WEB}/#/t/${tid}`);
  await ap.getByText('E2E Cup').first().waitFor();
  await ap.screenshot({ path: join(root, 'e2e/mobile-tournament.png'), fullPage: true });
  const csv = await fetch(`${API}/api/tournaments/${tid}/export/results`);
  check(csv.ok && (await csv.text()).split('\n').length >= 4, 'public CSV export of results works');
  await org.goto(`${WEB}/#/t/${tid}`);
  await org.screenshot({ path: join(root, 'e2e/desktop-tournament.png'), fullPage: true });

  step('6mans: organizer runs pools, schedule and finals in the website');
  const orgToken = await org.evaluate(() => localStorage.getItem('rlt.session'));
  const six = await http(orgToken, 'POST', '/api/tournaments', { guildId: GUILD, name: 'E2E 6mans', config: { format: 'sixmans', sixmans: { poolCount: 2 } } });
  await http(orgToken, 'POST', `/api/tournaments/${six.id}/actions/publish`, {});
  await http(orgToken, 'POST', `/api/tournaments/${six.id}/actions/open_registration`, {});
  const RANKS = ['supersonic_legend', 'grand_champion_2', 'champion_3', 'champion_1', 'diamond_3', 'diamond_1', 'platinum_3', 'platinum_1', 'gold_3', 'gold_1', 'silver_3', 'silver_1', 'bronze_3'];
  const sixTokens = new Map();
  // 13 players: pools of 7 and 6, so the automatic rounds give the pools different round counts.
  for (let i = 0; i < 13; i++) {
    const tok = await devToken(i, `Six${i + 1}`);
    sixTokens.set(String(100000000000000500n + BigInt(i)), tok);
    await http(tok, 'POST', `/api/tournaments/${six.id}/register`, { rank: RANKS[i] });
  }
  await org.goto(`${WEB}/#/t/${six.id}/manage`);
  await org.getByRole('tab', { name: '6mans' }).click();
  await org.getByRole('button', { name: 'Make pools' }).click();
  await org.getByRole('button', { name: 'Confirm pools' }).click();
  await org.getByRole('button', { name: 'Generate schedule' }).click();
  await org.getByRole('button', { name: 'Confirm schedule' }).click();
  await org.getByText('confirmed').nth(1).waitFor();
  let sd = await apiAs(org, `/api/tournaments/${six.id}`);
  check(sd.sixmans.pools.status === 'confirmed' && sd.sixmans.pools.data.pools.length === 2 && JSON.stringify(sd.sixmans.pools.data.pools.map((p) => p.players.length)) === '[7,6]' && sd.sixmans.schedule?.status === 'confirmed', 'pools of 7 and 6 and the schedule made and confirmed in the UI');
  const sp = sd.sixmans.schedule.data.pools;
  check(JSON.stringify(sp.map((p) => p.result.rounds.length)) === '[7,6]' && sp.every((p) => Object.values(p.result.appearances).every((g) => g === 6)), 'automatic rounds: 7 and 6 rounds, everyone plays 6 games');
  await org.getByRole('tab', { name: 'Control' }).click();
  if (await org.getByRole('button', { name: 'Close registration' }).isVisible()) {
    await org.getByRole('button', { name: 'Close registration' }).click();
    await org.getByText('Registration closed').first().waitFor();
  }
  await org.getByRole('button', { name: 'Start tournament' }).click();
  await org.getByRole('button', { name: 'Confirm', exact: true }).click();
  await org.getByText('In progress').first().waitFor();
  for (let guard = 0; guard < 30; guard++) {
    sd = await apiAs(org, `/api/tournaments/${six.id}`);
    const m = sd.matches.find((x) => x.status === 'ready' && x.stage === 'group');
    if (!m) break;
    await http(sixTokens.get(m.a.players[0].userId), 'POST', `/api/matches/${m.id}/report`, { games: [{ a: 3, b: 1 + (m.round % 2) }] });
    await http(sixTokens.get(m.b.players[0].userId), 'POST', `/api/matches/${m.id}/confirm`, {});
  }
  sd = await apiAs(org, `/api/tournaments/${six.id}`);
  const trios = sd.matches.filter((m) => m.stage === 'group').map((m) => [m.poolId, m.a, m.b]);
  const seen = new Set();
  let repeat = false;
  for (const [pool, a, b] of trios) for (const side of [a, b]) { const k = `${pool}:${side.players.map((p) => p.userId).sort().join(',')}`; if (seen.has(k)) repeat = true; seen.add(k); }
  check(sd.matches.filter((m) => m.stage === 'group').length === 13 && !repeat, '13 group matches played, no trio repeated within a pool');
  await org.reload();
  await org.getByRole('tab', { name: '6mans' }).click();
  await org.getByRole('button', { name: 'Start finals' }).click();
  await org.getByText('Finals started!').first().waitFor();
  sd = await apiAs(org, `/api/tournaments/${six.id}`);
  const finals = sd.matches.filter((m) => m.stage !== 'group');
  check(finals.length >= 1 && finals.every((m) => !m.a || m.a.players.length === 3), `finals bracket created from top 3 per pool (${finals.length} match)`);
  await org.screenshot({ path: join(root, 'e2e/desktop-6mans-manage.png'), fullPage: true });
  await ap.goto(`${WEB}/#/t/${six.id}`);
  await ap.locator('.card').first().waitFor();
  if (await ap.getByRole('tab', { name: /Pools/ }).isVisible()) await ap.getByRole('tab', { name: /Pools/ }).click();
  const w6 = await widthIssues();
  check(w6.scroll <= 1 && w6.bad.length === 0, `375px layout fits on the 6mans page (overflow ${w6.scroll}px${w6.bad.length ? `, ${w6.bad.join(' | ')}` : ''})`);
  await ap.screenshot({ path: join(root, 'e2e/mobile-6mans.png'), fullPage: true });

  for (const c of ctxs) await c.close();
  await browser.close();
  if (failures && server.logs()) console.log(server.logs().slice(-4000));
}

main()
  .catch((e) => { failures++; console.error(e); for (const p of procs) console.error(p.logs().slice(-3000)); })
  .finally(() => {
    for (const p of procs) p.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\nE2E FAILED (${failures})` : '\nE2E PASSED');
    process.exit(failures ? 1 : 0);
  });
