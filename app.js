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
  done: { label: '完成', color: 0x4caf7d, weight: 1 },
  doing: { label: '進行中', color: 0xf2a93b, weight: 0.5 },
  todo: { label: '待辦', color: 0xc9ced6, weight: 0 },
  blocked: { label: '卡關', color: 0xe5584f, weight: 0 },
};
const PRIORITY = { high: '重要', mid: '一般', low: '知會' };

const project = await fetch('data/project.json', { cache: 'no-store' }).then((r) => r.json());
const stages = project.stages;
const pct = (tasks) =>
  tasks.length ? Math.round((tasks.reduce((a, t) => a + (STATUS[t.status]?.weight ?? 0), 0) / tasks.length) * 100) : 0;
const allTasks = stages.flatMap((s, i) => s.tasks.map((t) => ({ ...t, stage: s.name, stageIndex: i })));
const daysLeft = (d) => Math.ceil((new Date(d + 'T00:00:00') - new Date(new Date().toDateString())) / 864e5);
const dueText = (d) => {
  if (!d) return '';
  const n = daysLeft(d);
  return `${d.slice(5).replace('-', '/')}（${n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天' : `剩 ${n} 天`}）`;
};

/* ---------- HUD ---------- */
$('#hud-code').textContent = project.code;
$('#hud-title').textContent = project.name;
document.title = project.name;
{
  const chips = $('#hud-chips');
  const chip = (label, value, warn) => {
    const c = el('div', 'chip' + (warn ? ' warn' : ''), label + ' ');
    c.append(el('b', '', value));
    chips.append(c);
  };
  chip('整體進度', pct(allTasks) + '%');
  const blocked = allTasks.filter((t) => t.status === 'blocked').length;
  if (blocked) chip('卡關', blocked + ' 項', true);
  if (project.nextMilestone) chip(project.nextMilestone.name, dueText(project.nextMilestone.date));
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
const CAM_OFFSET = new THREE.Vector3(60, 60, 60);

scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6e0, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(-18, 40, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 120 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
const box = (w, h, d, material, x, y, z, parent = scene) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
};

const SPACING = 9;
const centers = stages.map((_, i) => new THREE.Vector3((i - (stages.length - 1) / 2) * SPACING, 0, i % 2 ? 3.2 : -3.2));

const ground = box(SPACING * stages.length + 16, 0.4, 30, mat(0xe2e7ee), 0, -0.2, 0);
ground.castShadow = false;

const pickables = [];
const animated = [];
const stageGroups = [];
const rings = [];

stages.forEach((stage, i) => {
  const g = new THREE.Group();
  g.position.copy(centers[i]);
  scene.add(g);
  stageGroups.push(g);
  const base = new THREE.Color(stage.color);
  const light = base.clone().lerp(new THREE.Color(0xffffff), 0.72);
  const progress = pct(stage.tasks) / 100;

  const ring = box(7.3, 0.2, 7.3, mat(0x1f2733), 0, 0.1, 0, g);
  ring.castShadow = false;
  ring.visible = false;
  rings.push(ring);

  const parts = [box(6.6, 0.5, 6.6, mat(light), 0, 0.25, 0, g)];

  // Building: height grows with stage progress
  const h = 1.6 + progress * 3;
  parts.push(box(2.6, h, 2.6, mat(base), -1.6, 0.5 + h / 2, -1.6, g));
  parts.push(box(2.9, 0.25, 2.9, mat(0xffffff), -1.6, 0.5 + h + 0.125, -1.6, g));
  parts.push(box(0.7, 1, 0.1, mat(0xffffff), -1.6, 1, -0.28, g));

  // One crate per task
  stage.tasks.forEach((t, k) => {
    const st = STATUS[t.status] ?? STATUS.todo;
    const col = k % 3, row = Math.floor(k / 3);
    const m = mat(st.color, t.status === 'blocked' ? { emissive: 0xe5584f, emissiveIntensity: 0 } : {});
    const crate = box(0.95, 0.95, 0.95, m, 0.9 + (col - 1) * 1.25 + 0.6, 0.975, 1.2 + row * 1.25 - (col === 0 ? 0 : 0), g);
    if (col === 0) crate.position.x = -0.9;
    if (col === 1) crate.position.x = 0.55;
    if (col === 2) crate.position.x = 2.0;
    crate.position.z = 0.7 + row * 1.3;
    parts.push(crate);
    if (t.status === 'doing') animated.push({ type: 'bob', mesh: crate, phase: k });
    if (t.status === 'blocked') animated.push({ type: 'pulse', mesh: crate });
  });

  parts.forEach((p) => { p.userData.stage = i; pickables.push(p); });
});

// Paths between stages with travelling parcels
for (let i = 0; i < centers.length - 1; i++) {
  const a = centers[i], b = centers[i + 1];
  const len = a.distanceTo(b);
  const road = box(len, 0.12, 1.1, mat(0xc5ccd6), (a.x + b.x) / 2, 0.06, (a.z + b.z) / 2);
  road.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  road.castShadow = false;
}
const parcels = [];
for (let k = 0; k < Math.max(3, stages.length); k++) {
  parcels.push({ mesh: box(0.55, 0.55, 0.55, mat(0x1f2733), 0, 0.9, 0), t: k / Math.max(3, stages.length) });
}

// Mailbox: opens the mail panel
{
  const g = new THREE.Group();
  g.position.set(centers[0].x - 6.2, 0, centers[0].z + 6.5);
  scene.add(g);
  const parts = [
    box(0.3, 1.2, 0.3, mat(0x55606f), 0, 0.6, 0, g),
    box(1.5, 1, 1.1, mat(0xe5584f), 0, 1.7, 0, g),
    box(1.1, 0.12, 0.05, mat(0xffffff), 0, 1.8, 0.58, g),
  ];
  parts.forEach((p) => { p.userData.action = 'mail'; pickables.push(p); });
  centers.mail = g.position.clone();
}

// Trees
[[-0.42, -9.5], [-0.2, 10.5], [0.08, -10], [0.3, 10], [0.46, -9], [-0.48, 3], [0.5, 4]].forEach(([fx, z]) => {
  const x = fx * (SPACING * stages.length + 10);
  box(0.35, 0.9, 0.35, mat(0x8a6f55), x, 0.45, z);
  const top = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.4, 6), mat(0x7cc29a));
  top.position.set(x, 2.1, z);
  top.castShadow = true;
  scene.add(top);
});

