/**
 * AaGeJa Usage Meter
 * ---------------------------------------------------------------------------
 * Counts completed agent runs per customer and seat, for usage reporting and
 * overage billing.
 *
 * The last block of every agent posts { ac, run_id, agent } to /meter when a
 * run completes. ac is the signed context token the Agent Access Service
 * appends to every agent launch; it names the customer and the seat. One line
 * is written per completed run.
 *
 * A SEPARATE SERVICE ON PURPOSE. Records need a Railway volume, and Railway
 * takes a service with a volume briefly offline on every redeploy. Kept apart
 * from the Agent Access Service, the customer portal never gains that gap.
 * This service redeploys only when this repo changes.
 *
 * Zero npm dependencies. Node 18+. Run: node meter-service.js
 *
 * Environment variables:
 *   SERVICE_KEY          Required. Must match the Agent Access Service's
 *                        SERVICE_KEY character for character — it is what
 *                        verifies the context token. /healthz says whether
 *                        the two match.
 *   ADMIN_KEY            Required for the usage pages. Unset closes them.
 *   PORT                 Provided by Railway.
 *   RAILWAY_VOLUME_MOUNT_PATH  Set by Railway when a volume is attached.
 *                        Records go to <mount path>/meter. No volume, no
 *                        recording — see "Storage" below.
 *   METER_DIR            Optional. Overrides where records are written.
 *   ACCESS_SERVICE_URL   Optional. Defaults to the production Agent Access
 *                        Service. Used only by /healthz, to check SERVICE_KEY.
 *
 * Customer settings for the usage pages: ./clients.json (optional).
 *
 * ---------------------------------------------------------------------------
 * v1.0.0 (October 2026) — first version
 *   - POST /meter records one completed run. A run that fails part-way never
 *     reaches the agent's last block, so only completed runs are counted —
 *     the unit the Order Form bills.
 *   - Exists because MindStudio's usage report shows every portal user as
 *     "anonymous" and cannot be broken down by customer.
 *   - The customer and seat come from the signed token, never from the
 *     request body, so a run cannot be booked to another customer. An
 *     expired token is accepted for up to seven days: a run can finish long
 *     after the agent was opened.
 *   - ALWAYS ANSWERS 200, with { recorded: true|false, reason }. A failing
 *     HTTP block can fail an agent run, and a customer's run must never fail
 *     because of metering. Reasons: no_token, no_run_id, invalid_token,
 *     token_too_old, duplicate, no_storage, write_failed, bad_request.
 *   - Each run id is recorded once. A repeat answers "duplicate".
 *   - Records hold the opaque seat id only — no names, no email, no
 *     content — as the Order Form's Usage Data terms require. The usage
 *     pages show seat ids only, never seat labels.
 *   - GET /usage?k=ADMIN_KEY            every customer, one line each
 *     GET /usage/<client>?k=ADMIN_KEY   by month, agent and seat
 *     GET /usage/<client>/csv?k=...     every row, as a file
 * ---------------------------------------------------------------------------
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '1.0.0';
const PORT = process.env.PORT || 3000;
const SERVICE_KEY = process.env.SERVICE_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ACCESS_SERVICE_URL = (process.env.ACCESS_SERVICE_URL || 'https://agent-access-production.up.railway.app').replace(/\/+$/, '');
const CLIENTS_FILE = path.join(__dirname, 'clients.json');

// Display names for agent slugs. A slug not listed here is shown as itself.
// Slugs match the "slug" of each agent in the Agent Access Service's
// customer files, and the "agent" each agent's meter block sends.
const AGENT_NAMES = {
  'training-needs-analyst': 'Training Needs Analyst',
  'audience-profiler': 'Audience Profiler',
  'job-task-analyst': 'Job Task Analyst',
  'curriculum-designer': 'Curriculum Designer',
  'learning-path-designer': 'Learning Path Designer',
  'source-researcher': 'Source Researcher',
  'source-to-content-catalog-mapper': 'Source to Content Catalog Mapper',
  'course-module-knowledgebase-curator': 'Course/Module Knowledgebase Curator',
  'course-module-outline-architect': 'Course/Module Outline Architect',
  'storyboard-developer': 'Storyboard and Lab Guide Developer',
  'content-translator': 'Content Translator',
  'job-aid-developer': 'Job Aid Developer',
  'visual-designer': 'Visual Designer',
  'lesson-video-producer': 'Lesson Video Producer',
  'lms-packager': 'LMS Packager',
  'reviewer': 'Independent Reviewer',
  'screenshot-library-builder': 'Screenshot Library Builder',
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
//
// <METER_DIR>/<client_id>.jsonl, one line per completed run:
//   {"t":"2026-10-20T14:02:11.123Z","client":"acme","seat":"acme-s09","agent":"storyboard-developer","run_id":"98f5d984-..."}
//
// NEVER WRITES TO THE CONTAINER'S OWN DISK. Railway wipes it on every
// deploy, so records written there would vanish without any error — a meter
// that looks like it works and doesn't. With no volume, metering is off and
// says so, in the boot log, on /healthz and on every usage page.

const METER_DIR = process.env.METER_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'meter') : '');

/** Creates the record folder and proves it is writable. */
function initMeter() {
  if (!METER_DIR) return false;
  try {
    fs.mkdirSync(METER_DIR, { recursive: true });
    const probe = path.join(METER_DIR, '.write-check');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    console.error(`[meter] cannot write to ${METER_DIR}: ${err.message}`);
    return false;
  }
}

