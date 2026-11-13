import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const STATUS = {
  todo: { label: '待辦', color: 0xc9ced6 },
  doing: { label: '進行中', color: 0xf2a93b },
  done: { label: '完成', color: 0x4caf7d },
  blocked: { label: '卡關', color: 0xe5584f },
};
const SORT = { blocked: 0, doing: 1, todo: 2, done: 3 };
const PRIORITY = { high: '重要', mid: '一般', low: '知會' };
const PALETTE = ['#5b8def', '#d97757', '#f2a93b', '#4caf7d', '#b574d6', '#3fb6b2', '#e5584f', '#e07ab0', '#8a6f55', '#6c7a89'];
const PATHS = { board: 'data/board.enc.json', mail: 'data/mail.enc.json', calendar: 'data/calendar.enc.json', reports: 'data/reports.enc.json' };
const LS_TOKEN = 'board.ghToken';
const LS_PW = 'board.pw';
const MAX_FOCUS = 3;
const MAX_LOG = 150;

const uid = () => Math.random().toString(36).slice(2, 10);
const ymd = (d) => d.toLocaleDateString('sv-SE');
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const md = (s) => s.slice(5).replace('-', '/');
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#6c7a89');
const pct = (ts) => (ts.length ? Math.round((ts.reduce((a, t) => a + (t.status === 'done' ? 1 : t.status === 'doing' ? 0.5 : 0), 0) / ts.length) * 100) : 0);
const daysLeft = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
const left = (n) => (n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天' : `剩 ${n} 天`);
const dueText = (d) => `${md(d)}（${left(daysLeft(d))}）`;
const isOverdue = (t) => t.due && t.status !== 'done' && daysLeft(t.due) < 0;
const urgency = (t) => (isOverdue(t) ? -1 : SORT[t.status]);
const sortTasks = (ts) => [...ts].sort((a, b) => urgency(a) - urgency(b) || (a.due || '9').localeCompare(b.due || '9'));
const weekRange = () => {
  const d = new Date();
  const mon = addDays(today(), -((d.getDay() + 6) % 7));
  return [mon, addDays(mon, 6)];
};

/* ---------- crypto (same format as tools/lib.mjs) ---------- */
const te = new TextEncoder(), td = new TextDecoder();
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const keyCache = new Map();
function deriveKey(pw, salt, iter) {
  const id = `${pw}|${salt}|${iter}`;
  if (!keyCache.has(id)) {
    keyCache.set(id, crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']).then((km) =>
      crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(salt), iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])));
  }
  return keyCache.get(id);
}
async function decryptBlob(blob, pw) {
  const key = await deriveKey(pw, blob.salt, blob.iter);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return JSON.parse(td.decode(pt));
}
async function encryptBlob(obj, pw, prev) {
  // Reuse the previous salt so the derived key stays cached; the IV is always fresh.
  const salt = prev?.salt ?? b64(crypto.getRandomValues(new Uint8Array(16)));
  const iter = prev?.iter ?? 600000;
  const key = await deriveKey(pw, salt, iter);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  return { v: 1, iter, salt, iv: b64(iv), ct: b64(ct) };
}
async function fetchJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error('nofile');
  return res.json();
}

/* ---------- storage: GitHub contents API (or the local mock) ---------- */
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const REPO = isLocal
  ? { api: location.origin + '/mock-api', owner: 'local', repo: 'local' }
  : location.hostname.endsWith('.github.io')
    ? { api: 'https://api.github.com', owner: location.hostname.split('.')[0], repo: location.pathname.split('/').filter(Boolean)[0] }
    : null;
const token = () => localStorage.getItem(LS_TOKEN) || '';
const canEdit = () => !!REPO && (isLocal || !!token());

function gh(method, body) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token() && !isLocal) headers.Authorization = 'Bearer ' + token();
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`${REPO.api}/repos/${REPO.owner}/${REPO.repo}/contents/${PATHS.board}`, { method, headers, cache: 'no-store', body: body && JSON.stringify(body) });
}
const ghError = (status) =>
  status === 401 ? '權杖無效或已過期' : status === 403 || status === 404 ? '權杖沒有這個 repo 的寫入權限' : `GitHub 回應 ${status}`;
async function readRemote() {
  const res = await gh('GET');
  if (!res.ok) throw new Error(ghError(res.status));
  const j = await res.json();
  return { blob: JSON.parse(atob(j.content.replace(/\s/g, ''))), sha: j.sha };
}
async function loadBlob() {
  // Prefer the API when editing is set up: GitHub Pages can lag a minute behind a save.
  if (canEdit()) { try { return (await readRemote()).blob; } catch { /* fall back to the published file */ } }
  return fetchJSON(PATHS.board);
}

/* ---------- state ---------- */
let board = null, password = null, currentView = null;
const extra = { mail: undefined, calendar: undefined, reports: undefined }; // undefined = not loaded, null = missing

function normalize(d) {
  const b = {
    v: 1,
    project: { name: '團隊進度', ...(d.project || {}) },
    people: Array.isArray(d.people) ? d.people : [],
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    milestones: Array.isArray(d.milestones) ? d.milestones : [],
    log: Array.isArray(d.log) ? d.log : [],
  };
  if (!b.people.some((p) => p.kind === 'leader')) b.people.unshift({ id: 'me', name: '我', role: 'Leader', color: '#5b8def', kind: 'leader' });
  if (!b.people.some((p) => p.kind === 'claude')) b.people.push({ id: 'claude', name: 'Claude', role: 'AI 助理', color: '#d97757', kind: 'claude' });
  const rank = (p) => (p.kind === 'leader' ? 0 : p.kind === 'claude' ? 1 : 2);
  b.people.sort((x, y) => rank(x) - rank(y));
  const ids = new Set(b.people.map((p) => p.id));
  b.tasks = b.tasks.filter((t) => ids.has(t.owner));
  b.tasks.forEach((t) => { if (!STATUS[t.status]) t.status = 'todo'; });
  b.milestones = b.milestones.filter((m) => isDate(m.date));
  return b;
}
const tasksOf = (id) => board.tasks.filter((t) => t.owner === id);
const person = (id) => board.people.find((p) => p.id === id);
const leader = () => board.people.find((p) => p.kind === 'leader');
const ownerName = (t) => person(t.owner)?.name ?? '';

