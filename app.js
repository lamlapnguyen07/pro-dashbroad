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
const LS_FOCUS = 'board.focusCollapsed';
const MAX_MEETINGS = 12;
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
    layout: d.layout && typeof d.layout === 'object' && !Array.isArray(d.layout) ? d.layout : {},
    // A city starts with one plaza; after that the user decides.
    decor: Array.isArray(d.decor) ? d.decor.filter((x) => x && (x.type === 'plaza' || x.type === 'park')) : [{ id: 'plaza', type: 'plaza' }],
    // Every Friday is the team meeting; notes are kept per Friday (YYYY-MM-DD).
    weekly: { title: '週會', time: '15:00', remind: true, ...(d.weekly || {}) },
    meetings: d.meetings && typeof d.meetings === 'object' && !Array.isArray(d.meetings) ? d.meetings : {},
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
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
camera.position.set(60, 60, 60);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6e0, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(-18, 40, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
scene.add(sun);

const city = new THREE.Group();
scene.add(city);
const WHITE = new THREE.Color(0xffffff);
const mat = (color, extraProps = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extraProps });
const place = (mesh, x, y, z, parent) => {
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
};
const box = (w, h, d, m, x, y, z, parent = city) => place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, parent);
const cyl = (r, h, m, x, y, z, parent = city, seg = 12) => place(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m), x, y, z, parent);
const ball = (r, m, x, y, z, parent = city) => place(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, parent);
// Triangular prism lying along x (a gable roof): `depth` wide along z, `height` tall.
function prism(len, depth, height, m, x, y, z, parent = city) {
  const shape = new THREE.Shape([new THREE.Vector2(-depth / 2, 0), new THREE.Vector2(depth / 2, 0), new THREE.Vector2(0, height)]);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  geo.rotateY(Math.PI / 2);
  geo.translate(-len / 2, 0, 0);
  return place(new THREE.Mesh(geo, m), x, y, z, parent);
}
const hash = (s) => [...String(s)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ---------- city layout: a grid of blocks separated by two-way streets ---------- */
const S = 10;        // block pitch
const TILE = 8.4;    // block incl. sidewalk
const WALK = 3.95;   // sidewalk line, from block centre
const ROAD = 1.6;
const CIVIC = ['mail', 'calendar', 'report', 'milestone'];
const CIVIC_NAME = { mail: '郵局', calendar: '會議廳', report: '週報塔', milestone: '鐘塔' };
const STYLES = { tower: '大樓', stack: '階梯大樓', glass: '玻璃塔', studio: '工作室', factory: '工廠' };
const DECOR = { plaza: '⛲ 廣場', park: '🌳 公園' };
const styleOf = (p) => (STYLES[p.style] ? p.style : p.kind === 'leader' ? 'tower' : p.kind === 'claude' ? 'glass' : ['stack', 'studio', 'factory', 'tower', 'glass'][hash(p.id) % 5]);
const itemName = (key) => person(key)?.name ?? CIVIC_NAME[key] ?? DECOR[draftOrBoard().decor.find((d) => 'd:' + d.id === key)?.type] ?? '';

let layoutMode = false, draft = null, picked = null;
const draftOrBoard = () => draft || { layout: board.layout, decor: board.decor };

function placement(pad) {
  const src = draftOrBoard();
  const keys = [...board.people.map((p) => p.id), ...src.decor.map((d) => 'd:' + d.id), ...CIVIC];
  const pos = new Map(), used = new Set();
  for (const k of keys) {
    const v = src.layout?.[k];
    if (Array.isArray(v) && Number.isInteger(v[0]) && Number.isInteger(v[1]) && !used.has(v.join())) { pos.set(k, [v[0], v[1]]); used.add(v.join()); }
  }
  if (!pos.size) {
    // Default: the first plaza in the middle, everyone else row by row around it.
    const cols = Math.max(3, Math.ceil(Math.sqrt(keys.length)));
    const rows = Math.ceil(keys.length / cols);
    const centre = [Math.floor((cols - 1) / 2), Math.floor((rows - 1) / 2)];
    const plaza = keys.find((k) => k.startsWith('d:'));
    if (plaza) { pos.set(plaza, centre); used.add(centre.join()); }
    let i = 0;
    for (const k of keys) {
      if (pos.has(k)) continue;
      while (used.has([i % cols, Math.floor(i / cols)].join())) i++;
      const c = [i % cols, Math.floor(i / cols)];
      pos.set(k, c); used.add(c.join());
    }
  }
  for (const k of keys) {
    if (pos.has(k)) continue;
    const all = [...pos.values()];
    const [minC, maxC] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
    const [minR, maxR] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
    let cell = null;
    for (let r = minR; r <= maxR && !cell; r++) for (let c = minC; c <= maxC && !cell; c++) if (!used.has([c, r].join())) cell = [c, r];
    cell = cell || [minC, maxR + 1];
    pos.set(k, cell); used.add(cell.join());
  }
  const all = [...pos.values()];
  const minC = Math.min(...all.map((p) => p[0])), minR = Math.min(...all.map((p) => p[1]));
  const cols = Math.max(...all.map((p) => p[0])) - minC + 1 + pad * 2;
  const rows = Math.max(...all.map((p) => p[1])) - minR + 1 + pad * 2;
  for (const [k, p] of pos) pos.set(k, [p[0] - minC + pad, p[1] - minR + pad]);
  return { pos, cols, rows, pad, minC, minR };
}

const labelLayer = $('#labels');
let pickables = [], animated = [], labels = [], rings = new Map(), civicLabel = {}, cars = [], walkers = [], spots = [];
let dims = { W: 40, D: 40, coreW: 32, coreD: 32 };

function clearCity() {
  city.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  city.clear();
  labelLayer.replaceChildren();
  pickables = []; animated = []; labels = []; rings = new Map(); civicLabel = {}; cars = []; walkers = []; spots = [];
  nightMats = []; lampMats = [];
}
function addLabel(node, pos, id) {
  labelLayer.append(node);
  labels.push({ node, pos, id });
  return node;
}

function buildCity() {
  clearCity();
  const pl = placement(layoutMode ? 1 : 0);
  const { cols, rows } = pl;
  const W = cols * S + 8, D = rows * S + 8;
  dims = { W, D, coreW: cols * S + ROAD, coreD: rows * S + ROAD };
  Object.assign(sun.shadow.camera, { left: -W, right: W, top: W, bottom: -W, near: 1, far: 220 });
  sun.shadow.camera.updateProjectionMatrix();
  const centre = (c, r) => [(c - (cols - 1) / 2) * S, (r - (rows - 1) / 2) * S];

  // Grass, then asphalt streets on every block edge with dashed centre lines.
  box(W, 0.3, D, mat(0xcfe3c6), 0, -0.15, 0).castShadow = false;
  const asphalt = mat(0x8e98a5);
  const xs = Array.from({ length: cols + 1 }, (_, i) => (i - cols / 2) * S);
  const zs = Array.from({ length: rows + 1 }, (_, j) => (j - rows / 2) * S);
  zs.forEach((z) => { box(cols * S + ROAD, 0.08, ROAD, asphalt, 0, 0.04, z).castShadow = false; });
  xs.forEach((x) => { box(ROAD, 0.08, rows * S + ROAD, asphalt, x, 0.04, 0).castShadow = false; });
  const dashes = [];
  zs.forEach((z) => { for (let x = -cols * S / 2 + 1.6; x < cols * S / 2 - 1; x += 1.8) if (xs.every((xx) => Math.abs(x - xx) > 1.2)) dashes.push([x, z, 0]); });
  xs.forEach((x) => { for (let z = -rows * S / 2 + 1.6; z < rows * S / 2 - 1; z += 1.8) if (zs.every((zz) => Math.abs(z - zz) > 1.2)) dashes.push([x, z, 1]); });
  const dashMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 0.02, 0.1), mat(0xf4f6f8), dashes.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  dashes.forEach(([x, z, vert], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), vert ? Math.PI / 2 : 0);
    dashMesh.setMatrixAt(i, m4.compose(new THREE.Vector3(x, 0.09, z), q, one));
  });
  city.add(dashMesh);

  // Blocks.
  const occupied = new Set();
  for (const [key, [c, r]] of pl.pos) {
    occupied.add(c + ',' + r);
    const [x, z] = centre(c, r);
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    city.add(g);
    const ring = box(TILE + 0.5, 0.2, TILE + 0.5, mat(0x1f2733), 0, 0.1, 0, g);
    ring.castShadow = false;
    ring.visible = false;
    rings.set(key, ring);
    const parts = [box(TILE, 0.22, TILE, mat(0xe3e7ec), 0, 0.11, 0, g)];
    const p = person(key);
    if (p) parts.push(...buildLot(p, g));
    else if (key.startsWith('d:')) {
      const d = draftOrBoard().decor.find((y) => 'd:' + y.id === key);
      parts.push(...(d.type === 'park' ? buildPark(g, hash(key)) : buildPlaza(g, hash(key))));
    } else parts.push(...buildCivic(key, g));
    parts.forEach((m) => { m.userData.key = key; pickables.push(m); });
  }
  // Empty blocks: grass with a tree, or (while arranging) a drop target.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (occupied.has(c + ',' + r)) continue;
    const [x, z] = centre(c, r);
    if (layoutMode) {
      const slot = box(TILE, 0.12, TILE, mat(0xffffff, { transparent: true, opacity: 0.55 }), x, 0.06, z);
      slot.castShadow = false;
      slot.userData.cell = [c, r];
      pickables.push(slot);
    } else {
      box(TILE, 0.22, TILE, mat(0xbfdcb4), x, 0.11, z).castShadow = false;
      roundTree(x - 1.5, z + 1, 1.1);
      roundTree(x + 2, z - 1.8, 0.9);
    }
  }
  // Trees around the edge of town.
  const rand = rng(cols * 97 + rows);
  for (let x = -W / 2 + 1.5; x <= W / 2 - 1.5; x += 3.2) for (const z of [-D / 2 + 1.6, D / 2 - 1.6]) if (rand() < 0.8) (rand() < 0.5 ? coneTree : roundTree)(x + rand() - 0.5, z, 0.8 + rand() * 0.4);
  for (let z = -D / 2 + 4.5; z <= D / 2 - 4.5; z += 3.2) for (const x of [-W / 2 + 1.6, W / 2 - 1.6]) if (rand() < 0.8) (rand() < 0.5 ? coneTree : roundTree)(x, z + rand() - 0.5, 0.8 + rand() * 0.4);

  spawnTraffic(xs, zs, cols, rows);
  spawnWalkers();
  updateCivicLabels();
  applyDaylight(true);
}