const meterReady = initMeter();

const SAFE_CLIENT = /^[a-z0-9][a-z0-9-]{0,48}$/;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

function meterFile(clientId) {
  return path.join(METER_DIR, `${clientId}.jsonl`);
}

/** Every recorded run for one customer, oldest first. */
function readRows(clientId) {
  if (!METER_DIR || !SAFE_CLIENT.test(clientId || '')) return [];
  const file = meterFile(clientId);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.run_id && r.t) rows.push(r);
    } catch {
      console.error(`[meter] unreadable line in ${clientId}.jsonl skipped`);
    }
  }
  return rows;
}

/** Customer ids with at least one record. */
function meteredClients() {
  if (!meterReady) return [];
  return fs.readdirSync(METER_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -6))
    .filter((id) => SAFE_CLIENT.test(id));
}

// Run ids already on record, per customer. Loaded from the file the first
// time a customer is metered after a start, so a repeat is caught across
// restarts and deploys.
const seenByClient = new Map();

function seenRuns(clientId) {
  let set = seenByClient.get(clientId);
  if (!set) {
    set = new Set(readRows(clientId).map((r) => r.run_id));
    seenByClient.set(clientId, set);
  }
  return set;
}

// ---------------------------------------------------------------------------
// The context token
// ---------------------------------------------------------------------------
//
// Minted by the Agent Access Service (access-service.js, mintAgentToken):
//   base64url(JSON {c: client_id, s: seat_id, e: expiry ms}) + "." +
//   base64url(HMAC-SHA256(that payload, SERVICE_KEY))
// Verified here with the same key. Editing the payload breaks the signature.

// A run can finish long after the agent was opened — a tab left open
// overnight. The token's own 12-hour expiry is therefore not enforced; a
// token is accepted until seven days after it expired.
const MAX_LATE_MS = 7 * 24 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Returns { ok: true, clientId, seatId, expires } or { ok: false, reason }. */
function verifyToken(token) {
  if (!SERVICE_KEY) return { ok: false, reason: 'invalid_token' };
  const parts = String(token).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid_token' };
  const expected = b64url(crypto.createHmac('sha256', SERVICE_KEY).update(parts[0]).digest());
  if (!timingSafeEqual(parts[1], expected)) return { ok: false, reason: 'invalid_token' };
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
  if (!p || typeof p.c !== 'string' || typeof p.s !== 'string' || typeof p.e !== 'number') {
    return { ok: false, reason: 'invalid_token' };
  }
  if (!SAFE_CLIENT.test(p.c) || !SAFE_NAME.test(p.s)) return { ok: false, reason: 'invalid_token' };
  return { ok: true, clientId: p.c, seatId: p.s, expires: p.e };
}

