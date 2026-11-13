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
const BOARD_PATH = 'data/board.enc.json';
const MAIL_PATH = 'data/mail.enc.json';
const LS_TOKEN = 'board.ghToken';
const LS_PW = 'board.pw';

const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toLocaleDateString('sv-SE');
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#6c7a89');
const pct = (ts) => (ts.length ? Math.round((ts.reduce((a, t) => a + (t.status === 'done' ? 1 : t.status === 'doing' ? 0.5 : 0), 0) / ts.length) * 100) : 0);
const daysLeft = (d) => Math.ceil((new Date(d + 'T00:00:00') - new Date(new Date().toDateString())) / 864e5);
const dueText = (d) => {
  const n = daysLeft(d);
  return `${d.slice(5).replace('-', '/')}（${n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天' : `剩 ${n} 天`}）`;
};
const sortTasks = (ts) => [...ts].sort((a, b) => SORT[a.status] - SORT[b.status] || (a.due || '9').localeCompare(b.due || '9'));
const isOverdue = (t) => t.due && t.status !== 'done' && daysLeft(t.due) < 0;

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
  // Reuse the previous salt so the derived key is cached; the IV is always fresh.
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
  return fetch(`${REPO.api}/repos/${REPO.owner}/${REPO.repo}/contents/${BOARD_PATH}`, { method, headers, cache: 'no-store', body: body && JSON.stringify(body) });
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
  return fetchJSON(BOARD_PATH);
}

/* ---------- state ---------- */
let board = null, password = null, digest = null, currentView = null;

function normalize(d) {
  const b = {
    v: 1,
    project: { name: '團隊進度', ...(d.project || {}) },
    people: Array.isArray(d.people) ? d.people : [],
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
  };
  if (!b.people.some((p) => p.kind === 'leader')) b.people.unshift({ id: 'me', name: '我', role: 'Leader', color: '#5b8def', kind: 'leader' });
  if (!b.people.some((p) => p.kind === 'claude')) b.people.push({ id: 'claude', name: 'Claude', role: 'AI 助理', color: '#d97757', kind: 'claude' });
  const rank = (p) => (p.kind === 'leader' ? 0 : p.kind === 'claude' ? 1 : 2);
  b.people.sort((x, y) => rank(x) - rank(y));
  const ids = new Set(b.people.map((p) => p.id));
  b.tasks = b.tasks.filter((t) => ids.has(t.owner));
  b.tasks.forEach((t) => { if (!STATUS[t.status]) t.status = 'todo'; });
  return b;
}
const tasksOf = (id) => board.tasks.filter((t) => t.owner === id);
const person = (id) => board.people.find((p) => p.id === id);

let toastTimer;
function toast(msg, sticky) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Every change re-reads the latest version, applies `fn` to it and writes it back,
// so edits from the phone, the computer and Claude don't overwrite each other.
async function mutate(fn, okMsg = '已儲存') {
  if (!canEdit()) { toast('要編輯，請先到 ⚙️ 設定 GitHub 權杖'); return false; }
  document.body.classList.add('busy');
  toast('儲存中…', true);
  try {
    for (let i = 0; i < 3; i++) {
      const { blob, sha } = await readRemote();
      const latest = normalize(await decryptBlob(blob, password));
      fn(latest);
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
Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 130 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const city = new THREE.Group();
scene.add(city);
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
const place = (mesh, x, y, z, parent) => {
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
};
const box = (w, h, d, m, x, y, z, parent = city) => place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, parent);
const cyl = (r, h, m, x, y, z, parent = city) => place(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), m), x, y, z, parent);

const labelLayer = $('#labels');
let pickables = [], animated = [], labels = [], rings = new Map(), parcels = [];
let dims = { W: 28, D: 18, street: 5.4 };

function clearCity() {
  city.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  city.clear();
  labelLayer.replaceChildren();
  pickables = []; animated = []; labels = []; rings = new Map(); parcels = [];
}

function addLabel(node, pos, id) {
  labelLayer.append(node);
  labels.push({ node, pos, id });
}