function coneTree(x, z, s = 1, parent = city) {
  cyl(0.15 * s, 0.8 * s, mat(0x8a6f55), x, 0.4 * s, z, parent, 6);
  place(new THREE.Mesh(new THREE.ConeGeometry(0.9 * s, 2 * s, 7), mat(0x6fb98a)), x, 1.7 * s, z, parent);
}
function roundTree(x, z, s = 1, parent = city) {
  cyl(0.13 * s, 0.9 * s, mat(0x8a6f55), x, 0.45 * s, z, parent, 6);
  ball(0.75 * s, mat(0x86c98f), x, 1.4 * s, z, parent);
  ball(0.5 * s, mat(0x9bd6a2), x + 0.35 * s, 1.75 * s, z + 0.2 * s, parent);
}
function bench(x, z, ry, parent) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  parent.add(g);
  box(1.1, 0.08, 0.35, mat(0xa0714f), 0, 0.45, 0, g);
  box(1.1, 0.3, 0.06, mat(0xa0714f), 0, 0.65, -0.17, g);
  for (const dx of [-0.45, 0.45]) box(0.06, 0.42, 0.3, mat(0x55606f), dx, 0.21, 0, g);
}
function lamp(x, z, parent) {
  cyl(0.05, 1.8, mat(0x55606f), x, 0.9, z, parent, 6);
  ball(0.16, lampMat(0xfff1c7, 0xffd98a), x, 1.85, z, parent);
}

/* ---------- people's buildings ---------- */
function buildLot(p, g) {
  const color = new THREE.Color(safeColor(p.color));
  const mine = tasksOf(p.id);
  const open = mine.filter((t) => t.status !== 'done').length;
  const parts = [box(TILE - 1, 0.3, TILE - 1, mat(color.clone().lerp(WHITE, 0.78)), 0, 0.25, 0, g)];
  // Height = open workload; the leader's HQ is a bit taller.
  const h = 1.6 + Math.min(open, 8) * 0.5 + (p.kind === 'leader' ? 0.8 : 0);
  const b = buildingStyle(styleOf(p), g, color, h);
  parts.push(...b.parts);
  let top = b.top;
  if (p.kind === 'leader') {
    parts.push(cyl(0.06, 1.8, mat(0x55606f), -1.9, top + 0.9, -1.9, g));
    const flag = box(1, 0.6, 0.06, mat(color), -1.38, top + 1.45, -1.9, g);
    parts.push(flag);
    animated.push({ type: 'flag', mesh: flag });
    top += 1.8;
  } else if (p.kind === 'claude') {
    parts.push(cyl(0.08, 1.1, mat(0x55606f), -1.9, top + 0.55, -1.9, g));
    const bulb = ball(0.34, mat(color, { emissive: color, emissiveIntensity: 0.5 }), -1.9, top + 1.3, -1.9, g);
    parts.push(bulb);
    animated.push({ type: 'glow', mesh: bulb });
    top += 1.6;
  }
  // One crate per task (up to 18), most urgent first; focus tasks get a spinning star.
  sortTasks(mine).slice(0, 18).forEach((t, k) => {
    const m = mat(STATUS[t.status].color, t.status === 'blocked' ? { emissive: 0xe5584f, emissiveIntensity: 0 } : {});
    const crate = box(0.78, 0.78, 0.78, m, 1.0 + (k % 3), 0.79, -2.9 + Math.floor(k / 3), g);
    parts.push(crate);
    if (t.status === 'doing') animated.push({ type: 'bob', mesh: crate, phase: k });
    if (t.status === 'blocked') animated.push({ type: 'pulse', mesh: crate });
    if (t.focus && t.status !== 'done') animated.push({ type: 'spin', mesh: place(new THREE.Mesh(new THREE.OctahedronGeometry(0.22), mat(0xffc93c, { emissive: 0xffb000, emissiveIntensity: 0.6 })), 0, 0.68, 0, crate) });
  });
  roundTree(-3.1, 3.0, 0.75, g);
  lamp(-0.4, 3.2, g);
  spots.push({ x: g.position.x - 1.9, z: g.position.z - 0.1, cx: g.position.x, cz: g.position.z, enter: true });

  const label = el('div', 'label');
  const dot = el('span', 'dot');
  dot.style.background = safeColor(p.color);
  label.append(dot, el('span', '', p.name), el('small', '', `${mine.filter((t) => t.status === 'done').length}/${mine.length}`));
  if (mine.some((t) => t.status === 'blocked' || isOverdue(t))) label.append(el('span', 'warn', '!'));
  addLabel(label, g.position.clone().add(new THREE.Vector3(-1.9, top + 0.5, -1.9)), p.id);
  return parts;
}

function buildingStyle(style, g, color, h) {
  const X = -1.9, Z = -1.9, F = 2.8, base = 0.4;
  const parts = [], win = winMat(), body = mat(color), dark = mat(color.clone().lerp(new THREE.Color(0x1f2733), 0.35));
  const strips = (x, z, w, d, y0, y1) => {
    for (let y = y0 + 0.75; y < y1 - 0.35; y += 0.85) {
      parts.push(box(w * 0.72, 0.32, 0.06, win, x, y, z + d / 2 + 0.01, g), box(0.06, 0.32, d * 0.72, win, x + w / 2 + 0.01, y, z, g));
    }
  };
  let top;
  if (style === 'stack') {
    let y = base;
    [[F, 0.45], [F * 0.76, 0.33], [F * 0.52, 0.22]].forEach(([f, k]) => {
      const th = Math.max(0.8, h * k);
      parts.push(box(f, th, f, body, X, y + th / 2, Z, g), box(f + 0.12, 0.12, f + 0.12, mat(0xffffff), X, y + th, Z, g));
      strips(X, Z, f, f, y, y + th);
      y += th + 0.12;
    });
    top = y;
  } else if (style === 'glass') {
    const r = F / 2;
    parts.push(cyl(r, h, mat(color.clone().lerp(WHITE, 0.2), { roughness: 0.25, metalness: 0.15 }), X, base + h / 2, Z, g, 28));
    for (let y = base + 0.8; y < base + h - 0.2; y += 0.8) parts.push(cyl(r + 0.04, 0.09, mat(0xf4f7fb), X, y, Z, g, 28));
    parts.push(cyl(r * 0.82, 0.25, mat(0xffffff), X, base + h + 0.12, Z, g, 28));
    top = base + h + 0.25;
  } else if (style === 'studio') {
    const w = F * 1.25, bh = Math.max(1.4, h * 0.6);
    parts.push(box(w, bh, F, body, X + 0.3, base + bh / 2, Z, g));
    parts.push(prism(w + 0.3, F + 0.4, 1.1, dark, X + 0.3, base + bh, Z, g));
    parts.push(box(w * 0.55, bh * 0.45, 0.06, win, X + 0.75, base + bh * 0.55, Z + F / 2 + 0.01, g));
    parts.push(box(0.06, bh * 0.4, F * 0.6, win, X + 0.3 + w / 2 + 0.01, base + bh * 0.55, Z, g));
    top = base + bh + 1.1;
  } else if (style === 'factory') {
    const w = F * 1.2, bh = Math.max(1.4, h * 0.6);
    parts.push(box(w, bh, F, body, X + 0.2, base + bh / 2, Z, g));
    for (let i = 0; i < 3; i++) parts.push(prism(F, w / 3, 0.6, dark, X + 0.2 - w / 3 + i * (w / 3), base + bh, Z, g));
    parts.forEach((m) => { if (m.geometry.type === 'ExtrudeGeometry') m.rotation.y = Math.PI / 2; });
    const ch = bh + 2;
    parts.push(cyl(0.24, ch, mat(0x9aa1ab), X - w / 2 + 0.6, base + ch / 2, Z - F / 2 + 0.5, g, 10));
    for (let i = 0; i < 3; i++) {
      const puff = ball(0.28, mat(0xf2f4f7, { transparent: true, opacity: 0.8 }), X - w / 2 + 0.6, base + ch + 0.3, Z - F / 2 + 0.5, g);
      puff.castShadow = false;
      animated.push({ type: 'smoke', mesh: puff, base: base + ch + 0.2, phase: i / 3 });
    }
    strips(X + 0.2, Z, w, F, base, base + bh);
    top = base + ch + 0.4;
  } else {
    parts.push(box(F, h, F, body, X, base + h / 2, Z, g), box(F + 0.25, 0.22, F + 0.25, mat(0xffffff), X, base + h + 0.11, Z, g));
    strips(X, Z, F, F, base, base + h);
    top = base + h + 0.22;
  }
  parts.push(box(0.7, 1, 0.08, mat(0xffffff), X, base + 0.5, Z + F / 2 + 0.03, g));
  return { parts, top };
}