let toastTimer;
function toast(msg, sticky) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Every change re-reads the latest version, applies `fn` to it and writes it back, so edits
// from the phone, the computer and Claude don't overwrite each other. `fn` returns a line for
// the activity log. Commit messages stay generic because they are public.
async function mutate(fn, okMsg = '已儲存') {
  if (!canEdit()) { toast('要編輯，請先到 ⚙️ 設定 GitHub 權杖'); return false; }
  document.body.classList.add('busy');
  toast('儲存中…', true);
  try {
    for (let i = 0; i < 3; i++) {
      const { blob, sha } = await readRemote();
      const latest = normalize(await decryptBlob(blob, password));
      const line = fn(latest);
      if (line) latest.log = [{ at: new Date().toISOString(), text: line }, ...latest.log].slice(0, MAX_LOG);
      const out = await encryptBlob(latest, password, blob);
      const res = await gh('PUT', { message: 'Update board', content: btoa(JSON.stringify(out)), sha });
      if (res.status === 409) continue;
      if (!res.ok) throw new Error(ghError(res.status));
      board = latest;
      refresh();
      toast(okMsg);
      return true;
    }
    throw new Error('剛好有其他修改，請再試一次');
  } catch (e) {
    toast('儲存失敗：' + (e.name === 'OperationError' ? '雲端資料的密碼和這裡不同' : e.message));
    return false;
  } finally {
    document.body.classList.remove('busy');
  }
}

async function loadExtra(name) {
  if (extra[name] !== undefined) return extra[name];
  try { extra[name] = await decryptBlob(await fetchJSON(PATHS[name]), password); } catch (e) { extra[name] = e.message === 'nofile' ? null : false; }
  return extra[name]; // false = exists but uses another password
}

/* ---------- 3D scene ---------- */
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef1f5);
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
camera.position.set(60, 60, 60);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6e0, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(-18, 40, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 140 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const city = new THREE.Group();
scene.add(city);
const mat = (color, extraProps = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extraProps });
const place = (mesh, x, y, z, parent) => {
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
};
const box = (w, h, d, m, x, y, z, parent = city) => place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, parent);
const cyl = (r, h, m, x, y, z, parent = city, seg = 12) => place(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m), x, y, z, parent);

const labelLayer = $('#labels');
let pickables = [], animated = [], labels = [], rings = new Map(), parcels = [], civicLabel = {};
let dims = { W: 28, zMin: -9, zMax: 13, street: 5.4 };

function clearCity() {
  city.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  city.clear();
  labelLayer.replaceChildren();
  pickables = []; animated = []; labels = []; rings = new Map(); parcels = []; civicLabel = {};
}
function addLabel(node, pos, id) {
  labelLayer.append(node);
  labels.push({ node, pos, id });
  return node;
}
function civic(x, z, action, build, labelText, labelY) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  city.add(g);
  build(g).forEach((m) => { m.userData.action = action; pickables.push(m); });
  civicLabel[action] = addLabel(el('div', 'label civic', labelText), g.position.clone().add(new THREE.Vector3(0, labelY, 0)));
}

function buildCity() {
  clearCity();
  const people = board.people, S = 10, n = people.length;
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const half = ((rows - 1) / 2) * S;
  const W = (cols - 1) * S + 18, zMin = -half - 9, zMax = half + 13.5;
  const street = half + 5.4, plaza = half + 9.6;
  dims = { W, zMin, zMax, street };

  box(W, 0.4, zMax - zMin, mat(0xe2e7ee), 0, -0.2, (zMin + zMax) / 2).castShadow = false;
  const roadMat = mat(0xc9d0d9);
  const road = (w, d, x, z) => { box(w, 0.1, d, roadMat, x, 0.05, z).castShadow = false; };
  road(W - 2, 1.2, 0, street);
  for (let c = 0; c < cols - 1; c++) road(1.2, street - zMin - 1, (c + 0.5 - (cols - 1) / 2) * S, (zMin + 1 + street) / 2);
  for (let r = 0; r < rows - 1; r++) road(W - 2, 1.2, 0, (r + 0.5 - (rows - 1) / 2) * S);

  people.forEach((p, i) => buildLot(p, new THREE.Vector3((i % cols - (cols - 1) / 2) * S, 0, (Math.floor(i / cols) - (rows - 1) / 2) * S)));

  // Civic buildings on the plaza in front of the main street.
  const x0 = -W / 2 + 3.5, x1 = W / 2 - 3.5, at = (f) => x0 + (x1 - x0) * f;
  civic(at(0), plaza, 'mail', (g) => [
    box(0.3, 1.2, 0.3, mat(0x55606f), 0, 0.6, 0, g), box(1.5, 1, 1.1, mat(0xe5584f), 0, 1.7, 0, g), box(1.1, 0.12, 0.05, mat(0xffffff), 0, 1.8, 0.58, g),
  ], '✉️ 信件', 3);
  civic(at(0.32), plaza, 'calendar', buildHall, '📅 會議', 4.2);
  civic(at(0.64), plaza, 'report', buildReportTower, '📈 週報', 5.4);
  civic(at(1), plaza, 'milestone', buildClockTower, '⏰ 里程碑', 6.6);
  updateCivicLabels();

  const tree = (x, z) => {
    box(0.35, 0.9, 0.35, mat(0x8a6f55), x, 0.45, z);
    place(new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.4, 6), mat(0x7cc29a)), x, 2.1, z, city);
  };
  const tx = W / 2 - 1.4;
  [[-tx, zMin + 1.5], [tx, zMin + 1.5], [-tx, 0], [tx, 0]].forEach(([x, z]) => tree(x, z));

  for (let k = 0; k < 3; k++) parcels.push({ mesh: box(0.55, 0.55, 0.55, mat(0x1f2733), 0, 0.42, street), t: k / 3 });
}

