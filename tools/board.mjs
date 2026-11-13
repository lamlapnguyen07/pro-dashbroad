// Board data: data/board.enc.json (public, encrypted) <-> private/board.json (local, plain).
//   node tools/board.mjs decrypt   # after `git pull`, to read or edit the board locally
//   node tools/board.mjs encrypt   # after editing private/board.json, before committing
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readPassword, readText, encryptJSON, decryptJSON } from './lib.mjs';

const plain = join(root, 'private', 'board.json');
const enc = join(root, 'data', 'board.enc.json');
const cmd = process.argv[2];

if (cmd === 'decrypt') {
  const data = await decryptJSON(JSON.parse(readText(enc)), readPassword());
  writeFileSync(plain, JSON.stringify(data, null, 2));
  console.log(`Decrypted ${data.people?.length ?? 0} people, ${data.tasks?.length ?? 0} tasks -> private/board.json`);
} else if (cmd === 'encrypt') {
  const data = JSON.parse(readText(plain));
  writeFileSync(enc, JSON.stringify(await encryptJSON(data, readPassword())));
  console.log(`Encrypted ${data.people?.length ?? 0} people, ${data.tasks?.length ?? 0} tasks -> data/board.enc.json`);
} else {
  console.error('Usage: node tools/board.mjs decrypt|encrypt');
  process.exit(1);
}