/* ---------- plaza, park and civic blocks ---------- */
function buildPlaza(g, seed) {
  const parts = [box(TILE - 1, 0.3, TILE - 1, mat(0xf3ece0), 0, 0.25, 0, g)];
  for (let i = -3; i <= 3; i += 1.5) parts.push(box(0.05, 0.02, TILE - 1.2, mat(0xe6dccb), i, 0.41, 0, g), box(TILE - 1.2, 0.02, 0.05, mat(0xe6dccb), 0, 0.41, i, g));
  parts.push(cyl(1.7, 0.45, mat(0xd8cdb8), 0, 0.6, 0, g, 28), cyl(1.5, 0.05, mat(0x8fd3f0, { roughness: 0.2 }), 0, 0.84, 0, g, 28));
  parts.push(cyl(0.22, 1.1, mat(0xd8cdb8), 0, 1.3, 0, g, 12), cyl(0.6, 0.15, mat(0xd8cdb8), 0, 1.85, 0, g, 18));
  const jet = ball(0.22, mat(0xbfe9fb, { transparent: true, opacity: 0.85, roughness: 0.1 }), 0, 2.1, 0, g);
  jet.castShadow = false;
  animated.push({ type: 'jet', mesh: jet });
  [[0, 2.6, 0], [0, -2.6, Math.PI], [2.6, 0, -Math.PI / 2], [-2.6, 0, Math.PI / 2]].forEach(([x, z, r]) => bench(x, z, r, g));
  [[-3, -3], [3, -3], [-3, 3], [3, 3]].forEach(([x, z], i) => (i % 2 ? lamp(x, z, g) : roundTree(x, z, 0.8, g)));
  const flowers = [0xe5584f, 0xffc93c, 0xe07ab0, 0xb574d6];
  const rand = rng(seed);
  for (let i = 0; i < 10; i++) {
    const a = rand() * Math.PI * 2, r = 2.05 + rand() * 0.2;
    parts.push(ball(0.13, mat(flowers[i % 4]), Math.cos(a) * r, 0.5, Math.sin(a) * r, g));
  }
  for (let i = 0; i < 2; i++) spots.push({ x: g.position.x + (i ? 1.8 : -1.8), z: g.position.z + 2.0, cx: g.position.x, cz: g.position.z, enter: false });
  return parts;
}

function buildPark(g, seed) {
  const parts = [box(TILE - 1, 0.3, TILE - 1, mat(0xa9d99a), 0, 0.25, 0, g)];
  const pond = cyl(1.4, 0.06, mat(0x8fd3f0, { roughness: 0.2 }), 1.2, 0.42, -1, g, 24);
  pond.scale.set(1.3, 1, 0.9);
  parts.push(pond);
  const path = box(0.9, 0.04, TILE - 1, mat(0xeadfc8), -0.6, 0.42, 0, g);
  path.rotation.y = 0.5;
  parts.push(path);
  const rand = rng(seed);
  [[-2.8, -2.6], [-2.6, 1.2], [2.8, 2.6], [0.6, 2.9], [-1.0, -3.0], [3.0, 0.9]].forEach(([x, z]) => (rand() < 0.5 ? roundTree : coneTree)(x, z, 0.7 + rand() * 0.35, g));
  bench(1.1, 1.0, 0, g);
  spots.push({ x: g.position.x + 1.1, z: g.position.z + 1.5, cx: g.position.x, cz: g.position.z, enter: false });
  return parts;
}

function buildCivic(key, g) {
  const tint = { mail: 0xf8e3e1, calendar: 0xdcefed, report: 0xece6f8, milestone: 0xf3ead6 }[key];
  const parts = [box(TILE - 1, 0.3, TILE - 1, mat(tint), 0, 0.25, 0, g)];
  let labelY = 3, door = [0, 1.6];
  if (key === 'mail') {
    parts.push(box(3.2, 1.8, 2.4, mat(0xffffff), -0.6, 1.3, -1, g), prism(3.5, 2.8, 0.9, mat(0xe5584f), -0.6, 2.2, -1, g));
    parts.push(box(2.6, 0.25, 0.06, mat(0xe5584f), -0.6, 1.75, 0.22, g), box(0.7, 1, 0.08, mat(0xb3392f), -0.6, 0.9, 0.23, g));
    parts.push(box(0.3, 1, 0.3, mat(0x55606f), 1.9, 0.9, 1.4, g), box(1.1, 0.8, 0.8, mat(0xe5584f), 1.9, 1.75, 1.4, g), box(0.8, 0.1, 0.05, mat(0xffffff), 1.9, 1.85, 1.81, g));
    labelY = 4; door = [-0.6, 0.6];
    roundTree(-3, 2.6, 0.75, g);
  } else if (key === 'calendar') {
    parts.push(box(5, 0.3, 3.6, mat(0xc9e7e4), 0, 0.55, -0.4, g), box(4, 1.6, 2.2, mat(0xffffff), 0, 1.5, -0.8, g), box(4.4, 0.2, 3.2, mat(0xe9eef2), 0, 2.4, -0.4, g));
    for (const x of [-1.7, -0.6, 0.6, 1.7]) parts.push(cyl(0.14, 1.6, mat(0xf4f6f8), x, 1.5, 0.75, g));
    parts.push(prism(4.6, 3.4, 1.1, mat(0x3fb6b2), 0, 2.5, -0.4, g), box(0.9, 1.1, 0.08, mat(0x3fb6b2), 0, 1.25, 0.32, g));
    labelY = 4.6; door = [0, 1.6];
    lamp(-3, 2.8, g); lamp(3, 2.8, g);
  } else if (key === 'report') {
    const purple = mat(0x8e6bd6), win = winMat();
    let y = 0.4;
    [[2.4, 1.5], [1.9, 1.4], [1.4, 1.3]].forEach(([s, h]) => {
      parts.push(box(s, h, s, purple, 0, y + h / 2, -0.6, g), box(s * 0.7, 0.3, 0.06, win, 0, y + h / 2, -0.6 + s / 2 + 0.01, g), box(0.06, 0.3, s * 0.7, win, s / 2 + 0.01, y + h / 2, -0.6, g));
      y += h;
    });
    [[0x5b8def, 0.6], [0xf2a93b, 0.95], [0x4caf7d, 1.35]].forEach(([c, h], i) => {
      const b = box(0.3, h, 0.3, mat(c), -0.4 + i * 0.4, y + h / 2, -0.6, g);
      parts.push(b);
      animated.push({ type: 'grow', mesh: b, base: y, h, phase: i });
    });
    parts.push(box(0.7, 1, 0.08, mat(0xffffff), 0, 0.9, 0.63, g));
    labelY = y + 2; door = [0, 1.2];
    bench(2.4, 2.2, 0, g); roundTree(-2.8, 2.6, 0.8, g);
  } else {
    const stone = mat(0xe9d8b4);
    parts.push(box(2.2, 0.45, 2.2, mat(0xd8c49a), 0, 0.6, 0, g), box(1.4, 4.8, 1.4, stone, 0, 3.2, 0, g), box(1.7, 0.25, 1.7, mat(0xd8c49a), 0, 5.7, 0, g));
    const cap = place(new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.4, 4), mat(0x55606f)), 0, 6.5, 0, g);
    cap.rotation.y = Math.PI / 4;
    parts.push(cap);
    [[0, 0.71, 0], [0.71, 0, Math.PI / 2]].forEach(([x, z, ry]) => {
      const face = new THREE.Group();
      face.position.set(x, 4.8, z);
      face.rotation.y = ry;
      g.add(face);
      const disc = place(new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.06, 24), mat(0xffffff)), 0, 0, 0, face);
      disc.rotation.x = Math.PI / 2;
      parts.push(disc);
      const hand = (len, w) => {
        const pivot = new THREE.Group();
        pivot.position.z = 0.05;
        face.add(pivot);
        place(new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.03), mat(0x1f2733)), 0, len / 2, 0, pivot);
        return pivot;
      };
      animated.push({ type: 'clock', hour: hand(0.27, 0.06), minute: hand(0.42, 0.04) });
    });
    [[-2.6, 2.6], [2.6, 2.6], [-2.6, -2.6], [2.6, -2.6]].forEach(([x, z]) => parts.push(box(1, 0.35, 1, mat(0x9fd59a), x, 0.55, z, g)));
    labelY = 7.6; door = null;
    bench(0, 2.6, 0, g);
  }
  if (door) spots.push({ x: g.position.x + door[0], z: g.position.z + door[1], cx: g.position.x, cz: g.position.z, enter: true });
  else spots.push({ x: g.position.x, z: g.position.z + 2, cx: g.position.x, cz: g.position.z, enter: false });
  civicLabel[key] = addLabel(el('div', 'label civic', ''), g.position.clone().add(new THREE.Vector3(0, labelY, 0)), key);
  return parts;
}