/* ---------- labels ---------- */
const labelLayer = $('#labels');
const labels = stages.map((s, i) => {
  const l = el('div', 'label');
  const dot = el('span', 'dot');
  dot.style.background = s.color;
  l.append(dot, el('span', '', s.name), el('small', '', pct(s.tasks) + '%'));
  labelLayer.append(l);
  return { node: l, pos: centers[i].clone().add(new THREE.Vector3(-1.6, 2.6 + (pct(s.tasks) / 100) * 3, -1.6)) };
});
{
  const l = el('div', 'label', '✉️ 信件');
  labelLayer.append(l);
  labels.push({ node: l, pos: centers.mail.clone().add(new THREE.Vector3(0, 3, 0)) });
}

/* ---------- camera / controls ---------- */
const controls = new OrbitControls(camera, canvas);
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
controls.minZoom = 0.6;
controls.maxZoom = 4;
camera.position.copy(CAM_OFFSET);
camera.lookAt(0, 0, 0);

function fitView() {
  const w = innerWidth, h = innerHeight, aspect = w / h;
  renderer.setSize(w, h, false);
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  let mr = 0, mu = 0;
  const hx = (SPACING * (stages.length - 1)) / 2 + 7.5, hz = 8;
  for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [0, 6]) {
    const p = new THREE.Vector3(x, y, z);
    mr = Math.max(mr, Math.abs(p.dot(right)));
    mu = Math.max(mu, Math.abs(p.dot(up)));
  }
  const half = Math.max(mu * 1.12, (mr * 0.98) / aspect);
  camera.left = -half * aspect; camera.right = half * aspect;
  // Shift the scene clear of the header; on phones, lift it above the open bottom sheet.
  const narrow = w <= 720;
  const sheetOpen = narrow && document.body.classList.contains('panel-open');
  const pad = half * (sheetOpen ? -0.3 : narrow ? 0.02 : 0.2);
  camera.top = half + pad; camera.bottom = -half + pad;
  camera.updateProjectionMatrix();
}
addEventListener('resize', fitView);
fitView();

