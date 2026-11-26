// Decides whether to send a notification right now. Prints one line:
//   NOTIFY <message>   -> the caller sends <message> as a push notification
//   SKIP <reason>      -> nothing to do
//
//   node tools/remind.mjs           # Friday meeting: 30 min before, and a notes nudge 1 h after
//   node tools/remind.mjs --today   # one-line summary for the morning notification
//
// Reads the published, encrypted board from GitHub Pages (no git needed) and remembers what it
// already sent in private/reminders.json, so each reminder goes out once.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readPassword, readText, decryptJSON } from './lib.mjs';

const ymd = (d) => d.toLocaleDateString('sv-SE');
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function siteUrl() {
  for (const git of ['git', 'C:\\Program Files\\Git\\cmd\\git.exe']) {
    try {
      const url = execFileSync(git, ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
      const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (m) return `https://${m[1].toLowerCase()}.github.io/${m[2]}/`;
    } catch { /* try the next one */ }
  }
  return null;
}

async function loadBoard() {
  const site = siteUrl();
  let blob = null;
  if (site) {
    try {
      const res = await fetch(`${site}data/board.enc.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) blob = await res.json();
    } catch { /* offline: fall back to the local copy */ }
  }
  if (!blob) blob = JSON.parse(readText(join(root, 'data', 'board.enc.json')));
  return decryptJSON(blob, readPassword());
}

const now = process.env.REMIND_NOW ? new Date(process.env.REMIND_NOW) : new Date(); // override for testing
const today = ymd(now);
const board = await loadBoard();
const weekly = { title: '週會', time: '15:00', remind: true, ...(board.weekly || {}) };
const meeting = (board.meetings || {})[today] || {};
const time = meeting.time || weekly.time || '15:00';
const [h, m] = time.split(':').map(Number);
const meetMin = h * 60 + m;
const nowMin = now.getHours() * 60 + now.getMinutes();
const isFriday = now.getDay() === 5;

if (process.argv.includes('--today')) {
  const tasks = board.tasks || [];
  const open = tasks.filter((t) => t.status !== 'done');
  const dueToday = open.filter((t) => t.due === today).length;
  const overdue = open.filter((t) => t.due && t.due < today).length;
  const blocked = open.filter((t) => t.status === 'blocked').length;
  const parts = [];
  if (dueToday) parts.push(`今天到期 ${dueToday} 件`);
  if (overdue) parts.push(`逾期 ${overdue} 件`);
  if (blocked) parts.push(`卡關 ${blocked} 件`);
  if (isFriday && !meeting.skip) parts.push(`${hm(meetMin)} ${weekly.title}`);
  console.log(`TODAY ${parts.join('、') || '沒有到期的任務'}`);
  process.exit(0);
}

const stateFile = join(root, 'private', 'reminders.json');
const state = existsSync(stateFile) ? JSON.parse(readText(stateFile)) : {};
const writeState = () => {
  for (const k of Object.keys(state).filter((k) => /^\d{4}-/.test(k)).sort().slice(0, -8)) delete state[k];
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
};

// Calendar sync for the coming Friday (today if it is Friday):
//   --meeting       -> "MEETING <date> <HH:MM|SKIP> <title>" when the calendar needs updating, else "UNCHANGED ..."
//   --mark-synced   -> remember that the calendar now matches the board for that Friday
if (process.argv.includes('--meeting') || process.argv.includes('--mark-synced')) {
  const fri = new Date(now);
  fri.setDate(fri.getDate() + ((5 - fri.getDay() + 7) % 7));
  const date = ymd(fri);
  const mf = (board.meetings || {})[date] || {};
  const want = mf.skip ? 'SKIP' : mf.time || weekly.time || '15:00';
  state.synced = state.synced || {};
  if (process.argv.includes('--mark-synced')) {
    state.synced[date] = want;
    for (const k of Object.keys(state.synced).sort().slice(0, -8)) delete state.synced[k];
    writeState();
    console.log(`OK synced ${date} ${want}`);
  } else if (state.synced[date] === want) {
    console.log(`UNCHANGED ${date} ${want}`);
  } else {
    console.log(`MEETING ${date} ${want} ${weekly.title}`);
  }
  process.exit(0);
}

if (!isFriday) { console.log('SKIP not Friday'); process.exit(0); }
if (weekly.remind === false) { console.log('SKIP reminders off'); process.exit(0); }
if (meeting.skip) { console.log('SKIP no meeting this week'); process.exit(0); }

const sent = state[today] || {};
const save = (key) => {
  state[today] = { ...sent, [key]: new Date().toISOString(), time };
  writeState();
};

// The reminder before the meeting comes from Google Calendar (it reaches the phone even when
// Claude's notifications are skipped). Here we only nudge about notes after the meeting.
const sentFor = sent.time === time;
const diff = meetMin - nowMin;
if (diff <= -60 && diff >= -300 && !meeting.submittedAt && !(sent.notes && sentFor)) {
  save('notes');
  console.log(`NOTIFY 開完${weekly.title}了嗎？到看板會議廳寫筆記，按「交給 Claude 彙整」，週報會整理成大項`);
} else {
  console.log(`SKIP ${weekly.title} ${time}, now ${hm(nowMin)}`);
}