function updateCivicLabels() {
  if (!board || !civicLabel.calendar) return;
  // Short labels: blocks are small on phones. Details live in each panel.
  const todays = extra.calendar?.days?.find((d) => d.date === today());
  const mo = new Date().getDay() === 5 ? meetingOf(today()) : null;
  civicLabel.calendar.textContent = mo && !mo.skip ? `📅 ${board.weekly.title} ${mo.time}` : todays ? `📅 ${todays.events.length} 場` : '📅 會議';
  const next = nextMilestone();
  civicLabel.milestone.textContent = next ? `⏰ ${left(daysLeft(next.date))}` : '⏰ 里程碑';
  civicLabel.report.textContent = '📈 週報';
  const d = extra.mail?.days?.[0];
  const high = d?.date === today() ? d.items.filter((m) => m.priority === 'high').length : 0;
  civicLabel.mail.textContent = high ? `✉️ ${high} 重要` : '✉️ 信件';
}
const nextMilestone = () => [...board.milestones].filter((m) => daysLeft(m.date) >= 0).sort((a, b) => a.date.localeCompare(b.date))[0];

/* ---------- traffic: cars in both directions on every street ---------- */
const CAR_COLORS = [0xe5584f, 0x5b8def, 0xf2a93b, 0xf7f8fa, 0x2f3a4d, 0x4caf7d, 0xb574d6, 0x3fb6b2];
function makeCar(kind, color) {
  const g = new THREE.Group();
  const paint = mat(color, { roughness: 0.45 }), glass = mat(0xbcd7ee, { roughness: 0.2 }), tyre = mat(0x2a2f38);
  const len = kind === 'bus' ? 1.9 : kind === 'van' ? 1.25 : 1.1;
  const hgt = kind === 'bus' ? 0.75 : kind === 'van' ? 0.55 : 0.32;
  box(len, hgt, 0.58, paint, 0, 0.2 + hgt / 2, 0, g);
  if (kind === 'car') {
    box(0.62, 0.26, 0.52, glass, -0.06, 0.65, 0, g);
    box(0.64, 0.05, 0.54, paint, -0.06, 0.8, 0, g);
  } else {
    box(len * 0.86, 0.2, 0.6, glass, len * 0.03, 0.2 + hgt * 0.7, 0, g);
    box(0.06, hgt * 0.45, 0.5, glass, len / 2 + 0.01, 0.2 + hgt * 0.68, 0, g);
  }
  const wx = len / 2 - 0.28;
  for (const x of [-wx, wx]) for (const z of [-0.3, 0.3]) {
    const w = cyl(0.14, 0.1, tyre, x, 0.15, z, g, 12);
    w.rotation.x = Math.PI / 2;
  }
  for (const z of [-0.18, 0.18]) {
    box(0.04, 0.08, 0.12, lampMat(0xfff3c4, 0xfff0b0), len / 2 + 0.01, 0.3, z, g);
    box(0.04, 0.08, 0.12, mat(0xe5584f, { emissive: 0xc02020, emissiveIntensity: 0.4 }), -len / 2 - 0.01, 0.3, z, g);
  }
  g.traverse((o) => { o.castShadow = true; });
  return g;
}
// Street network: every block corner is a node. Junctions with 3+ roads get traffic lights.
// Cars drive on the right, keep their distance, stop at red lights, never enter a junction they
// can't leave, turn only straight/right at signals (no crossing oncoming traffic), and give way to
// pedestrians crossing in front of them.
const LANE = 0.42, STOP = 2.0, ACC = 2.4, DEC = 7, CYCLE = 14;
let net = null;
const signalLamps = [];
function signal(n, axis, t) {
  if (!n.light) return 'g';
  const p = (t + n.off) % CYCLE;
  if (axis === 'x') return p < 5.5 ? 'g' : p < 7 ? 'y' : 'r';
  return p < 7 ? 'r' : p < 12.5 ? 'g' : 'y';
}
const SIGNAL_COLOR = { g: 0x3ecf6e, y: 0xffc23c, r: 0xff4d43 };
const dirOf = (a, b) => [Math.sign(b.x - a.x), Math.sign(b.z - a.z)];

function spawnTraffic(xs, zs, cols, rows) {
  signalLamps.length = 0;
  const nodes = xs.map((x, i) => zs.map((z, j) => ({ i, j, x, z, off: (i * 1.7 + j * 2.9) % CYCLE })));
  const at = (i, j) => nodes[i]?.[j];
  nodes.flat().forEach((n) => {
    n.nbrs = [at(n.i - 1, n.j), at(n.i + 1, n.j), at(n.i, n.j - 1), at(n.i, n.j + 1)].filter(Boolean);
    n.light = n.nbrs.length >= 3;
    if (!n.light) return;
    // Two signal posts on opposite corners: one for east-west traffic, one for north-south.
    [['x', 1.05, 1.05], ['z', -1.05, -1.05]].forEach(([axis, dx, dz]) => {
      cyl(0.05, 1.5, mat(0x3a4250), n.x + dx, 0.75, n.z + dz, city, 6);
      box(0.22, 0.3, 0.22, mat(0x2a2f38), n.x + dx, 1.58, n.z + dz);
      const m = mat(0x3ecf6e, { emissive: 0x3ecf6e, emissiveIntensity: 1 });
      ball(0.1, m, n.x + dx, 1.8, n.z + dz);
      signalLamps.push({ n, axis, m });
    });
  });
  net = { nodes };

  const rand = rng(cols * 13 + rows * 7);
  const edges = nodes.flat().flatMap((a) => a.nbrs.map((b) => [a, b]));
  const n = Math.min(16, 5 + Math.round(edges.length / 5));
  for (let i = 0; i < n; i++) {
    const kind = i === 0 ? 'bus' : rand() < 0.25 ? 'van' : 'car';
    const len = kind === 'bus' ? 1.9 : kind === 'van' ? 1.25 : 1.1;
    let placed = null;
    for (let tries = 0; tries < 30 && !placed; tries++) {
      const [a, b] = edges[Math.floor(rand() * edges.length)];
      const s = 1 + rand() * (S - STOP - 2);
      if (cars.every((c) => c.a !== a || c.b !== b || Math.abs(c.s - s) > (c.len + len) / 2 + 1)) placed = { a, b, s };
    }
    if (!placed) continue;
    const mesh = makeCar(kind, CAR_COLORS[i % CAR_COLORS.length]);
    city.add(mesh);
    const car = { mesh, kind, len, ...placed, v: 0, vmax: kind === 'bus' ? 2.1 : 2.5 + rand() * 1.1, next: null, rand, heading: 0 };
    placeCar(car, 1);
    cars.push(car);
  }
}

function chooseNext(c) {
  const [dx, dz] = dirOf(c.a, c.b);
  const opts = c.b.nbrs.filter((n) => n !== c.a).map((n) => ({ n, d: dirOf(c.b, n) }));
  const straight = opts.find((o) => o.d[0] === dx && o.d[1] === dz);
  const right = opts.find((o) => o.d[0] === -dz && o.d[1] === dx);
  if (c.b.light) {
    if (straight && right) return (c.rand() < 0.6 ? straight : right).n;
    return (straight || right || opts[0]).n;
  }
  return (straight && c.rand() < 0.5 ? straight : opts[Math.floor(c.rand() * opts.length)]).n;
}