function buildLot(p, pos) {
  const g = new THREE.Group();
  g.position.copy(pos);
  city.add(g);
  const color = new THREE.Color(safeColor(p.color));
  const light = color.clone().lerp(new THREE.Color(0xffffff), 0.75);
  const mine = tasksOf(p.id);
  const open = mine.filter((t) => t.status !== 'done').length;
  const parts = [];

  const ring = box(7.4, 0.2, 7.4, mat(0x1f2733), 0, 0.1, 0, g);
  ring.castShadow = false;
  ring.visible = false;
  rings.set(p.id, ring);
  parts.push(box(6.6, 0.5, 6.6, mat(light), 0, 0.25, 0, g));

  // Building height = open workload; the leader's HQ is a bit taller.
  const h = 1.2 + Math.min(open, 8) * 0.45 + (p.kind === 'leader' ? 0.8 : 0);
  parts.push(box(2.4, h, 2.4, mat(color), -1.7, 0.5 + h / 2, -1.7, g));
  parts.push(box(2.7, 0.22, 2.7, mat(0xffffff), -1.7, 0.5 + h + 0.11, -1.7, g));
  parts.push(box(0.6, 0.9, 0.08, mat(0xffffff), -1.7, 0.95, -0.46, g));
  for (let y = 1.9; y < 0.5 + h - 0.4; y += 0.9) {
    parts.push(box(1.6, 0.35, 0.06, mat(0xdbe7f5), -1.7, y, -0.47, g));
    parts.push(box(0.06, 0.35, 1.6, mat(0xdbe7f5), -0.47, y, -1.7, g));
  }
  let top = 0.5 + h + 0.22;
  if (p.kind === 'leader') {
    parts.push(cyl(0.06, 1.8, mat(0x55606f), -1.7, top + 0.9, -1.7, g));
    const flag = box(1, 0.6, 0.06, mat(color), -1.18, top + 1.45, -1.7, g);
    parts.push(flag);
    animated.push({ type: 'flag', mesh: flag });
    top += 1.8;
  } else if (p.kind === 'claude') {
    parts.push(cyl(0.08, 1.1, mat(0x55606f), -1.7, top + 0.55, -1.7, g));
    const bulb = place(new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 12), mat(color, { emissive: color, emissiveIntensity: 0.5 })), -1.7, top + 1.3, -1.7, g);
    parts.push(bulb);
    animated.push({ type: 'glow', mesh: bulb });
    top += 1.6;
  }

  // One crate per task (up to 18), most urgent first; focus tasks get a star on top.
  sortTasks(mine).slice(0, 18).forEach((t, k) => {
    const m = mat(STATUS[t.status].color, t.status === 'blocked' ? { emissive: 0xe5584f, emissiveIntensity: 0 } : {});
    const crate = box(0.78, 0.78, 0.78, m, 0.6 + (k % 3), 0.89, -2.5 + Math.floor(k / 3), g);
    parts.push(crate);
    if (t.status === 'doing') animated.push({ type: 'bob', mesh: crate, phase: k });
    if (t.status === 'blocked') animated.push({ type: 'pulse', mesh: crate });
    if (t.focus && t.status !== 'done') {
      const star = place(new THREE.Mesh(new THREE.OctahedronGeometry(0.22), mat(0xffc93c, { emissive: 0xffb000, emissiveIntensity: 0.6 })), 0, 0.68, 0, crate);
      animated.push({ type: 'spin', mesh: star });
    }
  });
  parts.forEach((m) => { m.userData.person = p.id; pickables.push(m); });

  const label = el('div', 'label');
  const dot = el('span', 'dot');
  dot.style.background = safeColor(p.color);
  label.append(dot, el('span', '', p.name), el('small', '', `${mine.filter((t) => t.status === 'done').length}/${mine.length}`));
  if (mine.some((t) => t.status === 'blocked' || isOverdue(t))) label.append(el('span', 'warn', '!'));
  addLabel(label, g.position.clone().add(new THREE.Vector3(-1.7, top + 0.5, -1.7)), p.id);
}

function buildHall(g) {
  const parts = [
    box(4.6, 0.3, 3.4, mat(0xd5ecea), 0, 0.15, 0, g),
    box(3.8, 1.5, 2, mat(0xffffff), 0, 1.05, -0.4, g),
    box(4.2, 0.18, 2.9, mat(0xe9eef2), 0, 1.89, 0, g),
  ];
  for (const x of [-1.6, -0.55, 0.55, 1.6]) parts.push(cyl(0.13, 1.5, mat(0xf4f6f8), x, 1.05, 1.1, g));
  const roof = place(new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 4.3, 3), mat(0x3fb6b2)), 0, 2.35, 0, g);
  roof.rotation.set(0, 0, Math.PI / 2);
  roof.rotation.x = -Math.PI / 2;
  roof.scale.set(1, 1, 0.42);
  parts.push(roof, box(0.9, 1, 0.08, mat(0x3fb6b2), 0, 0.8, 0.62, g));
  return parts;
}

function buildReportTower(g) {
  const purple = mat(0x8e6bd6), win = mat(0xe8defc);
  const parts = [box(2.6, 0.3, 2.6, mat(0xe6def6), 0, 0.15, 0, g)];
  [[2, 1.3], [1.6, 1.2], [1.2, 1.1]].reduce((y, [s, h]) => {
    parts.push(box(s, h, s, purple, 0, y + h / 2, 0, g), box(s * 0.7, 0.3, 0.06, win, 0, y + h / 2, s / 2 + 0.01, g), box(0.06, 0.3, s * 0.7, win, s / 2 + 0.01, y + h / 2, 0, g));
    return y + h;
  }, 0.3);
  const top = 0.3 + 1.3 + 1.2 + 1.1;
  [[0x5b8def, 0.5], [0xf2a93b, 0.8], [0x4caf7d, 1.15]].forEach(([c, h], i) => {
    const b = box(0.26, h, 0.26, mat(c), -0.35 + i * 0.35, top + h / 2, 0, g);
    parts.push(b);
    animated.push({ type: 'grow', mesh: b, base: top, h, phase: i });
  });
  return parts;
}

function buildClockTower(g) {
  const stone = mat(0xe9d8b4);
  const parts = [box(2, 0.4, 2, mat(0xd8c49a), 0, 0.2, 0, g), box(1.3, 4.4, 1.3, stone, 0, 2.6, 0, g), box(1.6, 0.25, 1.6, mat(0xd8c49a), 0, 4.9, 0, g)];
  const cap = place(new THREE.Mesh(new THREE.ConeGeometry(1.15, 1.3, 4), mat(0x55606f)), 0, 5.68, 0, g);
  cap.rotation.y = Math.PI / 4;
  parts.push(cap);
  // Clock faces on the two sides facing the camera, with hands showing the real time.
  [[0, 0.66, 0], [0.66, 0, Math.PI / 2]].forEach(([x, z, ry]) => {
    const face = new THREE.Group();
    face.position.set(x, 4.05, z);
    face.rotation.y = ry;
    g.add(face);
    const disc = place(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 24), mat(0xffffff)), 0, 0, 0, face);
    disc.rotation.x = Math.PI / 2;
    parts.push(disc);
    const hand = (len, w) => {
      const pivot = new THREE.Group();
      pivot.position.z = 0.05;
      face.add(pivot);
      place(new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.03), mat(0x1f2733)), 0, len / 2, 0, pivot);
      return pivot;
    };
    animated.push({ type: 'clock', hour: hand(0.26, 0.06), minute: hand(0.4, 0.04) });
  });
  return parts;
}

function updateCivicLabels() {
  if (!board || !civicLabel.calendar) return;
  const cal = extra.calendar;
  const todays = cal?.days?.find((d) => d.date === today());
  // Short labels: the plaza is narrow on phones. Details live in each panel.
  civicLabel.calendar.textContent = todays ? `📅 ${todays.events.length} 場` : '📅 會議';
  const next = nextMilestone();
  civicLabel.milestone.textContent = next ? `⏰ ${left(daysLeft(next.date))}` : '⏰ 里程碑';
  if (extra.mail) {
    const d = extra.mail.days?.[0];
    const high = d?.date === today() ? d.items.filter((m) => m.priority === 'high').length : 0;
    civicLabel.mail.textContent = high ? `✉️ ${high} 重要` : '✉️ 信件';
  }
}
const nextMilestone = () => [...board.milestones].filter((m) => daysLeft(m.date) >= 0).sort((a, b) => a.date.localeCompare(b.date))[0];