function buildCity() {
  clearCity();
  const people = board.people, S = 10, n = people.length;
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const W = (cols - 1) * S + 18, D = (rows - 1) * S + 18;
  const street = ((rows - 1) / 2) * S + 5.4;
  dims = { W, D, street };

  box(W, 0.4, D, mat(0xe2e7ee), 0, -0.2, 0).castShadow = false;
  const roadMat = mat(0xc9d0d9);
  const road = (w, d, x, z) => { box(w, 0.1, d, roadMat, x, 0.05, z).castShadow = false; };
  road(W - 2, 1.2, 0, street);
  for (let c = 0; c < cols - 1; c++) road(1.2, D - 2, (c + 0.5 - (cols - 1) / 2) * S, 0);
  for (let r = 0; r < rows - 1; r++) road(W - 2, 1.2, 0, (r + 0.5 - (rows - 1) / 2) * S);

  people.forEach((p, i) => {
    const g = new THREE.Group();
    g.position.set((i % cols - (cols - 1) / 2) * S, 0, (Math.floor(i / cols) - (rows - 1) / 2) * S);
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

    // One crate per task (up to 18), most urgent first.
    sortTasks(mine).slice(0, 18).forEach((t, k) => {
      const m = mat(STATUS[t.status].color, t.status === 'blocked' ? { emissive: 0xe5584f, emissiveIntensity: 0 } : {});
      const crate = box(0.78, 0.78, 0.78, m, 0.6 + (k % 3), 0.89, -2.5 + Math.floor(k / 3), g);
      parts.push(crate);
      if (t.status === 'doing') animated.push({ type: 'bob', mesh: crate, phase: k });
      if (t.status === 'blocked') animated.push({ type: 'pulse', mesh: crate });
    });
    parts.forEach((m) => { m.userData.person = p.id; pickables.push(m); });

    const label = el('div', 'label');
    const dot = el('span', 'dot');
    dot.style.background = safeColor(p.color);
    label.append(dot, el('span', '', p.name), el('small', '', `${mine.filter((t) => t.status === 'done').length}/${mine.length}`));
    if (mine.some((t) => t.status === 'blocked')) label.append(el('span', 'warn', '!'));
    addLabel(label, g.position.clone().add(new THREE.Vector3(-1.7, top + 0.5, -1.7)), p.id);
  });

  // Mailbox next to the main street: opens the mail digest.
  const mg = new THREE.Group();
  mg.position.set(-W / 2 + 4.5, 0, street + 2.4);
  city.add(mg);
  [box(0.3, 1.2, 0.3, mat(0x55606f), 0, 0.6, 0, mg), box(1.5, 1, 1.1, mat(0xe5584f), 0, 1.7, 0, mg), box(1.1, 0.12, 0.05, mat(0xffffff), 0, 1.8, 0.58, mg)]
    .forEach((m) => { m.userData.action = 'mail'; pickables.push(m); });
  addLabel(el('div', 'label', '✉️ 信件'), mg.position.clone().add(new THREE.Vector3(0, 3, 0)));

  const tree = (x, z) => {
    box(0.35, 0.9, 0.35, mat(0x8a6f55), x, 0.45, z);
    place(new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.4, 6), mat(0x7cc29a)), x, 2.1, z, city);
  };
  const tx = W / 2 - 1.5, tz = D / 2 - 1.5;
  [[-tx, -tz], [tx, -tz], [tx, street + 2.4], [-tx, 0], [tx, 0]].forEach(([x, z]) => tree(x, z));

  for (let k = 0; k < 3; k++) parcels.push({ mesh: box(0.55, 0.55, 0.55, mat(0x1f2733), 0, 0.42, street), t: k / 3 });
}

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
  for (const x of [-dims.W / 2, dims.W / 2]) for (const z of [-dims.D / 2, dims.D / 2]) for (const y of [0, 7]) {
    const p = new THREE.Vector3(x, y, z);
    mr = Math.max(mr, Math.abs(p.dot(right)));
    mu = Math.max(mu, Math.abs(p.dot(up)));
  }
  const half = Math.max(mu * 1.12, (mr * 0.98) / (availW / h));
  // Keep the city clear of the header; on phones, lift it above the open bottom sheet.
  const pad = half * (narrow && open ? -0.3 : narrow ? 0.02 : 0.2);
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
  if (hit.object.userData.action === 'mail') showView({ type: 'mail' });
  else showView({ type: 'person', id: hit.object.userData.person });
});