/**
 * A MindStudio variable that was never set arrives as "", "undefined",
 * "null" or the unreplaced "{{name}}". All of those mean absent.
 */
function presentValue(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t || t === 'undefined' || t === 'null' || /^\{\{.*\}\}$/.test(t)) return '';
  return t;
}

// ---------------------------------------------------------------------------
// Recording a run
// ---------------------------------------------------------------------------

/** Records one completed run. Never throws. */
function recordRun(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { recorded: false, reason: 'bad_request' };
  }
  const ac = presentValue(body.ac);
  const runId = presentValue(body.run_id);
  const agentRaw = presentValue(body.agent);
  const agent = SAFE_NAME.test(agentRaw) ? agentRaw : 'unknown';
  const tag = `agent=${agent} run=${runId || '-'}`;

  const refuse = (reason) => {
    console.log(`[meter] not recorded (${reason}) ${tag}`);
    return { recorded: false, reason };
  };

  if (!ac) return refuse('no_token');
  if (!runId || !SAFE_RUN_ID.test(runId)) return refuse('no_run_id');

  const token = verifyToken(ac);
  if (!token.ok) return refuse(token.reason);
  if (Date.now() > token.expires + MAX_LATE_MS) return refuse('token_too_old');
  if (!meterReady) return refuse('no_storage');

  const seen = seenRuns(token.clientId);
  if (seen.has(runId)) return refuse('duplicate');

  const row = { t: new Date().toISOString(), client: token.clientId, seat: token.seatId, agent, run_id: runId };
  try {
    fs.appendFileSync(meterFile(token.clientId), JSON.stringify(row) + '\n');
  } catch (err) {
    console.error(`[meter] write failed ${token.clientId}: ${err.message}`);
    return { recorded: false, reason: 'write_failed' };
  }
  seen.add(runId);
  console.log(`[meter] ${row.client} ${row.seat} ${row.agent} ${row.run_id}`);
  return { recorded: true };
}

// ---------------------------------------------------------------------------
// Customer settings — ./clients.json, optional
// ---------------------------------------------------------------------------
//
//   { "acme": { "name": "Acme Corporation",
//               "year_start": "2026-01-15", "runs_allowance": 4000 } }
//
// Read on every page view. Absent file, absent customer or absent fields
// simply mean no name and no allowance line.

function clientSettings(clientId) {
  try {
    const all = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    const c = all && all[clientId];
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

function configuredClients() {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')) || {}).filter((id) => SAFE_CLIENT.test(id));
  } catch {
    return [];
  }
}

/** The contract year that contains today, or null when none is set. UTC. */
function contractYear(settings) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.year_start || '')) return null;
  const allowance = Number(settings.runs_allowance);
  if (!Number.isFinite(allowance) || allowance <= 0) return null;
  const [y, m, d] = settings.year_start.split('-').map(Number);
  const now = Date.now();
  let k = 0;
  while (Date.UTC(y + k + 1, m - 1, d) <= now) k += 1;
  return { start: Date.UTC(y + k, m - 1, d), end: Date.UTC(y + k + 1, m - 1, d), allowance };
}