function gapAhead(c) {
  let gap = Infinity;
  for (const o of cars) {
    if (o === c) continue;
    const need = (c.len + o.len) / 2;
    if (o.a === c.a && o.b === c.b && o.s > c.s) gap = Math.min(gap, o.s - c.s - need);
    else if (c.next && o.a === c.b && o.b === c.next) gap = Math.min(gap, S - c.s + o.s - need);
  }
  return gap;
}
function canEnter(c, n, axis) {
  const inside = cars.filter((o) => o !== c && o.occ === n);
  return !inside.length || (n.light && inside.every((o) => o.occAxis === axis));
}
// Free space at the start of edge a->b (for "don't block the junction").
function roomOn(a, b, self) {
  let room = Infinity;
  for (const o of cars) if (o !== self && o.a === a && o.b === b) room = Math.min(room, o.s - o.len / 2);
  return room;
}

// Turns follow a curve inside the car's own lane: from its lane on the way in to its lane on
// the way out, bending where the two lanes cross. Nothing swings into the oncoming lane.
const TURN = 1.0;
const lanePt = (n, d, t) => [n.x + d[0] * t - d[1] * LANE, n.z + d[1] * t + d[0] * LANE];
function turnPoint(n, din, dout, u) {
  const P0 = lanePt(n, din, -TURN), P1 = lanePt(n, dout, TURN);
  // Where the incoming and outgoing lane lines cross: n + din*t + rin*L = n + dout*t2 + rout*L.
  const rin = [-din[1], din[0]], rout = [-dout[1], dout[0]];
  const ax = din[0], ay = din[1], bx = -dout[0], by = -dout[1];
  const cx = (rout[0] - rin[0]) * LANE, cy = (rout[1] - rin[1]) * LANE;
  const t = (cx * by - cy * bx) / (ax * by - ay * bx);
  const C = [n.x + din[0] * t + rin[0] * LANE, n.z + din[1] * t + rin[1] * LANE];
  const w = (u + TURN) / (2 * TURN), m = 1 - w;
  const x = m * m * P0[0] + 2 * m * w * C[0] + w * w * P1[0];
  const z = m * m * P0[1] + 2 * m * w * C[1] + w * w * P1[1];
  const tx = 2 * m * (C[0] - P0[0]) + 2 * w * (P1[0] - C[0]), tz = 2 * m * (C[1] - P0[1]) + 2 * w * (P1[1] - C[1]);
  return [x, z, Math.atan2(-tz, tx)];
}
const same = (p, q) => p[0] === q[0] && p[1] === q[1];

const carTarget = new THREE.Vector3();
function placeCar(c, blend) {
  const d = dirOf(c.a, c.b);
  const [dx, dz] = d;
  const dIn = c.prev ? dirOf(c.prev, c.a) : d, dOut = c.next ? dirOf(c.b, c.next) : d;
  let x, z, want;
  if (c.s > S - TURN && !same(dOut, d)) [x, z, want] = turnPoint(c.b, d, dOut, c.s - S);
  else if (c.s < TURN && !same(dIn, d)) [x, z, want] = turnPoint(c.a, dIn, d, c.s);
  else { x = c.a.x + dx * c.s - dz * LANE; z = c.a.z + dz * c.s + dx * LANE; want = Math.atan2(-dz, dx); }
  carTarget.set(x, 0.06, z);
  c.mesh.position.lerp(carTarget, blend);
  let diff = want - c.heading;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  c.heading += diff * Math.min(1, blend * 1.4);
  c.mesh.rotation.y = c.heading;
}

function stepTraffic(dt, t) {
  for (const l of signalLamps) {
    const s = signal(l.n, l.axis, t);
    l.m.color.setHex(SIGNAL_COLOR[s]);
    l.m.emissive.setHex(SIGNAL_COLOR[s]);
  }
  const brake = (dist) => Math.sqrt(2 * DEC * Math.max(0, dist));
  for (const c of cars) {
    if (!c.next) c.next = chooseNext(c);
    const [dx, dz] = dirOf(c.a, c.b);
    let limit = c.vmax;
    const toStop = S - STOP - c.s;
    if (toStop > -0.3) {
      const sig = signal(c.b, dx !== 0 ? 'x' : 'z', t);
      const canStop = (c.v * c.v) / (2 * DEC) < toStop + 0.2;
      if (sig === 'r' || (sig === 'y' && canStop)) limit = Math.min(limit, brake(toStop));
      if (toStop < 3 && roomOn(c.b, c.next, c) < c.len + 0.7) limit = Math.min(limit, brake(toStop));
    }
    // One flow at a time through a junction: wait at the line until it's clear (same-axis
    // traffic may share a signalled junction, crossing traffic may not).
    const axis = dx !== 0 ? 'x' : 'z';
    if (c.occ !== c.b && toStop > -0.3 && toStop < 2.5 && !canEnter(c, c.b, axis)) limit = Math.min(limit, brake(toStop));
    limit = Math.min(limit, brake(gapAhead(c) - 0.45));
    // Anything physically in front of the car (e.g. a car turning out of the junction ahead).
    const px = c.mesh.position.x, pz = c.mesh.position.z;
    for (const o of cars) {
      if (o === c) continue;
      const rx = o.mesh.position.x - px, rz = o.mesh.position.z - pz;
      const f = rx * dx + rz * dz, lat = -rx * dz + rz * dx;
      if (f > 0 && f < 4 && Math.abs(lat) < 0.62) limit = Math.min(limit, brake(f - (c.len + o.len) / 2 - 0.4));
    }
    // Give way to pedestrians in front of the car.
    for (const w of walkers) {
      if (!w.path || !w.mesh.visible) continue;
      const rx = w.mesh.position.x - px, rz = w.mesh.position.z - pz;
      const f = rx * dx + rz * dz, lat = -rx * dz + rz * dx;
      if (f > 0.2 && f < 2.4 && Math.abs(lat) < 0.6) limit = Math.min(limit, brake(f - 1));
    }
    c.v = c.v < limit ? Math.min(limit, c.v + ACC * dt) : Math.max(limit, c.v - DEC * 1.6 * dt);
    const before = c.s;
    c.s += Math.max(0, c.v) * dt;
    if (c.occ !== c.b && c.s > S - STOP && before <= S - STOP + 0.3) {
      // Crossing the stop line: claim the junction, or (if someone else just did) stop right here.
      if (canEnter(c, c.b, axis)) { c.occ = c.b; c.occAxis = axis; } else { c.s = S - STOP; c.v = 0; }
    } else if (c.occ !== c.b && c.s > S - STOP) { c.occ = c.b; c.occAxis = axis; }
    if (c.s >= S) { c.s -= S; c.prev = c.a; c.a = c.b; c.b = c.next; c.next = null; }
    if (c.occ && c.occ === c.a && c.s > TURN + c.len / 2) c.occ = null;
    if (!c.next) c.next = chooseNext(c);
    placeCar(c, 1 - Math.exp(-dt * 25));
  }
}

/* ---------- time of day: the city follows the real clock ---------- */
const hemi = scene.children.find((o) => o.isHemisphereLight);
const DAY_BG = new THREE.Color(0xeef1f5), DUSK_BG = new THREE.Color(0xf3d9c4), NIGHT_BG = new THREE.Color(0x1b2233);
const hourParam = new URLSearchParams(location.search).get('hour'); // ?hour=21 to preview the night
let nightMats = [], lampMats = [], lastLight = -1;
function daylight() {
  const d = new Date();
  const h = hourParam != null && hourParam !== '' && !Number.isNaN(+hourParam) ? +hourParam : d.getHours() + d.getMinutes() / 60;
  if (h >= 7 && h < 17) return 1;
  if (h >= 17 && h < 19.5) return 1 - (h - 17) / 2.5;
  if (h >= 5 && h < 7) return (h - 5) / 2;
  return 0;
}
function applyDaylight(force) {
  const k = daylight();
  if (!force && Math.abs(k - lastLight) < 0.005) return;
  lastLight = k;
  // Day -> warm dusk -> night.
  if (k > 0.5) scene.background.copy(DUSK_BG).lerp(DAY_BG, (k - 0.5) * 2);
  else scene.background.copy(NIGHT_BG).lerp(DUSK_BG, k * 2);
  if (hemi) hemi.intensity = 0.5 + 1.0 * k;
  sun.intensity = 0.25 + 1.65 * k;
  sun.color.setHex(k < 1 && k > 0 ? 0xffd2a8 : 0xffffff);
  for (const m of nightMats) { m.emissive.setHex(0xffd98a); m.emissiveIntensity = (1 - k) * 0.95; }
  for (const m of lampMats) m.emissiveIntensity = 0.3 + (1 - k) * 1.4;
  document.body.classList.toggle('night', k < 0.4);
}
const winMat = () => { const m = mat(0xdbe7f5); nightMats.push(m); return m; };
const lampMat = (color, emissive) => { const m = mat(color, { emissive, emissiveIntensity: 0.7 }); lampMats.push(m); return m; };