/* ---------- picking ---------- */
const raycaster = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 7) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  if (!hit) return;
  if (hit.object.userData.action === 'mail') openView('mail');
  else showStage(hit.object.userData.stage);
});

/* ---------- render loop ---------- */
const clock = new THREE.Clock();
const v = new THREE.Vector3();
function tick() {
  const t = clock.getElapsedTime();
  for (const a of animated) {
    if (a.type === 'bob') a.mesh.position.y = 0.975 + Math.abs(Math.sin(t * 2.2 + a.phase)) * 0.45;
    else a.mesh.material.emissiveIntensity = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t * 5));
  }
  const segs = centers.length - 1;
  for (const p of parcels) {
    const u = ((p.t + t * 0.035) % 1) * segs;
    const i = Math.min(Math.floor(u), segs - 1);
    p.mesh.position.lerpVectors(centers[i], centers[i + 1], u - i).setY(0.42);
  }
  controls.update();
  renderer.render(scene, camera);
  for (const l of labels) {
    v.copy(l.pos).project(camera);
    l.node.style.left = ((v.x + 1) / 2) * innerWidth + 'px';
    l.node.style.top = ((1 - v.y) / 2) * innerHeight + 'px';
  }
  requestAnimationFrame(tick);
}
tick();

/* ---------- panels ---------- */
const panel = $('#panel'), body = $('#panel-body'), title = $('#panel-title');
function openPanel(name, view) {
  title.textContent = name;
  body.replaceChildren();
  panel.hidden = false;
  document.body.classList.add('panel-open');
  fitView();
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  body.scrollTop = 0;
}
function select(i) {
  rings.forEach((r, k) => (r.visible = k === i));
  labels.forEach((l, k) => l.node.classList.toggle('sel', k === i));
}
function closePanel() {
  panel.hidden = true;
  document.body.classList.remove('panel-open');
  fitView();
  document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('on'));
  select(-1);
}
$('#panel-close').onclick = closePanel;
document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => openView(b.dataset.view)));
function openView(view) {
  select(-1);
  ({ dashboard: showDashboard, team: showTeam, mail: showMail })[view]();
}

const bar = (value, color) => {
  const b = el('div', 'bar'), i = el('i');
  i.style.width = value + '%';
  i.style.background = color;
  b.append(i);
  return b;
};
function taskRow(t, showStageName) {
  const r = el('div', 'row'), g = el('div', 'grow');
  g.append(el('div', 't', t.title));
  const sub = [showStageName ? t.stage : null, t.owner, t.due ? dueText(t.due) : null, t.note].filter(Boolean).join(' · ');
  if (sub) g.append(el('div', 's', sub));
  r.append(g, el('span', 'tag ' + t.status, STATUS[t.status]?.label ?? t.status));
  return r;
}

function showStage(i) {
  const s = stages[i];
  openPanel(s.name + ' 階段');
  select(i);
  const p = pct(s.tasks);
  body.append(el('div', 'big', p + '%'), el('div', 'muted', `${s.tasks.filter((t) => t.status === 'done').length} / ${s.tasks.length} 項完成`));
  const b = bar(p, s.color);
  b.style.margin = '10px 0 4px';
  body.append(b, el('div', 'sec', '任務'));
  s.tasks.forEach((t) => body.append(taskRow(t)));
}