const clock = new THREE.Clock();
const v = new THREE.Vector3();
(function tick() {
  const t = clock.getElapsedTime();
  for (const a of animated) {
    if (a.type === 'bob') a.mesh.position.y = 0.89 + Math.abs(Math.sin(t * 2.2 + a.phase)) * 0.45;
    else if (a.type === 'pulse') a.mesh.material.emissiveIntensity = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 5));
    else if (a.type === 'glow') a.mesh.material.emissiveIntensity = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.5));
    else if (a.type === 'flag') a.mesh.rotation.y = Math.sin(t * 2) * 0.2;
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

/* ---------- HUD ---------- */
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

function showView(view) {
  const same = currentView && currentView.type === view.type && currentView.id === view.id;
  const scroll = same ? body.scrollTop : 0;
  ({ person: showPerson, dashboard: showDashboard, team: showTeam, mail: showMail, settings: showSettings })[view.type](view);
  body.scrollTop = scroll;
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
const editHint = () => el('div', 'hint', isLocal || REPO
  ? '目前是唯讀。要在這裡新增或修改，請先到 ⚙️ 設定 GitHub 權杖。'
  : '這個網址無法儲存修改。');

function taskRow(t, showOwner) {
  const wrap = el('div');
  const r = el('div', 'row' + (canEdit() ? ' click' : '')), g = el('div', 'grow');
  g.append(el('div', 't', t.title));
  const sub = [showOwner ? person(t.owner)?.name : null, t.due ? dueText(t.due) : null, t.note].filter(Boolean).join(' · ');
  if (sub) g.append(el('div', 's', sub));
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
  let status = t.status;
  const seg = el('div', 'seg');
  Object.entries(STATUS).forEach(([k, s]) => {
    const b = el('button', k === status ? 'on' : '', s.label);
    b.type = 'button';
    b.onclick = () => { status = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    seg.append(b);
  });
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
      if (!x) return;
      x.title = name.value.trim() || x.title;
      x.status = status;
      if (b.people.some((p) => p.id === owner.value)) x.owner = owner.value;
      x.due = due.value || undefined;
      x.note = note.value.trim() || undefined;
      x.updated = today();
    })),
    button('刪除', 'danger', () => {
      if (confirm(`刪除任務「${t.title}」？`)) mutate((b) => { b.tasks = b.tasks.filter((y) => y.id !== t.id); }, '已刪除');
    }),
  );
  box.append(seg, name, owner, due, note, row);
  return box;
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
  if (!canEdit()) body.append(editHint());

  body.append(el('div', 'sec', '任務'));
  if (!mine.length) body.append(el('div', 'muted', '還沒有任務。'));
  sortTasks(mine).forEach((t) => body.append(taskRow(t)));

  if (!canEdit()) return;
  body.append(el('div', 'sec', '新增任務'));
  const name = field('text', '任務名稱');
  const due = field('date');
  name.onkeydown = (e) => { if (e.key === 'Enter') add.click(); };
  const add = button('＋ 新增任務', '', () => {
    const t = name.value.trim();
    if (!t) return name.focus();
    mutate((b) => { b.tasks.push({ id: uid(), owner: id, title: t, status: 'todo', due: due.value || undefined, updated: today() }); }, '已新增任務');
  });
  body.append(name, due, add);

  body.append(el('div', 'sec', p.kind === 'member' ? '成員資料' : '名稱'));
  const pname = field('text', '名字', p.name);
  const role = field('text', '角色（例如：電子工程）', p.role || '');
  const sw = swatches(p.color);
  body.append(pname, role, sw.node, button('儲存資料', 'ghost', () => {
    const nm = pname.value.trim();
    if (!nm) return pname.focus();
    mutate((b) => {
      const x = b.people.find((y) => y.id === id);
      if (x) Object.assign(x, { name: nm, role: role.value.trim(), color: sw.value });
    });
  }));
  if (p.kind === 'member') {
    body.append(button('移除成員', 'danger', () => {
      const n = mine.length;
      if (confirm(`移除「${p.name}」？${n ? `他的 ${n} 個任務也會一起刪除。` : ''}`)) {
        mutate((b) => {
          b.people = b.people.filter((y) => y.id !== id);
          b.tasks = b.tasks.filter((y) => y.owner !== id);
        }, '已移除成員');
      }
    }));
  }
}