/* ---------- a little celebration when something gets done ---------- */
const fx = new THREE.Group();
scene.add(fx);
const bursts = [];
const CONFETTI = [0xffc93c, 0xe5584f, 0x5b8def, 0x4caf7d, 0xb574d6, 0xe07ab0];
function celebrate(personId) {
  const l = labels.find((x) => x.id === personId);
  if (!l) return;
  const parts = [];
  for (let i = 0; i < 42; i++) {
    const c = CONFETTI[i % CONFETTI.length];
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.05), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35 }));
    m.position.copy(l.pos);
    const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 3;
    m.userData.v = new THREE.Vector3(Math.cos(a) * sp, 4 + Math.random() * 4, Math.sin(a) * sp);
    m.userData.r = new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 6);
    fx.add(m);
    parts.push(m);
  }
  bursts.push({ parts, age: 0 });
}
function stepFx(dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.age += dt;
    for (const m of b.parts) {
      m.userData.v.y -= 9 * dt;
      m.position.addScaledVector(m.userData.v, dt);
      m.rotation.x += m.userData.r.x * dt;
      m.rotation.y += m.userData.r.y * dt;
    }
    if (b.age > 2) {
      b.parts.forEach((m) => { fx.remove(m); m.geometry.dispose(); m.material.dispose(); });
      bursts.splice(i, 1);
    }
  }
}

/* ---------- pedestrians walking between buildings ---------- */
const SHIRTS = [0x5b8def, 0xe5584f, 0xf2a93b, 0x4caf7d, 0xb574d6, 0x3fb6b2, 0xe07ab0, 0x2f3a4d, 0xffffff];
const SKIN = [0xf1c9a5, 0xe0ac84, 0xc68863, 0x8d5a3b];
function makeWalker(rand) {
  const g = new THREE.Group();
  const legs = mat(0x3a4660);
  const l1 = box(0.09, 0.3, 0.09, legs, -0.06, 0.15, 0, g), l2 = box(0.09, 0.3, 0.09, legs, 0.06, 0.15, 0, g);
  cyl(0.14, 0.42, mat(SHIRTS[Math.floor(rand() * SHIRTS.length)]), 0, 0.5, 0, g, 10);
  ball(0.12, mat(SKIN[Math.floor(rand() * SKIN.length)]), 0, 0.84, 0, g);
  if (rand() < 0.6) ball(0.125, mat(rand() < 0.5 ? 0x2b2118 : 0x6b4a2e), 0, 0.89, -0.02, g).scale.set(1, 0.6, 1);
  g.scale.setScalar(1.15);
  g.userData.legs = [l1, l2];
  city.add(g);
  return g;
}
// Route along sidewalks: out the front door, along the block's front, down the side, across.
function walkPath(a, b) {
  const pts = [[a.x, a.z], [a.x, a.cz + WALK]];
  if (Math.abs(a.cz - b.cz) > 0.1 || Math.abs(a.cx - b.cx) > 0.1) {
    const sideX = b.cx >= a.cx ? a.cx + WALK : a.cx - WALK;
    if (Math.abs(a.cz - b.cz) > 0.1) pts.push([sideX, a.cz + WALK], [sideX, b.cz + WALK]);
    pts.push([b.x, b.cz + WALK]);
  }
  pts.push([b.x, b.z]);
  return pts;
}
function spawnWalkers() {
  if (spots.length < 2) return;
  const rand = rng(spots.length * 31);
  const n = Math.min(26, 6 + board.people.length * 3);
  for (let i = 0; i < n; i++) {
    const mesh = makeWalker(rand);
    const at = Math.floor(rand() * spots.length);
    const w = { mesh, rand, at, speed: 0.9 + rand() * 0.5, wait: rand() * 6, path: null, k: 0 };
    mesh.position.set(spots[at].x, 0.4, spots[at].z);
    mesh.visible = !spots[at].enter;
    walkers.push(w);
  }
}
function stepWalker(w, dt, t) {
  if (!w.path) {
    w.wait -= dt;
    if (w.wait > 0) return;
    let to = Math.floor(w.rand() * spots.length);
    if (to === w.at) to = (to + 1) % spots.length;
    w.path = walkPath(spots[w.at], spots[to]);
    w.to = to;
    w.k = 1;
    w.mesh.visible = true;
    w.mesh.position.set(w.path[0][0], 0.4, w.path[0][1]);
  }
  const [tx, tz] = w.path[w.k];
  const p = w.mesh.position, dx = tx - p.x, dz = tz - p.z, dist = Math.hypot(dx, dz);
  const step = w.speed * dt;
  if (dist <= step) {
    p.x = tx; p.z = tz;
    if (++w.k >= w.path.length) {
      w.at = w.to;
      w.path = null;
      const spot = spots[w.at];
      w.mesh.visible = !spot.enter; // walked inside
      w.wait = spot.enter ? 3 + w.rand() * 8 : 2 + w.rand() * 4;
    }
  } else {
    p.x += (dx / dist) * step;
    p.z += (dz / dist) * step;
    w.mesh.rotation.y = Math.atan2(dx, dz);
  }
  const swing = w.path ? Math.sin(t * 10 + w.speed * 7) * 0.5 : 0;
  w.mesh.userData.legs[0].rotation.x = swing;
  w.mesh.userData.legs[1].rotation.x = -swing;
  p.y = 0.4 + (w.path ? Math.abs(Math.sin(t * 10 + w.speed * 7)) * 0.04 : 0);
}

/* ---------- camera / controls ---------- */
const controls = new OrbitControls(camera, canvas);
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
controls.minZoom = 0.6;
controls.maxZoom = 5;

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
  // Fit the streets and blocks; the ring of trees outside may be cropped (drag to see it).
  for (const x of [-dims.coreW / 2, dims.coreW / 2]) for (const z of [-dims.coreD / 2, dims.coreD / 2]) for (const y of [0, 7]) {
    const p = new THREE.Vector3(x, y, z);
    mr = Math.max(mr, Math.abs(p.dot(right)));
    mu = Math.max(mu, Math.abs(p.dot(up)));
  }
  const half = Math.max(mu * 1.08, (mr * (narrow ? 0.9 : 1.02)) / (availW / h));
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
  const { key, cell } = hit.object.userData;
  if (layoutMode) return layoutPick(key, cell);
  if (!key || key.startsWith('d:')) return;
  showView(CIVIC.includes(key) ? { type: key } : { type: 'person', id: key });
});

const clock = new THREE.Clock();
const v = new THREE.Vector3();
(function tick() {
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  const now = new Date(), mins = now.getMinutes() + now.getSeconds() / 60;
  for (const a of animated) {
    if (a.type === 'bob') a.mesh.position.y = 0.79 + Math.abs(Math.sin(t * 2.2 + a.phase)) * 0.45;
    else if (a.type === 'pulse') a.mesh.material.emissiveIntensity = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 5));
    else if (a.type === 'glow') a.mesh.material.emissiveIntensity = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.5));
    else if (a.type === 'flag') a.mesh.rotation.y = Math.sin(t * 2) * 0.2;
    else if (a.type === 'spin') { a.mesh.rotation.y = t * 2; a.mesh.position.y = 0.68 + Math.sin(t * 3) * 0.06; }
    else if (a.type === 'grow') { const s = 0.75 + 0.25 * Math.sin(t * 1.6 + a.phase); a.mesh.scale.y = s; a.mesh.position.y = a.base + (a.h * s) / 2; }
    else if (a.type === 'jet') { const s = 0.8 + 0.35 * Math.abs(Math.sin(t * 3)); a.mesh.scale.set(s, 1 + 0.6 * Math.abs(Math.sin(t * 3)), s); }
    else if (a.type === 'smoke') {
      const k = (t * 0.25 + a.phase) % 1;
      a.mesh.position.y = a.base + k * 2.2;
      a.mesh.scale.setScalar(0.6 + k * 1.4);
      a.mesh.material.opacity = 0.8 * (1 - k);
    } else if (a.type === 'clock') {
      a.minute.rotation.z = -(mins / 60) * Math.PI * 2;
      a.hour.rotation.z = -(((now.getHours() % 12) + mins / 60) / 12) * Math.PI * 2;
    }
  }
  for (const w of walkers) stepWalker(w, dt, t);
  stepTraffic(dt, t);
  stepFx(dt);
  if ((t % 2) < dt) applyDaylight(false);
  controls.update();
  renderer.render(scene, camera);
  for (const l of labels) {
    v.copy(l.pos).project(camera);
    l.node.style.left = ((v.x + 1) / 2) * innerWidth + 'px';
    l.node.style.top = ((1 - v.y) / 2) * innerHeight + 'px';
  }
  requestAnimationFrame(tick);
})();