function showDashboard() {
  openPanel('專案總覽', 'dashboard');
  body.append(el('div', 'big', pct(allTasks) + '%'), el('div', 'muted', '整體進度'));
  body.append(el('div', 'sec', '各階段'));
  stages.forEach((s, i) => {
    const r = el('div', 'row stage-row'), g = el('div', 'grow');
    g.append(el('div', 't', s.name), bar(pct(s.tasks), s.color));
    g.firstChild.style.marginBottom = '6px';
    r.append(g, el('b', '', pct(s.tasks) + '%'));
    r.onclick = () => showStage(i);
    body.append(r);
  });
  const blocked = allTasks.filter((t) => t.status === 'blocked');
  if (blocked.length) {
    body.append(el('div', 'sec', '卡關'));
    blocked.forEach((t) => body.append(taskRow(t, true)));
  }
  const upcoming = allTasks.filter((t) => t.due && t.status !== 'done').sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
  if (upcoming.length) {
    body.append(el('div', 'sec', '即將到期'));
    upcoming.forEach((t) => body.append(taskRow(t, true)));
  }
}

function showTeam() {
  openPanel('團隊', 'team');
  project.team.forEach((m) => {
    const mine = allTasks.filter((t) => t.owner === m.name);
    const open = mine.filter((t) => t.status !== 'done');
    const r = el('div', 'row'), a = el('div', 'avatar', m.name.slice(0, 1)), g = el('div', 'grow');
    a.style.background = m.color;
    g.append(el('div', 't', m.name), el('div', 's', `${m.role} · 進行中 ${open.length} / 共 ${mine.length} 項`));
    r.append(a, g);
    if (mine.some((t) => t.status === 'blocked')) r.append(el('span', 'tag blocked', '卡關'));
    body.append(r);
  });
}

/* ---------- encrypted mail digest ---------- */
let digest = null;
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decryptDigest(password) {
  const res = await fetch('data/mail.enc.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('nofile');
  const j = await res.json();
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(j.salt), iterations: j.iter, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(j.iv) }, key, b64(j.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

function showMail() {
  openPanel('每日信件摘要', 'mail');
  if (digest) return renderDigest(0);
  const wrap = el('form', 'lock');
  const input = el('input');
  input.type = 'password';
  input.placeholder = '輸入密碼';
  input.autocomplete = 'current-password';
  const err = el('div', 'err');
  const btn = el('button', '', '解鎖');
  btn.type = 'submit';
  wrap.append(el('div', 'ico', '🔒'), el('div', 'muted', '信件摘要已加密，只在這台裝置上解開，不會上傳密碼。'), input, btn, err);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    if (!input.value) return;
    btn.disabled = true;
    btn.textContent = '解鎖中…';
    err.textContent = '';
    try {
      digest = await decryptDigest(input.value);
      renderDigest(0);
    } catch (ex) {
      err.textContent = ex.message === 'nofile' ? '還沒有信件摘要檔。' : '密碼不正確。';
      btn.disabled = false;
      btn.textContent = '解鎖';
    }
  };
  body.append(wrap);
  if (matchMedia('(min-width: 721px)').matches) input.focus();
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
    top.append(el('div', 'subj', m.subject), el('span', 'tag ' + (m.priority ?? 'low'), PRIORITY[m.priority] ?? PRIORITY.low));
    box.append(top, el('div', 'from', m.from), el('div', 'gist', m.gist));
    if (m.action) box.append(el('div', 'act', '→ ' + m.action));
    body.append(box);
  });
  const lock = el('button', 'btn ghost', '重新上鎖');
  lock.onclick = () => { digest = null; showMail(); };
  body.append(lock);
}
