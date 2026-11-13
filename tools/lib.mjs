// Shared helpers: password lookup and AES-256-GCM / PBKDF2-SHA256 encryption.
// The browser (app.js) uses the same format: { v, iter, salt, iv, ct } with base64 fields.
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ITER = 600000;

const stripBom = (s) => s.replace(/^﻿/, '');
export const readText = (path) => stripBom(readFileSync(path, 'utf8'));

// Password comes from the DIGEST_PASSWORD env var, or from private/password.txt.
export function readPassword() {
  const file = join(root, 'private', 'password.txt');
  const pw = process.env.DIGEST_PASSWORD || (existsSync(file) ? readText(file).trim() : '');
  if (!pw) {
    console.error('No password: set DIGEST_PASSWORD or create private/password.txt');
    process.exit(1);
  }
  return pw;
}

const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(password, salt, iter, usage) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export async function encryptJSON(obj, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITER, 'encrypt');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decryptJSON(blob, password) {
  const key = await deriveKey(password, unb64(blob.salt), blob.iter, 'decrypt');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    console.error('Could not decrypt: wrong password or damaged file.');
    process.exit(1);
  }
}