/* ---------- arranging the city ---------- */
function enterLayout() {
  if (!layoutMode) {
    const pl = placement(0);
    draft = { layout: Object.fromEntries(pl.pos), decor: board.decor.map((d) => ({ ...d })) };
    layoutMode = true;
    picked = null;
    buildCity();
    controls.reset();
    fitView();
  }
  showLayoutPanel();
}
function exitLayout() {
  if (!layoutMode) return;
  layoutMode = false;
  draft = null;
  picked = null;
  buildCity();
  controls.reset();
  fitView();
}
function layoutPick(key, cell) {
  if (key) {
    if (!picked || picked === key) picked = picked === key ? null : key;
    else {
      const a = draft.layout[picked], b = draft.layout[key];
      draft.layout[picked] = b;
      draft.layout[key] = a;
      picked = null;
      buildCity();
    }
  } else if (cell && picked) {
    const pl = placement(1);
    draft.layout[picked] = [cell[0] - pl.pad + pl.minC, cell[1] - pl.pad + pl.minR];
    picked = null;
    buildCity();
    fitView();
  }
  select(picked);
  showLayoutPanel();
}
function addDecor(type) {
  const id = uid();
  draft.decor.push({ id, type });
  draft.layout = Object.fromEntries(placement(0).pos); // give it a free block now
  picked = 'd:' + id;
  buildCity();
  fitView();
  select(picked);
  showLayoutPanel();
}
function showLayoutPanel() {
  openPanel('排列城市', { type: 'layout' });
  select(picked);
  body.append(el('div', 'hint', '點一個街區選取，再點空地搬過去，或點另一個街區互換位置。可以加廣場和公園。'));
  body.append(el('div', 'sec', '目前選取'));
  body.append(el('div', 't picked', picked ? itemName(picked) : '（還沒選）'));
  if (picked?.startsWith('d:')) {
    body.append(button('移除這個', 'danger', () => {
      draft.decor = draft.decor.filter((d) => 'd:' + d.id !== picked);
      delete draft.layout[picked];
      picked = null;
      buildCity();
      fitView();
      showLayoutPanel();
    }));
  }
  body.append(el('div', 'sec', '新增'));
  const row = el('div', 'btn-row');
  Object.entries(DECOR).forEach(([type, name]) => row.append(button('＋ ' + name, 'ghost', () => addDecor(type))));
  body.append(row);
  if (!canEdit()) body.append(editHint());
  const save = el('div', 'btn-row');
  save.append(
    button('儲存排列', '', async () => {
      const pl = placement(0);
      const layout = Object.fromEntries(pl.pos), decor = draft.decor;
      const ok = await mutate((b) => { b.layout = layout; b.decor = decor; return '調整了城市排列'; }, '排列已儲存');
      if (ok) { closePanel(); }
    }),
    button('取消', 'ghost', closePanel),
  );
  body.append(el('div', 'sec', ''), save);
}

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
  // Friday: a banner shortly before the meeting, and a nudge to hand in notes afterwards.
  const now = new Date();
  if (now.getDay() === 5) {
    const { time, skip, m } = meetingOf(today());
    if (!skip) {
      const [h, mi] = time.split(':').map(Number);
      const diff = h * 60 + mi - (now.getHours() * 60 + now.getMinutes());
      const go = (label, value) => {
        const c = el('button', 'chip warn click', label + (value ? ' ' : ''));
        c.type = 'button';
        if (value) c.append(el('b', '', value));
        c.onclick = () => showView({ type: 'calendar' });
        chips.append(c);
      };
      if (diff <= 60 && diff >= -20) go(`⏰ ${board.weekly.title} ${time}`, diff > 0 ? `${diff} 分鐘後` : '進行中');
      else if (diff < -60 && !m.submittedAt) go('📝 交週會筆記');
    }
  }

  const card = $('#focus');
  const { list, auto } = focusTasks();
  const collapsed = localStorage.getItem(LS_FOCUS) === '1';
  card.replaceChildren();
  card.hidden = !list.length;
  card.classList.toggle('collapsed', collapsed);
  const head = el('button', 'focus-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!collapsed));
  head.append(el('span', 'fh', '⭐ 今日三件事'), el('small', '', auto ? '自動挑選' : `${list.length} 件`), el('span', 'chev', collapsed ? '▸' : '▾'));
  head.onclick = () => {
    localStorage.setItem(LS_FOCUS, collapsed ? '0' : '1');
    updateHud();
    fitView();
  };
  card.append(head);
  if (collapsed) return;
  list.forEach((t) => {
    const r = el('div', 'focus-row');
    r.append(el('span', 'fdot ' + t.status), el('span', 'ft', t.title));
    if (t.owner !== leader().id) r.append(el('small', '', ownerName(t)));
    else if (t.due) r.append(el('small', isOverdue(t) ? 'late' : '', left(daysLeft(t.due))));
    r.onclick = () => showView({ type: 'person', id: t.owner });
    if (canEdit()) {
      const done = el('button', 'fdone', '✓');
      done.type = 'button';
      done.title = '標記完成';
      done.setAttribute('aria-label', `把「${t.title}」標記完成`);
      done.onclick = (e) => { e.stopPropagation(); completeTask(t.id); };
      r.append(done);
    }
    card.append(r);
  });
}

async function completeTask(id) {
  const owner = board.tasks.find((y) => y.id === id)?.owner;
  const ok = await mutate((b) => {
    const x = b.tasks.find((y) => y.id === id);
    if (!x || x.status === 'done') return null;
    x.status = 'done';
    x.doneAt = today();
    x.updated = today();
    delete x.focus; // frees a slot in today's three
    return `「${x.title}」→ 完成（${b.people.find((p) => p.id === x.owner)?.name ?? ''}）`;
  }, '🎉 完成了');
  if (ok) celebrate(owner);
}

