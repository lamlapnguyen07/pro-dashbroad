// Encrypts private/mail-digest.json -> data/mail.enc.json, keeping the latest 7 days.
// Nothing under private/ is ever committed (see .gitignore).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readPassword, readText, encryptJSON } from './lib.mjs';

const src = join(root, 'private', 'mail-digest.json');
const out = join(root, 'data', 'mail.enc.json');
const KEEP_DAYS = 7;

const password = readPassword();
if (password.length < 12) console.warn('Warning: password is shorter than 12 characters; the file is public, use a long passphrase.');

const digest = JSON.parse(readText(src));
digest.days = (digest.days ?? []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);
writeFileSync(src, JSON.stringify(digest, null, 2));
writeFileSync(out, JSON.stringify(await encryptJSON(digest, password)));
console.log(`Encrypted ${digest.days.length} day(s) -> data/mail.enc.json`);
