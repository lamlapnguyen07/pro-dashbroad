// Encrypts private/mail-digest.json -> data/mail.enc.json (AES-256-GCM, PBKDF2-SHA256).
// Password comes from the DIGEST_PASSWORD env var, or from private/password.txt.
// Nothing under private/ is ever committed (see .gitignore).
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'private', 'mail-digest.json');
const pwFile = join(root, 'private', 'password.txt');
const out = join(root, 'data', 'mail.enc.json');
const KEEP_DAYS = 7;
const ITER = 600000;

const password = process.env.DIGEST_PASSWORD || (existsSync(pwFile) ? readFileSync(pwFile, 'utf8').trim() : '');
if (!password) {
  console.error('No password: set DIGEST_PASSWORD or create private/password.txt');
  process.exit(1);
}
if (password.length < 12) console.warn('Warning: password is shorter than 12 characters; the file is public, use a long passphrase.');

const digest = JSON.parse(readFileSync(src, 'utf8'));
digest.days = (digest.days ?? []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);
writeFileSync(src, JSON.stringify(digest, null, 2));

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(digest))));
const b64 = (u) => Buffer.from(u).toString('base64');
writeFileSync(out, JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
console.log(`Encrypted ${digest.days.length} day(s) -> data/mail.enc.json`);