/* ---------- camera / controls ---------- */
const controls = new OrbitControls(camera, canvas);
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
controls.minZoom = 0.6;
controls.maxZoom = 4;

function fitView() {
  const w = innerWidth, h = innerHeight;
  const narrow = w <= 720;
  const open = document.body.classList.contains('panel-open');
  // On wide screens the panel covers the right 386px: fit the city into what's left.
  const availW = !narrow && open ? Math.max(w - 386, w * 0.4) : w;
  renderer.setSize(w, h, false);
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  let mr = 0, mu = 0;
  for (const x of [-dims.W / 2, dims.W / 2]) for (const z of [dims.zMin, dims.zMax]) for (const y of [0, 7]) {
    const p = new THREE.Vector3(x, y, z);
    mr = Math.max(mr, Math.abs(p.dot(right)));
    mu = Math.max(mu, Math.abs(p.dot(up)));
  }
  const half = Math.max(mu * 1.1, (mr * 0.98) / (availW / h));
  // Keep the city clear of the header; on phones, lift it above the open bottom sheet.
  const hudH = $('#hud').offsetHeight || 0;
  const pad = narrow && open ? -half * 0.3 : (hudH / h) * half * (narrow ? 0.7 : 0.9);
  const perPx = (2 * half) / h, shift = ((w - availW) / 2) * perPx;
  camera.left = (-w / 2) * perPx + shift; camera.right = (w / 2) * perPx + shift;
  camera.top = half + pad; camera.bottom = -half + pad;
  camera.updateProjectionMatrix();
}
addEventListener('resize', fitView);
fitView();

const raycaster = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!board || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 7) return;
  raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  if (!hit) return;
  const { action, person: id } = hit.object.userData;
  showView(action ? { type: action } : { type: 'person', id });
});

const clock = new THREE.Clock();
const v = new THREE.Vector3();
(function tick() {
  const t = clock.getElapsedTime();
  const now = new Date(), mins = now.getMinutes() + now.getSeconds() / 60;
  for (const a of animated) {
    if (a.type === 'bob') a.mesh.position.y = 0.89 + Math.abs(Math.sin(t * 2.2 + a.phase)) * 0.45;
    else if (a.type === 'pulse') a.mesh.material.emissiveIntensity = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 5));
    else if (a.type === 'glow') a.mesh.material.emissiveIntensity = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.5));
    else if (a.type === 'flag') a.mesh.rotation.y = Math.sin(t * 2) * 0.2;
    else if (a.type === 'spin') { a.mesh.rotation.y = t * 2; a.mesh.position.y = 0.68 + Math.sin(t * 3) * 0.06; }
    else if (a.type === 'grow') { const s = 0.75 + 0.25 * Math.sin(t * 1.6 + a.phase); a.mesh.scale.y = s; a.mesh.position.y = a.base + (a.h * s) / 2; }
    else if (a.type === 'clock') {
      a.minute.rotation.z = -(mins / 60) * Math.PI * 2;
      a.hour.rotation.z = -(((now.getHours() % 12) + mins / 60) / 12) * Math.PI * 2;
    }
  }
  for (const p of parcels) p.mesh.position.x = -dims.W / 2 + 2 + ((p.t + t * 0.03) % 1) * (dims.W - 4);
  controls.update();
  renderer.render(scene, camera);
  for (const l of labels) {
    v.copy(l.pos).project(camera);
    l.node.style.left = ((v.x + 1) / 2) * innerWidth + 'px';
    l.node.style.top = ((1 - v.y) / 2) * innerHeight + 'px';
  }
  requestAnimationFrame(tick);
})();

/* ---------- HUD: chips and today's three ---------- */
function focusTasks() {
  const starred = sortTasks(board.tasks.filter((t) => t.focus && t.status !== 'done'));
  if (starred.length) return { list: starred.slice(0, MAX_FOCUS), auto: false };
  const mine = sortTasks(tasksOf(leader().id).filter((t) => t.status !== 'done'));
  return { list: mine.slice(0, MAX_FOCUS), auto: true };
}

function updateHud() {
  $('#hud').hidden = false;
  $('#nav').hidden = false;
  $('#hud-title').textContent = board.project.name;
  document.title = board.project.name;
  const chips = $('#hud-chips');
  chips.replaceChildren();
  const chip = (label, value, warn) => {
    const c = el('div', 'chip' + (warn ? ' warn' : ''), label + ' ');
    c.append(el('b', '', value));
    chips.append(c);
  };
  const ts = board.tasks;
  chip('整體進度', pct(ts) + '%');
  chip('進行中', String(ts.filter((t) => t.status === 'doing').length));
  const blocked = ts.filter((t) => t.status === 'blocked').length;
  if (blocked) chip('卡關', String(blocked), true);
  const overdue = ts.filter(isOverdue).length;
  if (overdue) chip('逾期', String(overdue), true);

  const card = $('#focus');
  const { list, auto } = focusTasks();
  card.replaceChildren();
  card.hidden = !list.length;
  const head = el('div', 'focus-head', '⭐ 今日三件事');
  if (auto) head.append(el('small', '', '自動挑選'));
  card.append(head);
  list.forEach((t) => {
    const r = el('div', 'focus-row');
    r.append(el('span', 'fdot ' + t.status), el('span', 'ft', t.title));
    if (t.owner !== leader().id) r.append(el('small', '', ownerName(t)));
    else if (t.due) r.append(el('small', isOverdue(t) ? 'late' : '', left(daysLeft(t.due))));
    r.onclick = () => showView({ type: 'person', id: t.owner });
    card.append(r);
  });
}

/* ---------- panels ---------- */
const panel = $('#panel'), body = $('#panel-body'), title = $('#panel-title');
const NAV_OF = { dashboard: 'dashboard', team: 'team', mail: 'mail', settings: 'settings' };

function openPanel(name, view) {
  title.textContent = name;
  body.replaceChildren();
  panel.hidden = false;
  currentView = view;
  if (!document.body.classList.contains('panel-open')) {
    document.body.classList.add('panel-open');
    fitView();
  }
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === NAV_OF[view.type]));
  select(view.type === 'person' ? view.id : null);
}
function closePanel() {
  panel.hidden = true;
  currentView = null;
  document.body.classList.remove('panel-open');
  document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('on'));
  select(null);
  fitView();
}
function select(id) {
  rings.forEach((r, k) => (r.visible = k === id));
  labels.forEach((l) => l.node.classList.toggle('sel', !!id && l.id === id));
}
$('#panel-close').onclick = closePanel;
document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => showView({ type: b.dataset.view })));

