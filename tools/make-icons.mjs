// Draws the app icon (a small isometric city) and writes it as SVG and PNG:
//   node tools/make-icons.mjs
// Output: icons/icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const K = 0.577; // tan(30deg): isometric slope

// ---- scene in a 512x512 design space ----
function isoBox(cx, cy, a, h, top, leftC, rightC) {
  const t = cy - h, d = a * K;
  return [
    { poly: [[cx - a, t], [cx, t + d], [cx, cy + d], [cx - a, cy]], fill: leftC },
    { poly: [[cx, t + d], [cx + a, t], [cx + a, cy], [cx, cy + d]], fill: rightC },
    { poly: [[cx, t - d], [cx + a, t], [cx, t + d], [cx - a, t]], fill: top },
  ];
}
// Window strips on a building's two visible faces.
function windows(cx, cy, a, h, color, rows) {
  const out = [], d = a * K;
  for (let i = 0; i < rows; i++) {
    const y = cy - h + 26 + i * ((h - 44) / Math.max(1, rows - 1 || 1));
    const s = 0.22, e = 0.82, th = 9;
    const L = (u, yy) => [cx - a + a * u, yy + d * u];
    const R = (u, yy) => [cx + a * u, yy + d - d * u];
    out.push({ poly: [L(s, y), L(e, y), L(e, y + th), L(s, y + th)], fill: color });
    out.push({ poly: [R(1 - e, y), R(1 - s, y), R(1 - s, y + th), R(1 - e, y + th)], fill: color });
  }
  return out;
}

function scene() {
  const s = [];
  const gx = 256, gy = 336, hw = 176, hh = hw * K, th = 18;
  // ground slab
  s.push({ poly: [[gx - hw, gy], [gx, gy + hh], [gx, gy + hh + th], [gx - hw, gy + th]], fill: '#aab6c6' });
  s.push({ poly: [[gx, gy + hh], [gx + hw, gy], [gx + hw, gy + th], [gx, gy + hh + th]], fill: '#c3ccd8' });
  s.push({ poly: [[gx, gy - hh], [gx + hw, gy], [gx, gy + hh], [gx - hw, gy]], fill: '#eef2f7' });
  // street
  const road = (u0, u1) => { // band across the diamond, parallel to the left edge
    const P = (u, v) => [gx - hw + hw * u + hw * v, gy - hh * u + hh * v];
    return { poly: [P(u0, 0), P(u1, 0), P(u1, 1), P(u0, 1)], fill: '#d3dae4' };
  };
  s.push(road(0.30, 0.37));

  // back: green member building
  s.push(...isoBox(318, 296, 34, 64, '#a6e6c2', '#4caf7d', '#3a9466'));
  s.push(...windows(318, 296, 34, 64, '#d9f4e5', 1));
  // middle: blue HQ with flag
  s.push(...isoBox(196, 322, 46, 156, '#9fbfff', '#5b8def', '#4472d4'));
  s.push(...windows(196, 322, 46, 156, '#cfe0ff', 4));
  s.push({ poly: [[194, 166 - 50], [198, 166 - 50], [198, 168], [194, 168]], fill: '#3a4660' });
  s.push({ poly: [[198, 118], [238, 128], [198, 140]], fill: '#ffc93c' });
  // front: orange Claude building with a glowing light
  s.push(...isoBox(302, 366, 40, 88, '#ffc3a1', '#e8875c', '#cc6a40'));
  s.push(...windows(302, 366, 40, 88, '#ffe2d1', 2));
  s.push({ poly: [[300, 196], [304, 196], [304, 280], [300, 280]], fill: '#3a4660' });
  s.push({ circle: [302, 188, 13], fill: '#ffd27a' });
  s.push({ circle: [298, 184, 4], fill: '#fff4d6' });
  // task crates
  s.push(...isoBox(222, 398, 13, 24, '#9fe0bb', '#4caf7d', '#3a9466'));
  s.push(...isoBox(250, 414, 13, 24, '#ffd58f', '#f2a93b', '#d48d22'));
  s.push(...isoBox(376, 352, 13, 24, '#9fe0bb', '#4caf7d', '#3a9466'));
  // sparkle
  const st = (x, y, r) => ({ poly: [[x, y - r], [x + r * 0.28, y - r * 0.28], [x + r, y], [x + r * 0.28, y + r * 0.28], [x, y + r], [x - r * 0.28, y + r * 0.28], [x - r, y], [x - r * 0.28, y - r * 0.28]], fill: '#ffe08a' });
  s.push(st(400, 130, 22), st(432, 186, 11));
  return s;
}