function showDashboard() {
  openPanel('總覽', { type: 'dashboard' });
  const ts = board.tasks;
  body.append(el('div', 'big', pct(ts) + '%'), el('div', 'muted', `整體進度 · 共 ${ts.length} 個任務`));
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
  const blocked = ts.filter((t) => t.status === 'blocked');
  if (blocked.length) {
    body.append(el('div', 'sec', '卡關'));
    blocked.forEach((t) => body.append(taskRow(t, true)));
  }
  const upcoming = ts.filter((t) => t.due && t.status !== 'done').sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8);
  if (upcoming.length) {
    body.append(el('div', 'sec', '到期日'));
    upcoming.forEach((t) => body.append(taskRow(t, true)));
  }
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
    mutate((b) => { b.people.push({ id: uid(), name: nm, role: role.value.trim(), color: sw.value, kind: 'member' }); }, `已新增 ${nm}`);
  }));
}

function showSettings() {
  openPanel('設定', { type: 'settings' });
  body.append(el('div', 'sec', '看板名稱'));
  const name = field('text', '看板名稱', board.project.name);
  name.disabled = !canEdit();
  body.append(name);
  if (canEdit()) body.append(button('儲存名稱', 'ghost', () => {
    const nm = name.value.trim();
    if (nm) mutate((b) => { b.project.name = nm; });
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
      const v = input.value.trim();
      if (!v) return input.focus();
      localStorage.setItem(LS_TOKEN, v);
      input.value = '';
      try { await readRemote(); toast('權杖已儲存'); } catch (e) { toast('權杖已儲存，但讀取失敗：' + e.message); }
      showSettings();
    }));
    if (token()) body.append(button('移除這台裝置的權杖', 'ghost', () => {
      localStorage.removeItem(LS_TOKEN);
      toast('已移除權杖');
      showSettings();
    }));
  }

  body.append(el('div', 'sec', '這台裝置'));
  body.append(el('div', 'muted', localStorage.getItem(LS_PW) ? '這台裝置記住了密碼。' : '這台裝置沒有記住密碼，每次打開都要輸入。'));
  body.append(button('上鎖並忘記密碼', 'ghost', () => { localStorage.removeItem(LS_PW); location.reload(); }));
}

/* ---------- mail digest ---------- */
async function showMail() {
  openPanel('每日信件摘要', { type: 'mail' });
  if (digest) return renderDigest(0);
  body.append(el('div', 'muted', '解密中…'));
  let blob;
  try { blob = await fetchJSON(MAIL_PATH); } catch {
    if (currentView?.type !== 'mail') return;
    body.replaceChildren(el('div', 'muted', '還沒有信件摘要，排程第一次執行後就會出現。'));
    return;
  }
  try { digest = await decryptBlob(blob, password); } catch { /* different password: ask below */ }
  if (currentView?.type !== 'mail') return;
  body.replaceChildren();
  if (digest) return renderDigest(0);

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
    try { digest = await decryptBlob(blob, input.value); renderDigest(0); } catch { err.textContent = '密碼不正確。'; btn.disabled = false; }
  };
  body.append(form);
}

function renderDigest(index) {
  body.replaceChildren();
  const days = digest.days ?? [];
  if (!days.length) return body.append(el('div', 'muted', '目前沒有摘要。'));
  const tabs = el('div', 'days');
  days.forEach((d, i) => {
    const b = el('button', i === index ? 'on' : '', d.date.slice(5).replace('-', '/'));
    b.onclick = () => renderDigest(i);
    tabs.append(b);
  });
  const day = days[index];
  body.append(tabs, el('div', 'summary', day.summary));
  body.append(el('div', 'sec', `信件（${day.items.length}）`));
  day.items.forEach((m) => {
    const box = el('div', 'mail'), top = el('div', 'top');
    top.append(el('div', 'subj', m.subject), el('span', 'tag ' + (PRIORITY[m.priority] ? m.priority : 'low'), PRIORITY[m.priority] ?? PRIORITY.low));
    box.append(top, el('div', 'from', m.from), el('div', 'gist', m.gist));
    if (m.action) box.append(el('div', 'act', '→ ' + m.action));
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