const VIEWS = {
  person: showPerson, dashboard: showDashboard, team: showTeam, mail: showMail, settings: showSettings,
  calendar: showCalendar, report: showReport, milestone: showMilestones, log: showLog,
};
function showView(view) {
  const same = currentView && currentView.type === view.type && currentView.id === view.id;
  const scroll = same ? body.scrollTop : 0;
  const r = VIEWS[view.type](view);
  if (r instanceof Promise) r.then(() => { body.scrollTop = scroll; });
  else body.scrollTop = scroll;
}
function refresh() {
  updateHud();
  buildCity();
  fitView();
  if (currentView) {
    if (currentView.type === 'person' && !person(currentView.id)) closePanel();
    else showView(currentView);
  }
}

const field = (type, placeholder, value = '') => {
  const i = el('input', 'field');
  i.type = type;
  if (placeholder) i.placeholder = placeholder;
  i.value = value;
  return i;
};
const button = (text, cls, onclick) => {
  const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
};
const bar = (value, color) => {
  const b = el('div', 'bar'), i = el('i');
  i.style.width = value + '%';
  i.style.background = color;
  b.append(i);
  return b;
};
function swatches(current) {
  const wrap = el('div', 'swatches');
  let value = safeColor(current || PALETTE[0]);
  PALETTE.forEach((c) => {
    const s = el('button', 'sw' + (c === value ? ' on' : ''));
    s.type = 'button';
    s.style.background = c;
    s.setAttribute('aria-label', '顏色 ' + c);
    s.onclick = () => {
      value = c;
      wrap.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === s));
    };
    wrap.append(s);
  });
  return { node: wrap, get value() { return value; } };
}
const editHint = () => el('div', 'hint', REPO ? '目前是唯讀。要在這裡新增或修改，請先到 ⚙️ 設定 GitHub 權杖。' : '這個網址無法儲存修改。');
const timeAgo = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小時前`;
  return md(ymd(new Date(iso)));
};

function taskRow(t, showOwner) {
  const wrap = el('div');
  const r = el('div', 'row' + (canEdit() ? ' click' : '')), g = el('div', 'grow');
  const tt = el('div', 't', (t.focus && t.status !== 'done' ? '⭐ ' : '') + t.title);
  g.append(tt);
  const sub = [showOwner ? ownerName(t) : null, t.due ? dueText(t.due) : null, t.note].filter(Boolean).join(' · ');
  if (sub) g.append(el('div', 's' + (isOverdue(t) ? ' late' : ''), sub));
  r.append(g, el('span', 'tag ' + t.status, STATUS[t.status].label));
  wrap.append(r);
  if (canEdit()) {
    let editor = null;
    r.onclick = () => {
      if (editor) { editor.remove(); editor = null; return; }
      editor = taskEditor(t);
      wrap.append(editor);
    };
  }
  return wrap;
}

function taskEditor(t) {
  const box = el('div', 'editor');
  let status = t.status, focus = !!t.focus;
  const seg = el('div', 'seg');
  Object.entries(STATUS).forEach(([k, s]) => {
    const b = el('button', k === status ? 'on' : '', s.label);
    b.type = 'button';
    b.onclick = () => { status = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    seg.append(b);
  });
  const star = el('button', 'star' + (focus ? ' on' : ''), '⭐ 今日三件事');
  star.type = 'button';
  star.onclick = () => {
    if (!focus && board.tasks.filter((x) => x.focus && x.status !== 'done' && x.id !== t.id).length >= MAX_FOCUS) {
      toast(`最多 ${MAX_FOCUS} 件，請先取消一件`);
      return;
    }
    focus = !focus;
    star.classList.toggle('on', focus);
  };
  const name = field('text', '任務名稱', t.title);
  const owner = el('select', 'field');
  board.people.forEach((p) => {
    const o = el('option', '', '負責：' + p.name);
    o.value = p.id;
    o.selected = p.id === t.owner;
    owner.append(o);
  });
  const due = field('date', '', t.due || '');
  const note = field('text', '備註（卡關時寫原因）', t.note || '');
  const row = el('div', 'btn-row');
  row.append(
    button('儲存', '', () => mutate((b) => {
      const x = b.tasks.find((y) => y.id === t.id);
      if (!x) return null;
      const before = x.status;
      x.title = name.value.trim() || x.title;
      x.status = status;
      if (status === 'done' && before !== 'done') x.doneAt = today();
      if (status !== 'done') delete x.doneAt;
      if (b.people.some((p) => p.id === owner.value)) x.owner = owner.value;
      x.due = due.value || undefined;
      x.note = note.value.trim() || undefined;
      x.focus = focus || undefined;
      x.updated = today();
      const who = b.people.find((p) => p.id === x.owner)?.name ?? '';
      return before !== x.status ? `「${x.title}」→ ${STATUS[x.status].label}（${who}）` : `更新任務「${x.title}」（${who}）`;
    })),
    button('刪除', 'danger', () => {
      if (confirm(`刪除任務「${t.title}」？`)) mutate((b) => { b.tasks = b.tasks.filter((y) => y.id !== t.id); return `刪除任務「${t.title}」`; }, '已刪除');
    }),
  );
  box.append(seg, star, name, owner, due, note, row);
  return box;
}

function newTask(owner, title, extraFields = {}) {
  return { id: uid(), owner, title, status: 'todo', createdAt: today(), updated: today(), ...extraFields };
}

function showPerson({ id }) {
  const p = person(id);
  if (!p) return closePanel();
  openPanel(p.name, { type: 'person', id });
  const mine = tasksOf(id);
  const done = mine.filter((t) => t.status === 'done').length;
  body.append(el('div', 'muted', p.role || ''), el('div', 'big', pct(mine) + '%'),
    el('div', 'muted', `完成 ${done} / ${mine.length} · 進行中 ${mine.filter((t) => t.status === 'doing').length}`));
  const b = bar(pct(mine), safeColor(p.color));
  b.style.marginTop = '8px';
  body.append(b);
  if (p.kind === 'claude') body.append(el('div', 'hint', '交辦給 Claude：在這裡新增的任務，下次你打開 Claude 時，我會先列出來，一件一件跟你確認後再做。'));
  if (!canEdit()) body.append(editHint());

  body.append(el('div', 'sec', '任務'));
  if (!mine.length) body.append(el('div', 'muted', '還沒有任務。'));
  sortTasks(mine).forEach((t) => body.append(taskRow(t)));

  if (!canEdit()) return;
  body.append(el('div', 'sec', p.kind === 'claude' ? '交辦給 Claude' : '新增任務'));
  const name = field('text', p.kind === 'claude' ? '想請 Claude 做什麼？' : '任務名稱');
  const due = field('date');
  const add = button(p.kind === 'claude' ? '＋ 交辦' : '＋ 新增任務', '', () => {
    const t = name.value.trim();
    if (!t) return name.focus();
    mutate((bd) => {
      bd.tasks.push(newTask(id, t, { due: due.value || undefined }));
      return p.kind === 'claude' ? `交辦給 Claude：「${t}」` : `${p.name} 新增任務「${t}」`;
    }, p.kind === 'claude' ? '已交辦' : '已新增任務');
  });
  name.onkeydown = (e) => { if (e.key === 'Enter') add.click(); };
  body.append(name, due, add);

  body.append(el('div', 'sec', p.kind === 'member' ? '成員資料' : '名稱'));
  const pname = field('text', '名字', p.name);
  const role = field('text', '角色（例如：電子工程）', p.role || '');
  const sw = swatches(p.color);
  body.append(pname, role, sw.node, button('儲存資料', 'ghost', () => {
    const nm = pname.value.trim();
    if (!nm) return pname.focus();
    mutate((bd) => {
      const x = bd.people.find((y) => y.id === id);
      if (x) Object.assign(x, { name: nm, role: role.value.trim(), color: sw.value });
      return `更新 ${nm} 的資料`;
    });
  }));
  if (p.kind === 'member') {
    body.append(button('移除成員', 'danger', () => {
      const n = mine.length;
      if (confirm(`移除「${p.name}」？${n ? `他的 ${n} 個任務也會一起刪除。` : ''}`)) {
        mutate((bd) => {
          bd.people = bd.people.filter((y) => y.id !== id);
          bd.tasks = bd.tasks.filter((y) => y.owner !== id);
          return `移除成員 ${p.name}`;
        }, '已移除成員');
      }
    }));
  }
}

function logRows(entries) {
  return entries.map((e) => {
    const r = el('div', 'row'), g = el('div', 'grow');
    g.append(el('div', 'lt', e.text), el('div', 's', timeAgo(e.at)));
    r.append(g);
    return r;
  });
}

function showDashboard() {
  openPanel('總覽', { type: 'dashboard' });
  const ts = board.tasks;
  body.append(el('div', 'big', pct(ts) + '%'), el('div', 'muted', `整體進度 · 共 ${ts.length} 個任務`));
  const quick = el('div', 'quick');
  [['📅', '行程', 'calendar'], ['📈', '週報', 'report'], ['⏰', '里程碑', 'milestone']].forEach(([i, t, v]) => {
    const b = el('button', '', `${i} ${t}`);
    b.type = 'button';
    b.onclick = () => showView({ type: v });
    quick.append(b);
  });
  body.append(quick);

  body.append(el('div', 'sec', '每個人'));
  board.people.forEach((p) => {
    const mine = tasksOf(p.id);
    const r = el('div', 'row click'), g = el('div', 'grow');
    const nm = el('div', 't', p.name);
    nm.style.marginBottom = '6px';
    g.append(nm, bar(pct(mine), safeColor(p.color)));
    r.append(g, el('b', '', pct(mine) + '%'));
    r.onclick = () => showView({ type: 'person', id: p.id });
    body.append(r);
  });
  const blocked = ts.filter((t) => t.status === 'blocked' || isOverdue(t));
  if (blocked.length) {
    body.append(el('div', 'sec', '卡關與逾期'));
    sortTasks(blocked).forEach((t) => body.append(taskRow(t, true)));
  }
  const upcoming = ts.filter((t) => t.due && t.status !== 'done' && daysLeft(t.due) >= 0).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8);
  if (upcoming.length) {
    body.append(el('div', 'sec', '即將到期'));
    upcoming.forEach((t) => body.append(taskRow(t, true)));
  }
  body.append(el('div', 'sec', '最近更新'));
  if (!board.log.length) body.append(el('div', 'muted', '還沒有更新紀錄。'));
  body.append(...logRows(board.log.slice(0, 6)));
  if (board.log.length > 6) body.append(button('查看全部更新', 'ghost', () => showView({ type: 'log' })));
}

function showLog() {
  openPanel('最近更新', { type: 'log' });
  body.append(...logRows(board.log));
}

function showTeam() {
  openPanel('團隊', { type: 'team' });
  board.people.forEach((p) => {
    const mine = tasksOf(p.id);
    const r = el('div', 'row click'), a = el('div', 'avatar', p.kind === 'claude' ? '✦' : p.name.slice(0, 1)), g = el('div', 'grow');
    a.style.background = safeColor(p.color);
    g.append(el('div', 't', p.name), el('div', 's', `${p.role || ''} · 未完成 ${mine.filter((t) => t.status !== 'done').length} / 共 ${mine.length}`));
    r.append(a, g);
    if (mine.some((t) => t.status === 'blocked')) r.append(el('span', 'tag blocked', '卡關'));
    r.onclick = () => showView({ type: 'person', id: p.id });
    body.append(r);
  });
  if (!canEdit()) return body.append(editHint());
  body.append(el('div', 'sec', '新增成員'));
  const name = field('text', '名字');
  const role = field('text', '角色（例如：電子工程）');
  const used = new Set(board.people.map((p) => p.color));
  const sw = swatches(PALETTE.find((c) => !used.has(c)));
  body.append(name, role, sw.node, button('＋ 新增成員', '', () => {
    const nm = name.value.trim();
    if (!nm) return name.focus();
    mutate((b) => { b.people.push({ id: uid(), name: nm, role: role.value.trim(), color: sw.value, kind: 'member' }); return `新增成員 ${nm}`; }, `已新增 ${nm}`);
  }));
}

function showMilestones() {
  openPanel('里程碑', { type: 'milestone' });
  const list = [...board.milestones].sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) body.append(el('div', 'muted', '還沒有里程碑。加上重要日期（例如試產、交貨、發表會），鐘塔會倒數。'));
  list.forEach((m) => {
    const n = daysLeft(m.date);
    const r = el('div', 'row'), g = el('div', 'grow');
    g.append(el('div', 't', m.title), el('div', 's', md(m.date)));
    r.append(g, el('span', 'count' + (n < 0 ? ' past' : n <= 7 ? ' soon' : ''), n < 0 ? '已過' : n === 0 ? '今天' : `${n} 天`));
    if (canEdit()) {
      const del = el('button', 'x', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', '刪除');
      del.onclick = () => { if (confirm(`刪除里程碑「${m.title}」？`)) mutate((b) => { b.milestones = b.milestones.filter((y) => y.id !== m.id); return `刪除里程碑「${m.title}」`; }, '已刪除'); };
      r.append(del);
    }
    body.append(r);
  });
  if (!canEdit()) return body.append(editHint());
  body.append(el('div', 'sec', '新增里程碑'));
  const name = field('text', '名稱（例如：試產 50 台）');
  const date = field('date');
  body.append(name, date, button('＋ 新增里程碑', '', () => {
    const t = name.value.trim();
    if (!t) return name.focus();
    if (!date.value) return date.focus();
    mutate((b) => { b.milestones.push({ id: uid(), title: t, date: date.value }); return `新增里程碑「${t}」${md(date.value)}`; }, '已新增里程碑');
  }));
}

/* ---------- weekly report ---------- */
function liveWeek() {
  const [from, to] = weekRange();
  const inWeek = (d) => d && d >= from && d <= to;
  const done = board.tasks.filter((t) => t.status === 'done' && inWeek(t.doneAt || t.updated));
  const blocked = board.tasks.filter((t) => t.status === 'blocked');
  const overdue = board.tasks.filter(isOverdue);
  const nextDue = board.tasks.filter((t) => t.due && t.status !== 'done' && daysLeft(t.due) >= 0 && daysLeft(t.due) <= 7).sort((a, b) => a.due.localeCompare(b.due));
  return { from, to, done, blocked, overdue, nextDue };
}
function weekText(w) {
  const lines = [`${board.project.name} 週報 ${md(w.from)}–${md(w.to)}`, ''];
  const sec = (t, items, fmt) => { lines.push(`${t}（${items.length}）`); items.forEach((x) => lines.push('- ' + fmt(x))); if (!items.length) lines.push('- 無'); lines.push(''); };
  sec('本週完成', w.done, (t) => `${t.title}（${ownerName(t)}）`);
  sec('卡關', w.blocked, (t) => `${t.title}（${ownerName(t)}）${t.note ? '：' + t.note : ''}`);
  if (w.overdue.length) sec('逾期', w.overdue, (t) => `${t.title}（${ownerName(t)}，${md(t.due)}）`);
  sec('接下來 7 天到期', w.nextDue, (t) => `${md(t.due)} ${t.title}（${ownerName(t)}）`);
  return lines.join('\n').trim();
}

async function showReport() {
  openPanel('週報塔', { type: 'report' });
  const w = liveWeek();
  body.append(el('div', 'muted', `本週 ${md(w.from)}–${md(w.to)}（即時）`));
  const stats = el('div', 'stats');
  [['完成', w.done.length, 'done'], ['卡關', w.blocked.length, 'blocked'], ['逾期', w.overdue.length, 'blocked'], ['7 天內到期', w.nextDue.length, 'doing']].forEach(([l, n, c]) => {
    const s = el('div', 'stat ' + c);
    s.append(el('b', '', String(n)), el('span', '', l));
    stats.append(s);
  });
  body.append(stats);
  const group = (t, items, owner = true) => {
    if (!items.length) return;
    body.append(el('div', 'sec', t));
    items.forEach((x) => body.append(taskRow(x, owner)));
  };
  group('本週完成', w.done);
  group('卡關', w.blocked);
  group('逾期', w.overdue);
  group('接下來 7 天到期', w.nextDue);
  body.append(button('📋 複製週報文字', '', async () => {
    try { await navigator.clipboard.writeText(weekText(w)); toast('已複製，可以貼到訊息或信件'); } catch { toast('無法複製，請改用電腦'); }
  }));

  const archive = el('div');
  body.append(el('div', 'sec', '每週五的週報'), archive);
  archive.append(el('div', 'muted', '讀取中…'));
  const reports = await loadExtra('reports');
  if (currentView?.type !== 'report') return;
  archive.replaceChildren();
  const weeks = reports?.weeks ?? [];
  if (!weeks.length) return archive.append(el('div', 'muted', '每週五下午 5 點，排程會整理一份週報放在這裡。'));
  const render = (i) => {
    const wk = weeks[i];
    const tabs = el('div', 'days');
    weeks.forEach((x, k) => {
      const b = el('button', k === i ? 'on' : '', `${md(x.from)}–${md(x.to)}`);
      b.type = 'button';
      b.onclick = () => render(k);
      tabs.append(b);
    });
    const list = (t, items) => {
      if (!items?.length) return [];
      const ul = el('ul', 'plain');
      items.forEach((s) => ul.append(el('li', '', s)));
      return [el('div', 'sub', t), ul];
    };
    archive.replaceChildren(tabs, el('div', 'summary', wk.summary || ''), ...list('完成', wk.done), ...list('卡關', wk.blocked), ...list('下週重點', wk.next));
  };
  render(0);
}

/* ---------- calendar ---------- */
async function showCalendar() {
  openPanel('會議廳', { type: 'calendar' });
  body.append(el('div', 'muted', '讀取中…'));
  const cal = await loadExtra('calendar');
  if (currentView?.type !== 'calendar') return;
  body.replaceChildren();
  if (!cal) return body.append(el('div', 'muted', cal === false ? '行程檔的密碼和看板不同。' : '還沒有行程。每天早上排程會從 Google 日曆抓今天和明天的會議。'));
  const days = (cal.days ?? []).filter((d) => d.date >= today());
  if (!days.length) return body.append(el('div', 'muted', '今天和明天沒有行程資料，等明早排程更新。'));
  const nowHM = new Date().toTimeString().slice(0, 5);
  days.forEach((d) => {
    body.append(el('div', 'sec', `${d.date === today() ? '今天' : d.date === addDays(today(), 1) ? '明天' : ''} ${md(d.date)} · ${d.events.length} 場`));
    if (!d.events.length) body.append(el('div', 'muted', '沒有會議。'));
    let marked = false;
    d.events.forEach((e) => {
      const r = el('div', 'row event'), time = el('div', 'time', e.start ? e.start : '全天'), g = el('div', 'grow');
      if (e.end && e.start) time.append(el('small', '', e.end));
      g.append(el('div', 't', e.title));
      if (e.location) g.append(el('div', 's', e.location));
      if (d.date === today() && !marked && e.start && (e.end || e.start) >= nowHM) { r.classList.add('next'); marked = true; }
      if (d.date === today() && e.end && e.end < nowHM) r.classList.add('past');
      r.append(time, g);
      body.append(r);
    });
  });
  if (cal.generated) body.append(el('div', 'muted foot', `更新於 ${timeAgo(cal.generated)}`));
}

/* ---------- settings ---------- */
function showSettings() {
  openPanel('設定', { type: 'settings' });
  body.append(el('div', 'sec', '看板名稱'));
  const name = field('text', '看板名稱', board.project.name);
  name.disabled = !canEdit();
  body.append(name);
  if (canEdit()) body.append(button('儲存名稱', 'ghost', () => {
    const nm = name.value.trim();
    if (nm) mutate((b) => { b.project.name = nm; return `看板改名為「${nm}」`; });
  }));

  body.append(el('div', 'sec', '在網頁上編輯'));
  if (isLocal) {
    body.append(el('div', 'muted', '本機預覽：修改會直接寫入這台電腦上的檔案，不需要權杖。'));
  } else if (!REPO) {
    body.append(el('div', 'muted', '只有在 GitHub Pages 網址上才能編輯。'));
  } else {
    body.append(el('div', 'muted', token()
      ? '這台裝置已設定權杖，可以新增與修改。'
      : '目前是唯讀。每台要編輯的裝置（電腦、手機）都要設定一次。'));
    const steps = el('ol', 'steps');
    ['打開下方連結，建立 Fine-grained token',
      `Repository access 選 Only select repositories，只勾 ${REPO.repo}`,
      'Permissions 裡把 Contents 設為 Read and write，其他都不用開',
      '建立後複製權杖，貼到下面儲存'].forEach((s) => steps.append(el('li', '', s)));
    const link = el('a', 'link', '建立權杖 ↗');
    link.href = 'https://github.com/settings/personal-access-tokens/new';
    link.target = '_blank';
    link.rel = 'noopener';
    const input = field('password', '貼上權杖（github_pat_…）');
    input.autocomplete = 'off';
    body.append(steps, link, input, button('儲存權杖', '', async () => {
      const val = input.value.trim();
      if (!val) return input.focus();
      localStorage.setItem(LS_TOKEN, val);
      input.value = '';
      try { await readRemote(); toast('權杖已儲存'); } catch (e) { toast('權杖已儲存，但讀取失敗：' + e.message); }
      refresh();
    }));
    if (token()) body.append(button('移除這台裝置的權杖', 'ghost', () => {
      localStorage.removeItem(LS_TOKEN);
      toast('已移除權杖');
      refresh();
    }));
  }

  body.append(el('div', 'sec', '加到主畫面'));
  body.append(el('div', 'muted', 'iPhone：用 Safari 打開，按分享 → 加入主畫面。Android：Chrome 選單 → 加到主畫面。電腦：Chrome 網址列右側的安裝圖示。'));

  body.append(el('div', 'sec', '這台裝置'));
  body.append(el('div', 'muted', localStorage.getItem(LS_PW) ? '這台裝置記住了密碼。' : '這台裝置沒有記住密碼，每次打開都要輸入。'));
  body.append(button('上鎖並忘記密碼', 'ghost', () => { localStorage.removeItem(LS_PW); location.reload(); }));
}

/* ---------- mail digest ---------- */
async function showMail() {
  openPanel('每日信件摘要', { type: 'mail' });
  if (extra.mail) return renderDigest(0);
  body.append(el('div', 'muted', '解密中…'));
  const mail = await loadExtra('mail');
  if (currentView?.type !== 'mail') return;
  body.replaceChildren();
  if (mail) { updateCivicLabels(); return renderDigest(0); }
  if (mail === null) return body.append(el('div', 'muted', '還沒有信件摘要，排程第一次執行後就會出現。'));

  const form = el('form', 'lock');
  const input = field('password', '信件摘要的密碼');
  const err = el('div', 'err');
  const btn = el('button', 'btn', '解鎖');
  btn.type = 'submit';
  form.append(el('div', 'ico', '🔒'), el('div', 'muted', '信件摘要用的密碼和看板不同。'), input, btn, err);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!input.value) return;
    btn.disabled = true;
    try { extra.mail = await decryptBlob(await fetchJSON(PATHS.mail), input.value); renderDigest(0); } catch { err.textContent = '密碼不正確。'; btn.disabled = false; }
  };
  body.append(form);
}

function renderDigest(index) {
  body.replaceChildren();
  const days = extra.mail.days ?? [];
  if (!days.length) return body.append(el('div', 'muted', '目前沒有摘要。'));
  const tabs = el('div', 'days');
  days.forEach((d, i) => {
    const b = el('button', i === index ? 'on' : '', md(d.date));
    b.type = 'button';
    b.onclick = () => renderDigest(i);
    tabs.append(b);
  });
  const day = days[index];
  body.append(tabs, el('div', 'summary', day.summary));
  body.append(el('div', 'sec', `信件（${day.items.length}）`));
  const me = leader();
  day.items.forEach((m, i) => {
    const box = el('div', 'mail'), top = el('div', 'top');
    top.append(el('div', 'subj', m.subject), el('span', 'tag ' + (PRIORITY[m.priority] ? m.priority : 'low'), PRIORITY[m.priority] ?? PRIORITY.low));
    box.append(top, el('div', 'from', m.from), el('div', 'gist', m.gist));
    if (m.action) box.append(el('div', 'act', '→ ' + m.action));
    if (m.priority === 'high' || m.priority === 'mid' || m.action) {
      const key = `mail:${day.date}:${i}`;
      const existing = board.tasks.find((t) => t.source === key);
      if (existing) {
        box.append(el('div', 'added', `✓ 已在任務中（${STATUS[existing.status].label}）`));
      } else if (canEdit()) {
        box.append(button('＋ 加到我的任務', 'small', () => {
          const due = isDate(m.due) ? m.due : m.priority === 'high' ? day.date : undefined;
          const note = (m.action || m.gist || '').slice(0, 120);
          mutate((b) => {
            if (b.tasks.some((t) => t.source === key)) return null;
            b.tasks.push(newTask(b.people.find((p) => p.kind === 'leader').id, m.subject, { due, note, source: key }));
            return `從信件加入任務「${m.subject}」`;
          }, `已加到 ${me.name} 的任務`);
        }));
      }
    }
    body.append(box);
  });
}

/* ---------- unlock ---------- */
async function unlock(pw) {
  const data = await decryptBlob(await loadBlob(), pw);
  password = pw;
  board = normalize(data);
  $('#lock').hidden = true;
  refresh();
  // Load the side files in the background so the civic labels can show today's numbers.
  Promise.all([loadExtra('calendar'), loadExtra('mail')]).then(updateCivicLabels);
}

$('#lock-form').onsubmit = async (e) => {
  e.preventDefault();
  const pw = $('#lock-pw').value;
  if (!pw) return;
  const btn = $('#lock-btn'), err = $('#lock-err');
  btn.disabled = true;
  btn.textContent = '解鎖中…';
  err.textContent = '';
  try {
    await unlock(pw);
    if ($('#lock-remember').checked) localStorage.setItem(LS_PW, pw);
  } catch (ex) {
    err.textContent = ex.message === 'nofile' ? '還沒有看板資料檔。' : '密碼不正確。';
  } finally {
    btn.disabled = false;
    btn.textContent = '解鎖';
  }
};

(async () => {
  const saved = localStorage.getItem(LS_PW);
  if (saved) {
    try { await unlock(saved); return; } catch (e) { if (e.name === 'OperationError') localStorage.removeItem(LS_PW); }
  }
  if (matchMedia('(min-width: 721px)').matches) $('#lock-pw').focus();
})();
