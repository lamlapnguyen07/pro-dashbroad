// Encrypts private/<name>.json -> data/<name>.enc.json with the board password.
//   node tools/seal.mjs calendar   # today's and tomorrow's meetings
//   node tools/seal.mjs reports    # weekly reports
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readPassword, readText, encryptJSON } from './lib.mjs';

const ALLOWED = ['calendar', 'reports'];
const name = process.argv[2];
if (!ALLOWED.includes(name)) {
  console.error(`Usage: node tools/seal.mjs ${ALLOWED.join('|')}`);
  process.exit(1);
}
const data = JSON.parse(readText(join(root, 'private', `${name}.json`)));
writeFileSync(join(root, 'data', `${name}.enc.json`), JSON.stringify(await encryptJSON(data, readPassword())));
console.log(`Encrypted private/${name}.json -> data/${name}.enc.json`);