function summarise(clientId) {
  const rows = readRows(clientId);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const settings = clientSettings(clientId);
  const yr = contractYear(settings);
  return {
    clientId,
    name: typeof settings.name === 'string' && settings.name ? settings.name : clientId,
    rows,
    thisMonth,
    monthCount: rows.filter((r) => String(r.t).slice(0, 7) === thisMonth).length,
    year: yr,
    yearUsed: yr ? rows.filter((r) => { const t = Date.parse(r.t); return t >= yr.start && t < yr.end; }).length : null,
  };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (v) => Number(v).toLocaleString('en-US');
const monthLabel = (ym) => {
  const [yy, mm] = ym.split('-').map(Number);
  return new Date(Date.UTC(yy, mm - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const dayLabel = (ms) => new Date(ms).toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const agentName = (slug) => AGENT_NAMES[slug] || slug;

const CSS = `
:root{--teal:#0D7377;--teal-deep:#0A6366;--ink:#0A1628;--cream:#F5F0E8;--paper:#FCFAF6;--line:#E6DFD2;--mute:#5B6676;--gold:#B7791F;--warn:#9B2C2C}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px 16px 48px}
header{background:var(--teal-deep);color:#fff;padding:20px 24px;border-radius:6px 6px 0 0}
header .t{font-size:20px;font-weight:600;letter-spacing:.01em}
header .s{font-size:12px;opacity:.85;letter-spacing:.12em;text-transform:uppercase;margin-top:4px}
main{background:var(--paper);padding:24px;border-radius:0 0 6px 6px;border:1px solid var(--line);border-top:0}
h1{font-size:22px;margin:0 0 4px}
.meta{color:var(--mute);font-size:13px}
.note{margin:16px 0 0;font-size:14px}
.note.off{color:var(--warn);font-weight:600}
.big{font-weight:600}
h2{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute);margin:28px 0 8px;font-weight:600}
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
a{color:var(--teal)}
footer{color:var(--mute);font-size:12px;margin-top:16px}
`;

function page(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header><div class="t">AaGeJa · Usage</div><div class="s">Completed agent runs · internal</div></header>
<main>
${inner}
</main>
<footer>© ${new Date().getUTCFullYear()} AaGeJa LLC · Confidential · Internal — do not forward · Times in UTC</footer>
</div>
</body>
</html>`;
}

const OFF_NOTE = '<p class="note off">Metering is off. No storage volume is attached to this service, so completed runs are not being recorded.</p>';

function table(head, rows, empty) {
  const th = head.map(([label, n]) => `<th${n ? ' class="n"' : ''}>${esc(label)}</th>`).join('');
  const body = rows.length
    ? rows.map((cells) => '<tr>' + cells.map(([v, n]) => `<td${n ? ' class="n"' : ''}>${v}</td>`).join('') + '</tr>').join('\n')
    : `<tr><td colspan="${head.length}">${esc(empty)}</td></tr>`;
  return `<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function renderOverview(key) {
  const ids = [...new Set([...configuredClients(), ...meteredClients()])].sort();
  const rows = ids.map((id) => {
    const s = summarise(id);
    const year = s.year ? `${num(s.yearUsed)} of ${num(s.year.allowance)}` : '—';
    return [
      [`<a href="/usage/${encodeURIComponent(id)}?k=${encodeURIComponent(key)}">${esc(s.name)}</a>`],
      [num(s.monthCount), true],
      [year, true],
      [num(s.rows.length), true],
    ];
  });
  const inner = `<h1>All customers</h1>
<div class="meta">${esc(monthLabel(new Date().toISOString().slice(0, 7)))}</div>
${meterReady ? '' : OFF_NOTE}
<h2>Completed runs</h2>
${table([['Customer'], ['This month', true], ['Contract year', true], ['All time', true]], rows, 'No customers yet.')}`;
  return page('Usage · All customers', inner);
}

function renderClient(clientId, key) {
  const s = summarise(clientId);
  const byMonth = new Map();
  const byAgent = new Map();
  const bySeat = new Map();
  for (const r of s.rows) {
    const ym = String(r.t).slice(0, 7);
    const cur = ym === s.thisMonth ? 1 : 0;
    byMonth.set(ym, (byMonth.get(ym) || 0) + 1);
    const a = byAgent.get(r.agent) || { m: 0, t: 0 }; a.m += cur; a.t += 1; byAgent.set(r.agent, a);
    const st = bySeat.get(r.seat) || { m: 0, t: 0 }; st.m += cur; st.t += 1; bySeat.set(r.seat, st);
  }

  let allowance = '';
  if (s.year) {
    const pct = Math.round((s.yearUsed / s.year.allowance) * 1000) / 10;
    allowance = `<p class="note"><span class="big">${num(s.yearUsed)} of ${num(s.year.allowance)} runs used (${pct}%)</span> in the contract year ${esc(dayLabel(s.year.start))} – ${esc(dayLabel(s.year.end - 86400000))}.</p>`;
  }
  const csv = `/usage/${encodeURIComponent(clientId)}/csv?k=${encodeURIComponent(key)}`;
  const back = `/usage?k=${encodeURIComponent(key)}`;

  // Seats are shown by seat id only. Seat labels can carry initials, and a
  // label beside a run count identifies a person — the Order Form limits
  // usage data to opaque seat identifiers.
  const inner = `<h1>${esc(s.name)}</h1>
<div class="meta">${num(s.rows.length)} recorded · ${num(s.monthCount)} in ${esc(monthLabel(s.thisMonth))} · <a href="${esc(back)}">All customers</a></div>
${meterReady ? '' : OFF_NOTE}
${allowance}
<p class="note">One row is written when an agent run completes. A run that fails part-way is not counted. <a href="${esc(csv)}">Download every row as CSV</a>.</p>
<h2>By month</h2>
${table([['Month'], ['Runs', true]], [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([ym, c]) => [[esc(monthLabel(ym))], [num(c), true]]), 'No completed runs recorded yet.')}
<h2>By agent</h2>
${table([['Agent'], ['This month', true], ['All time', true]], [...byAgent.entries()].sort((a, b) => b[1].t - a[1].t).map(([slug, v]) => [[esc(agentName(slug))], [num(v.m), true], [num(v.t), true]]), 'No completed runs recorded yet.')}
<h2>By seat</h2>
${table([['Seat'], ['This month', true], ['All time', true]], [...bySeat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, v]) => [[esc(id)], [num(v.m), true], [num(v.t), true]]), 'No completed runs recorded yet.')}`;
  return page(`Usage · ${s.name}`, inner);
}

function toCsv(rows) {
  const cell = (v) => {
    const t = String(v ?? '');
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = ['time_utc,client,seat,agent,run_id'];
  for (const r of rows) lines.push([r.t, r.client, r.seat, r.agent, r.run_id].map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// SERVICE_KEY check, for /healthz
// ---------------------------------------------------------------------------
//
// The commonest way this service fails is a SERVICE_KEY that differs from
// the Agent Access Service's: every token is then refused as invalid_token,
// silently, on every customer's run. /healthz catches it before any agent
// is wired, by asking the Agent Access Service's existing, read-only
// /api/client-config route about a customer that does not exist. With the
// right key it answers 404 "No such client."; with a wrong key, 404
// "Not found." No customer name is needed or sent.
//
// Checked at most once every ten minutes. A wrong key counts as a failed
// attempt there, and twelve in ten minutes would lock this service's
// address out of that route.

let keyCheckCache = { at: 0, value: null };
const KEY_PROBE_ID = 'meter-key-check';

async function serviceKeyCheck() {
  if (!SERVICE_KEY) return 'not_set';
  if (Date.now() - keyCheckCache.at < 10 * 60 * 1000 && keyCheckCache.value) return keyCheckCache.value;
  let value;
  try {
    const r = await fetch(`${ACCESS_SERVICE_URL}/api/client-config/${KEY_PROBE_ID}`, {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 && j && j.message === 'Not found.') value = 'does_not_match';
    else if (r.status === 404 && j && j.message === 'No such client.') value = 'matches';
    else value = `could_not_check_${r.status}`;
  } catch (err) {
    value = 'could_not_check_unreachable';
  }
  keyCheckCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Lockout for the usage pages — in memory only, same rule as the portal
// ---------------------------------------------------------------------------

const attempts = new Map();
const FAIL_LIMIT = 12;
const WINDOW_MS = 10 * 60 * 1000;

function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > WINDOW_MS) { attempts.delete(ip); return false; }
  return rec.count >= FAIL_LIMIT;
}

function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.windowStart > WINDOW_MS) attempts.set(ip, { count: 1, windowStart: Date.now() });
  else rec.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (now - rec.windowStart > WINDOW_MS) attempts.delete(ip);
}, WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': type }, BASE_HEADERS, extra));
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
const sendHtml = (res, status, html) => send(res, status, 'text/html; charset=utf-8', html);
const NOT_FOUND_HTML = page('Not found', '<h1>Not found</h1>');

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      data += chunk;
      if (data.length > limit) { over = true; reject(new Error('body too large')); }
    });
    req.on('end', () => { if (!over) resolve(data); });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { message: 'Bad request.' });
  }
  const ip = clientIp(req);

  if (url.pathname === '/healthz' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      meter_recording: meterReady,
      service_key: await serviceKeyCheck(),
      admin_key_present: Boolean(ADMIN_KEY),
    });
  }

  // POST /meter  { "ac": "<context token>", "run_id": "<run id>", "agent": "<slug>" }
  // ALWAYS 200, so metering can never fail a customer's run. No lockout:
  // every agent calls from MindStudio's servers, and a lockout keyed on their
  // address would stop metering for every customer.
  if (url.pathname === '/meter' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      console.log('[meter] not recorded (bad_request) body was not JSON');
      return sendJson(res, 200, { recorded: false, reason: 'bad_request' });
    }
    return sendJson(res, 200, recordRun(body));
  }

  // Usage pages. A wrong or missing key answers the same 404 as a path that
  // does not exist, so an unauthenticated caller cannot tell they are here.
  const m = url.pathname.match(/^\/usage(?:\/([a-z0-9-]{1,49})(\/csv)?)?\/?$/);
  if (m && req.method === 'GET') {
    if (throttled(ip)) return sendHtml(res, 429, page('Too many attempts', '<h1>Too many attempts</h1><p class="note">Wait ten minutes.</p>'));
    const key = url.searchParams.get('k') || '';
    if (!ADMIN_KEY || !timingSafeEqual(key, ADMIN_KEY)) {
      recordFailure(ip);
      return sendHtml(res, 404, NOT_FOUND_HTML);
    }
    const clientId = m[1];
    if (!clientId) return sendHtml(res, 200, renderOverview(key));
    const known = configuredClients().includes(clientId) || meteredClients().includes(clientId);
    if (!known) return sendHtml(res, 404, NOT_FOUND_HTML);
    if (m[2]) {
      return send(res, 200, 'text/csv; charset=utf-8', toCsv(readRows(clientId)), {
        'Content-Disposition': `attachment; filename="usage-${clientId}-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
    }
    return sendHtml(res, 200, renderClient(clientId, key));
  }

  return sendJson(res, 404, { message: 'Not found.' });
});

server.listen(PORT, () => {
  console.log(`AaGeJa Usage Meter v${VERSION} listening on ${PORT}`);
  if (meterReady) console.log(`[meter] recording completed runs in ${METER_DIR}`);
  else console.error('[meter] OFF — no storage volume attached. Completed runs are NOT being recorded.');
  if (!SERVICE_KEY) console.error('ERROR: SERVICE_KEY is not set — every run will be refused as invalid_token.');
  if (!ADMIN_KEY) console.error('ERROR: ADMIN_KEY is not set — the usage pages are closed.');
});
