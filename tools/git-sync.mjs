// Fixed git steps for the scheduled tasks, so no run has to improvise git commands.
//   node tools/git-sync.mjs pull
//   node tools/git-sync.mjs push "<commit message>" <file> [<file> ...]
// Prints one line: OK ..., NOTHING ..., or FAIL <reason> (exit code 1 on FAIL).
// push only ever stages the files it is given, and refuses anything under private/.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { root } from './lib.mjs';

const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find((g) => g === 'git' || existsSync(g));
const git = (...args) => execFileSync(GIT, ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' } }).trim();
const fail = (why) => { console.log(`FAIL ${why}`); process.exit(1); };
const errText = (e) => String(e.stderr || e.message || e).split('\n').filter(Boolean).slice(-2).join(' ');

function pull() {
  try { git('fetch', 'origin', 'main'); } catch (e) { fail(`fetch: ${errText(e)}`); }
  try {
    git('rebase', '--autostash', 'origin/main');
  } catch (e) {
    try { git('rebase', '--abort'); } catch { /* nothing to abort */ }
    fail(`rebase: ${errText(e)}`);
  }
}

const [cmd, message, ...files] = process.argv.slice(2);
if (cmd === 'pull') {
  pull();
  console.log(`OK at ${git('log', '-1', '--format=%h %s')}`);
} else if (cmd === 'push') {
  if (!message || !files.length) fail('usage: push "<message>" <file>...');
  if (files.some((f) => f.replace(/\\/g, '/').startsWith('private'))) fail('refusing to commit private/');
  try { git('restore', '--staged', '.'); } catch { /* nothing staged */ }
  git('add', '--', ...files);
  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (!staged.length) { console.log('NOTHING no changes in those files'); process.exit(0); }
  const extra = staged.filter((f) => !files.map((x) => x.replace(/\\/g, '/')).includes(f));
  if (extra.length) { git('restore', '--staged', '.'); fail(`unexpected staged files: ${extra.join(', ')}`); }
  git('commit', '-q', '-m', message);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      git('push', '-q', 'origin', 'HEAD:main');
      console.log(`OK pushed ${git('log', '-1', '--format=%h')} (${staged.join(', ')})`);
      process.exit(0);
    } catch (e) {
      if (attempt === 1) fail(`push: ${errText(e)}`);
      pull(); // someone (usually the web page) pushed first: replay on top and try again
    }
  }
} else {
  fail('usage: pull | push "<message>" <file>...');
}