const BG = { top: '#33456b', bottom: '#1a2236' };

// Rounded = transparent corners (browser / Android "any"); full = square fill (iOS, maskable).
function shapesFor(kind) {
  const scale = kind === 'maskable' ? 0.78 : kind === 'apple' ? 0.9 : 0.94;
  return { scale, shapes: scene(), radius: kind === 'rounded' ? 112 : 0 };
}

// ---- SVG ----
function svg(kind) {
  const { scale, shapes, radius } = shapesFor(kind);
  const off = (512 - 512 * scale) / 2;
  const body = shapes.map((sh) => {
    if (sh.poly) return `<polygon points="${sh.poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="${sh.fill}"/>`;
    const [x, y, r] = sh.circle;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${sh.fill}"${sh.alpha ? ` opacity="${sh.alpha}"` : ''}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG.top}"/><stop offset="1" stop-color="${BG.bottom}"/></linearGradient></defs><rect width="512" height="512" rx="${radius}" fill="url(#bg)"/><g transform="translate(${off} ${off}) scale(${scale})">${body}</g></svg>\n`;
}

// ---- PNG rasterizer (4x4 supersampling) ----
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRounded(x, y, r) {
  if (r <= 0) return x >= 0 && x <= 512 && y >= 0 && y <= 512;
  const cx = Math.min(Math.max(x, r), 512 - r), cy = Math.min(Math.max(y, r), 512 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function raster(kind, size) {
  const { scale, shapes, radius } = shapesFor(kind);
  const off = (512 - 512 * scale) / 2;
  const prepared = shapes.map((sh) => {
    const pts = sh.poly ? sh.poly : null;
    const [x, y, r] = sh.circle || [];
    const bb = pts ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] : [x - r, y - r, x + r, y + r];
    return { ...sh, rgb: hex(sh.fill), a: sh.alpha ?? 1, bb };
  });
  const top = hex(BG.top), bot = hex(BG.bottom);
  const N = 4, out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const X = ((px + (sx + 0.5) / N) / size) * 512, Y = ((py + (sy + 0.5) / N) / size) * 512;
        if (!inRounded(X, Y, radius)) continue;
        const f = Y / 512;
        let c = [top[0] + (bot[0] - top[0]) * f, top[1] + (bot[1] - top[1]) * f, top[2] + (bot[2] - top[2]) * f];
        const lx = (X - off) / scale, ly = (Y - off) / scale;
        for (const sh of prepared) {
          if (lx < sh.bb[0] || lx > sh.bb[2] || ly < sh.bb[1] || ly > sh.bb[3]) continue;
          const hit = sh.poly ? inPoly(lx, ly, sh.poly) : (lx - sh.circle[0]) ** 2 + (ly - sh.circle[1]) ** 2 <= sh.circle[2] ** 2;
          if (hit) c = c.map((v, k) => v + (sh.rgb[k] - v) * sh.a);
        }
        r += c[0]; g += c[1]; b += c[2]; a += 255;
      }
      const n = N * N, i = (py * size + px) * 4, cov = a / n;
      // Store straight (non-premultiplied) colour: average over covered samples only.
      const k = a ? 255 / a : 0;
      out[i] = Math.round(r * k); out[i + 1] = Math.round(g * k); out[i + 2] = Math.round(b * k); out[i + 3] = Math.round(cov);
    }
  }
  return png(size, out);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const dir = join(root, 'icons');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'icon.svg'), svg('rounded'));
writeFileSync(join(dir, 'icon-192.png'), raster('rounded', 192));
writeFileSync(join(dir, 'icon-512.png'), raster('rounded', 512));
writeFileSync(join(dir, 'icon-maskable-512.png'), raster('maskable', 512));
writeFileSync(join(dir, 'apple-touch-icon.png'), raster('apple', 180));
console.log('Wrote icons/: icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png');