/* ---------- panels ---------- */
const panel = $('#panel'), body = $('#panel-body'), title = $('#panel-title');
const NAV_OF = { dashboard: 'dashboard', team: 'team', mail: 'mail', settings: 'settings', layout: 'layout' };

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
  exitLayout();
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
  calendar: showCalendar, report: showReport, milestone: showMilestones, log: showLog, layout: enterLayout,
};
function showView(view) {
  // Leaving the arrange mode by opening another panel throws the draft away.
  if (layoutMode && view.type !== 'layout') exitLayout();
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
    button('儲存', '', async () => (await mutate((b) => {
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
    })) && status === 'done' && t.status !== 'done' && celebrate(owner.value)),
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
  let style = styleOf(p);
  const styles = el('div', 'seg styles');
  Object.entries(STYLES).forEach(([k, label]) => {
    const b = el('button', k === style ? 'on' : '', label);
    b.type = 'button';
    b.onclick = () => { style = k; styles.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    styles.append(b);
  });
  body.append(pname, role, el('div', 'sub', '建築樣式'), styles, el('div', 'sub', '顏色'), sw.node, button('儲存資料', 'ghost', () => {
    const nm = pname.value.trim();
    if (!nm) return pname.focus();
    mutate((bd) => {
      const x = bd.people.find((y) => y.id === id);
      if (x) Object.assign(x, { name: nm, role: role.value.trim(), color: sw.value, style });
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
  const fri = thisFriday(), m = board.meetings[fri];
  const meetRow = el('div', 'row click');
  const mg = el('div', 'grow');
  mg.append(el('div', 't', `📝 ${md(fri)} ${board.weekly.title}筆記`), el('div', 's', m?.submittedAt ? '已交給 Claude，週五會整理成大項' : m?.notes?.length ? `${m.notes.length} 則，還沒交給 Claude` : '還沒有筆記，點這裡去寫'));
  meetRow.append(mg, el('span', 'tag ' + (m?.submittedAt ? 'doing' : 'todo'), m?.submittedAt ? '已交' : '未交'));
  meetRow.onclick = () => showView({ type: 'calendar' });
  body.append(el('div', 'sec', '週會'), meetRow);
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
    const meet = [];
    if (wk.meeting?.highlights?.length) {
      // The big items from the Friday meeting come first.
      meet.push(el('div', 'meet-report-head', `📝 週會重點（${md(wk.meeting.date)}）`));
      const ol = el('ol', 'big-items');
      wk.meeting.highlights.forEach((s) => ol.append(el('li', '', s)));
      meet.push(ol, ...list('決議', wk.meeting.decisions), ...list('待辦', wk.meeting.actions));
    }
    archive.replaceChildren(tabs, el('div', 'summary', wk.summary || ''), ...meet, ...list('完成', wk.done), ...list('卡關', wk.blocked), ...list('下週重點', wk.next));
  };
  render(0);
}

/* ---------- calendar ---------- */
async function showCalendar() {
  openPanel('會議廳', { type: 'calendar' });
  body.append(meetingSection());
  const events = el('div');
  body.append(el('div', 'sec', 'Google 日曆'), events);
  events.append(el('div', 'muted', '讀取中…'));
  const [cal] = await Promise.all([loadExtra('calendar'), loadExtra('reports')]);
  if (currentView?.type !== 'calendar') return;
  updateMeetingStatus();
  events.replaceChildren();
  if (!cal) return events.append(el('div', 'muted', cal === false ? '行程檔的密碼和看板不同。' : '還沒有行程。每天早上排程會從 Google 日曆抓今天和明天的會議。'));
  const days = (cal.days ?? []).filter((d) => d.date >= today());
  if (!days.length) return events.append(el('div', 'muted', '今天和明天沒有行程資料，等明早排程更新。'));
  const nowHM = new Date().toTimeString().slice(0, 5);
  days.forEach((d) => {
    events.append(el('div', 'sub', `${d.date === today() ? '今天' : d.date === addDays(today(), 1) ? '明天' : ''} ${md(d.date)} · ${d.events.length} 場`));
    if (!d.events.length) events.append(el('div', 'muted', '沒有會議。'));
    let marked = false;
    d.events.forEach((e) => {
      const r = el('div', 'row event'), time = el('div', 'time', e.start ? e.start : '全天'), g = el('div', 'grow');
      if (e.end && e.start) time.append(el('small', '', e.end));
      g.append(el('div', 't', e.title));
      if (e.location) g.append(el('div', 's', e.location));
      if (d.date === today() && !marked && e.start && (e.end || e.start) >= nowHM) { r.classList.add('next'); marked = true; }
      if (d.date === today() && e.end && e.end < nowHM) r.classList.add('past');
      r.append(time, g);
      events.append(r);
    });
  });
  if (cal.generated) events.append(el('div', 'muted foot', `更新於 ${timeAgo(cal.generated)}`));
}

/* ---------- Friday meeting: notes for Claude to fold into the weekly report ---------- */
const thisFriday = () => addDays(weekRange()[0], 4);
const meetingDone = (fri) => (extra.reports?.weeks ?? []).some((w) => w.meeting?.date === fri);
let meetingStatusNode = null;
// This Friday's meeting: per-week overrides on top of the weekly default.
function meetingOf(fri) {
  const m = board.meetings[fri] ?? {};
  return { time: m.time || board.weekly.time || '15:00', skip: !!m.skip, m };
}
function updateMeetingStatus() {
  if (!meetingStatusNode) return;
  const fri = thisFriday(), m = board.meetings[fri];
  const [text, cls] = m?.skip ? ['這週不開', 'todo'] : meetingDone(fri) ? ['✓ 已彙整進週報', 'done']
    : m?.submittedAt ? [`已交給 Claude（${timeAgo(m.submittedAt)}）`, 'doing']
      : m?.notes?.length ? ['還沒交給 Claude', 'todo'] : ['還沒有筆記', 'todo'];
  meetingStatusNode.textContent = text;
  meetingStatusNode.className = 'tag ' + cls;
}
function pruneMeetings(b) {
  const keep = Object.keys(b.meetings).sort().slice(-MAX_MEETINGS);
  b.meetings = Object.fromEntries(keep.map((k) => [k, b.meetings[k]]));
}

function meetingSection() {
  const fri = thisFriday(), wk = board.weekly, m = { notes: [], ...(board.meetings[fri] ?? {}) };
  const { time, skip } = meetingOf(fri);
  const box = el('div', 'meet' + (skip ? ' skipped' : ''));
  const head = el('div', 'meet-head');
  head.append(el('div', 'meet-title', `🗓️ 每週五 ${wk.title} · ${wk.time || '15:00'}`));
  meetingStatusNode = el('span', 'tag');
  head.append(meetingStatusNode);
  box.append(head);
  const week = el('div', 'meet-week');
  week.append(el('b', '', skip ? `本週 ${md(fri)}：這週不開` : `本週 ${md(fri)} 週五 ${time}`), el('span', 'muted', skip ? '' : `（${left(daysLeft(fri))}）`));
  if (m.time && !skip) week.append(el('span', 'tag doing', '這週改時間'));
  box.append(week);
  if (wk.remind !== false && !skip) box.append(el('div', 'muted small', `⏰ 會前 30 分鐘提醒你；開完一小時後提醒你交筆記。`));
  if (canEdit()) {
    // This week only: move the meeting or skip it.
    const ctl = el('div', 'meet-ctl');
    const tm = field('time', '', time);
    tm.classList.add('inline');
    ctl.append(
      tm,
      button('改這週時間', 'small', () => {
        if (!tm.value) return tm.focus();
        mutate((b) => {
          b.meetings[fri] = { notes: [], ...(b.meetings[fri] ?? {}), time: tm.value === (b.weekly.time || '15:00') ? undefined : tm.value, skip: undefined };
          pruneMeetings(b);
          return `本週${b.weekly.title}改到 ${md(fri)} ${tm.value}`;
        }, `本週改到 ${tm.value}`);
      }),
      button(skip ? '恢復這週週會' : '這週不開', 'small' + (skip ? '' : ' danger'), () => {
        mutate((b) => {
          b.meetings[fri] = { notes: [], ...(b.meetings[fri] ?? {}), skip: skip ? undefined : true };
          pruneMeetings(b);
          return skip ? `恢復本週${b.weekly.title}（${md(fri)}）` : `本週${b.weekly.title}不開（${md(fri)}）`;
        }, skip ? '已恢復本週週會' : '這週不開，不會提醒你');
      }),
    );
    box.append(ctl);
  }
  updateMeetingStatus();

  box.append(el('div', 'sub', `週會筆記（${m.notes.length}）`));
  if (!m.notes.length) box.append(el('div', 'muted', '開完會把統整寫在這裡：重點、決議、誰要做什麼。交給 Claude 後，週五的週報會整理成大項。'));
  m.notes.forEach((n) => {
    const r = el('div', 'note');
    r.append(el('div', 'note-text', n.text), el('div', 's', timeAgo(n.at)));
    if (canEdit()) {
      const del = el('button', 'x', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', '刪除這則筆記');
      del.onclick = () => {
        if (confirm('刪除這則筆記？')) mutate((b) => {
          const mm = b.meetings[fri];
          if (mm) mm.notes = mm.notes.filter((y) => y.id !== n.id);
          return `刪除一則週會筆記（${md(fri)}）`;
        }, '已刪除');
      };
      r.append(del);
    }
    box.append(r);
  });

  if (!canEdit()) { box.append(editHint()); return box; }
  const text = el('textarea', 'field note-input');
  text.rows = 5;
  text.maxLength = 4000;
  text.placeholder = '例如：\n1. PCB 改版延到下週三\n2. 決議：LED 改用備援供應商\n3. 阿哲 週二前回報良率';
  const row = el('div', 'btn-row');
  row.append(
    button('＋ 加入筆記', 'ghost', () => {
      const v = text.value.trim();
      if (!v) return text.focus();
      mutate((b) => {
        b.meetings[fri] = b.meetings[fri] ?? { notes: [] };
        b.meetings[fri].notes.push({ id: uid(), text: v, at: new Date().toISOString() });
        pruneMeetings(b);
        return `新增週會筆記（${md(fri)}）`;
      }, '筆記已加入');
    }),
    button('📤 交給 Claude 彙整', '', () => {
      const v = text.value.trim();
      if (!v && !m.notes.length) return text.focus();
      mutate((b) => {
        b.meetings[fri] = b.meetings[fri] ?? { notes: [] };
        if (v) b.meetings[fri].notes.push({ id: uid(), text: v, at: new Date().toISOString() });
        b.meetings[fri].submittedAt = new Date().toISOString();
        pruneMeetings(b);
        return `週會筆記交給 Claude 彙整（${md(fri)}）`;
      }, '已交給 Claude，週報排程會整理成大項');
    }),
  );
  box.append(text, row, el('div', 'muted small', '週五 18:00 週報排程會讀取已交的筆記。想馬上整理：在 Claude app 的「Scheduled」找到「每週五週報」按 Run now。'));

  const more = el('details', 'meet-settings');
  more.append(el('summary', '', '週會設定'));
  const t = field('text', '名稱（例如：週會）', wk.title);
  const tm = field('time', '', wk.time || '15:00');
  const rem = el('label', 'check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = wk.remind !== false;
  rem.append(cb, el('span', '', '開會前 30 分鐘提醒我、會後提醒交筆記'));
  more.append(el('div', 'sub', '名稱'), t, el('div', 'sub', '每週五預設時間'), tm, rem, button('儲存設定', 'ghost', () => {
    const title = t.value.trim() || '週會';
    const time = tm.value || '15:00';
    mutate((b) => { b.weekly = { ...b.weekly, title, time, remind: cb.checked }; return `週會設定：每週五 ${title} ${time}${cb.checked ? '' : '（不提醒）'}`; });
  }));
  more.append(el('div', 'muted small', '提醒支援 08:30–19:30 之間的時間。'));
  box.append(more);
  return box;
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

// Local preview only: expose the traffic for automated checks.
if (isLocal) window.__city = { get cars() { return cars; }, get walkers() { return walkers; } };

// Keep time-based bits (meeting banner, countdowns) current while the page stays open.
setInterval(() => {
  if (!board) return;
  const before = $('#hud').offsetHeight;
  updateHud();
  updateCivicLabels();
  if ($('#hud').offsetHeight !== before) fitView();
}, 60000);

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
