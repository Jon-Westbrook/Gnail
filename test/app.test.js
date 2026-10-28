import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLearnedSenderPreferences, classifyThreads } from '../lib/classifier.js';
import { normalizeThread } from '../lib/gog.js';
import { labelFilterSuggestions, senderDisplayName, senderEmail } from '../lib/learning.js';
import { defaultDataDirectory } from '../lib/paths.js';

let serverProcess;
let baseUrl;
let dataDir;
let mockGogPath;
let mockGogLog;
let mockCodexPath;
const execFileAsync = promisify(execFile);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json();
  return { response, body };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'g-nail-test-'));
  mockGogPath = join(dataDir, 'mock-gog');
  mockGogLog = join(dataDir, 'gog-calls.log');
  mockCodexPath = join(dataDir, 'mock-codex');
  await writeFile(mockGogPath, await readFile(new URL('./mock-gog.sh', import.meta.url)), { mode: 0o700 });
  await chmod(mockGogPath, 0o700);
  await writeFile(mockCodexPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli test"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi\nif [ "$1" = "exec" ]; then\n  if [ -n "$CODEX_MOCK_FAIL" ]; then cat >&2; exit 1; fi\n  previous=""\n  for argument in "$@"; do\n    if [ "$previous" = "--output-last-message" ]; then output="$argument"; break; fi\n    previous="$argument"\n  done\n  if [ -n "$CODEX_MOCK_RESULT" ]; then printf %s "$CODEX_MOCK_RESULT" > "$output"; else printf %s "{\"classifications\":[]}" > "$output"; fi\n  exit 0\nfi\nexit 1\n', { mode: 0o700 });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), GNAIL_DATA_DIR: dataDir, GOG_BIN: mockGogPath, GOG_ACCOUNT: 'test@example.test', GOG_CALL_LOG: mockGogLog, CODEX_BIN: mockCodexPath, GOG_MOCK_ACTION_DELAY: '0.2' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(baseUrl)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

after(async () => {
  serverProcess?.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true });
});

test('serves the local-only app without an access-code challenge', async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const state = await call('/api/state');
  assert.equal(state.body.classifierProvider, 'codex');
  assert.equal(state.body.classifierInstalled, true);
  assert.equal(state.body.classifierConfigured, true);
  const html = await page.text();
  assert.match(html, /id="auth-form"/);
  assert.equal(state.response.status, 200);
  assert.equal(state.body.demo, true);
  assert.equal(state.body.inbox.length, 20);
  assert.equal(state.body.queue.length, 0);
  assert.match(html, /LET'S GET GNAIL CONNECTED/);
  assert.match(html, /codex login/);
  assert.match(html, /gog auth add you@example\.com --services gmail/);
  assert.match(html, /machine running GNAIL—not necessarily the computer showing this page/);
  assert.match(html, /gog auth credentials set \/path\/to\/client_secret\.json/);
  assert.match(html, /Step-by-step setup, including servers/);
  assert.match(html, /codex login --device-auth/);
});

test('mounts behind a base path and protects API routes with an access code', async () => {
  const protectedDataDir = await mkdtemp(join(tmpdir(), 'g-nail-protected-test-'));
  const port = await freePort();
  const protectedUrl = `http://127.0.0.1:${port}`;
  const protectedServer = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), BASE_PATH: '/gnail', GNAIL_ACCESS_CODE: 'test-access-code-long', GNAIL_DATA_DIR: protectedDataDir, GOG_BIN: mockGogPath, GOG_CALL_LOG: mockGogLog, CODEX_BIN: mockCodexPath },
    stdio: 'ignore',
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`${protectedUrl}/gnail/`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'protected test server should start');
    assert.equal((await fetch(`${protectedUrl}/`)).status, 404);
    assert.equal((await fetch(`${protectedUrl}/gnail/api/state`)).status, 401);

    const rejected = await fetch(`${protectedUrl}/gnail/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: 'wrong' }),
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${protectedUrl}/gnail/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: 'test-access-code-long' }),
    });
    assert.equal(accepted.status, 200);
    const cookie = accepted.headers.get('set-cookie').split(';')[0];
    assert.match(accepted.headers.get('set-cookie'), /Path=\/gnail\//);
    const state = await fetch(`${protectedUrl}/gnail/api/state`, { headers: { Cookie: cookie } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).demo, true);
  } finally {
    protectedServer.kill('SIGTERM');
    await rm(protectedDataDir, { recursive: true, force: true });
  }
});

test('stages archive without changing inbox, then executes it', async () => {
  const stage = await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-007'], action: 'archive' }) });
  assert.equal(stage.response.status, 200);
  assert.equal(stage.body.queue.length, 1);
  assert.equal(stage.body.queue[0].subject, 'Receipt for your recent purchase');
  const beforeExecution = await call('/api/state');
  assert(beforeExecution.body.inbox.some(message => message.id === 'A-007'));

  const executed = await call('/api/execute', { method: 'POST', body: '{}' });
  assert.equal(executed.response.status, 200);
  assert.equal(executed.body.completed, 1);
  assert(!executed.body.inbox.some(message => message.id === 'A-007'));
  assert.equal(executed.body.queue.length, 0);
});

test('stages one label operation for multiple selected messages without executing it', async () => {
  const staged = await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-008', 'A-009'], action: 'label', label: 'Financial Newsletter' }) });
  assert.equal(staged.response.status, 200);
  assert.equal(staged.body.queue.length, 2);
  assert(staged.body.queue.every(item => item.action === 'label' && item.label === 'Financial Newsletter'));
  const state = await call('/api/state');
  assert(state.body.inbox.some(message => message.id === 'A-008'));
  assert(state.body.inbox.some(message => message.id === 'A-009'));
  await call('/api/queue', { method: 'DELETE' });
  assert.equal((await call('/api/state')).body.queue.length, 0);
});

test('keeps unsubscribe as a manual action instead of reporting a failure', async () => {
  await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-016'], action: 'unsubscribe' }) });
  const executed = await call('/api/execute', { method: 'POST', body: '{}' });
  assert.equal(executed.response.status, 200);
  assert.deepEqual(executed.body.failed, []);
  assert.equal(executed.body.manual.length, 1);
  assert.equal(executed.body.queue[0].manualPending, true);
  assert(executed.body.inbox.some(message => message.id === 'A-016'));
  const done = await call(`/api/queue/${executed.body.queue[0].id}/done`, { method: 'POST', body: '{}' });
  assert.equal(done.body.queue.length, 0);
});

test('deduplicates repeated IDs and reports when a staged action is replaced', async () => {
  await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-010'], action: 'archive' }) });
  const updated = await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-010', 'A-010'], action: 'trash' }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.updatedCount, 1);
  assert.equal(updated.body.staged.length, 1);
  assert.equal(updated.body.staged[0].replacedAction, 'archive');
  assert.equal(updated.body.queue.length, 1);
  assert.equal(updated.body.queue[0].action, 'trash');
  await call('/api/queue', { method: 'DELETE' });
});

test('records recategorization feedback only on execution', async () => {
  await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-013'], action: 'move', category: 'NEEDS EYES' }) });
  const waiting = await call('/api/state');
  assert.equal(waiting.body.stats.corrected, 0);
  const executed = await call('/api/execute', { method: 'POST', body: '{}' });
  assert(!executed.body.inbox.some(message => message.id === 'A-013'));
  const state = await call('/api/state');
  assert.equal(state.body.stats.corrected, 1);
  const history = await readFile(join(dataDir, 'history.jsonl'), 'utf8');
  assert.match(history, /"type":"correction"/);
  assert.match(history, /"type":"needs_eyes_flagged"/);
});

test('Needs Eyes marks locally, removes the active item, and makes no Gog mail action', async () => {
  const inboxPath = join(dataDir, 'inbox.jsonl');
  const originalInbox = await readFile(inboxPath, 'utf8');
  const historyPath = join(dataDir, 'history.jsonl');
  const originalHistory = await readFile(historyPath, 'utf8');
  await writeFile(historyPath, originalHistory + [
    { type: 'executed', action: 'label', messageId: 'prior-label-1', sender: 'Newsletter <news@example.test>', label: 'Archive Label' },
    { type: 'executed', action: 'label', messageId: 'prior-label-2', sender: 'Newsletter <news@example.test>', label: 'Archive Label' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const reviewMessage = { id: 'review-thread-1', threadId: 'review-thread-1', messageId: 'review-message-1', subject: 'Review locally', from: 'Sender <sender@example.test>', senderName: 'Sender', category: 'ARCHIVABLE', labels: [], demo: false };
  await writeFile(inboxPath, `${JSON.stringify(reviewMessage)}\n`);
  await writeFile(mockGogLog, '');
  const staged = await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: [reviewMessage.id], action: 'needs_eyes' }) });
  assert.equal(staged.body.queue[0].action, 'needs_eyes');
  const executed = await call('/api/execute', { method: 'POST', body: '{}' });
  assert.equal(executed.body.completed, 1);
  assert.equal(executed.body.inbox.length, 0);
  assert.equal((await readFile(mockGogLog, 'utf8')).trim(), '');
  const refreshed = await call('/api/state');
  assert(!refreshed.body.inbox.some(message => message.id === 'review-thread-1'));
  const history = await readFile(historyPath, 'utf8');
  assert.match(history, /"inboxId":"review-thread-1"/);
  await writeFile(inboxPath, originalInbox);
  await writeFile(historyPath, originalHistory);
});

test('Archive and Trash outcomes are learned as category corrections', async () => {
  await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-018'], action: 'archive' }) });
  await call('/api/execute', { method: 'POST', body: '{}' });
  await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: ['A-005'], action: 'trash' }) });
  await call('/api/execute', { method: 'POST', body: '{}' });
  const events = (await readFile(join(dataDir, 'history.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert(events.some(event => event.type === 'correction' && event.from === 'DELETABLE' && event.to === 'ARCHIVABLE'));
  assert(events.some(event => event.type === 'correction' && event.from === 'NEEDS EYES' && event.to === 'DELETABLE'));
});

test('queue execution reports progress while independent mocked actions run concurrently', async () => {
  const inboxPath = join(dataDir, 'inbox.jsonl');
  const originalInbox = await readFile(inboxPath, 'utf8');
  const messages = Array.from({ length: 6 }, (_, index) => ({
    id: `thread-concurrent-${index}`, threadId: `thread-concurrent-${index}`, messageId: `message-concurrent-${index}`,
    subject: `Synthetic archive test ${index}`, from: 'Mock Sender <mock@example.test>', category: 'ARCHIVABLE', labels: [], demo: false,
  }));
  await writeFile(inboxPath, messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const staged = await call('/api/stage', { method: 'POST', body: JSON.stringify({ ids: messages.map(message => message.id), action: 'archive' }) });
  assert.equal(staged.body.queue.length, messages.length);

  const executionPromise = call('/api/execute', { method: 'POST', body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 60));
  const progress = await call('/api/progress');
  assert.equal(progress.body.active, true);
  assert.equal(progress.body.kind, 'execute');
  assert.equal(progress.body.total, messages.length);

  const executed = await executionPromise;
  assert.equal(executed.response.status, 200);
  assert.equal(executed.body.completed, messages.length);
  assert.equal(executed.body.queue.length, 0);
  await writeFile(inboxPath, originalInbox);
});

test('two consistent sender corrections teach the next batch', () => {
  const nextBatch = [{ id: 'new-1', from: 'Deals@example.test', category: 'NEEDS EYES' }];
  const corrections = [
    { sender: 'deals@example.test', to: 'DELETABLE' },
    { sender: 'Deals@example.test', to: 'DELETABLE' },
  ];
  const learned = applyLearnedSenderPreferences(nextBatch, new Map([['new-1', 'NEEDS EYES']]), corrections);
  assert.equal(learned[0].category, 'DELETABLE');
  const cautious = applyLearnedSenderPreferences(nextBatch, new Map([['new-1', 'NEEDS EYES']]), corrections.slice(0, 1));
  assert.equal(cautious[0].category, 'NEEDS EYES');
});

test('classifies through an ephemeral Codex CLI call', async () => {
  const previousBin = process.env.CODEX_BIN;
  const previousResult = process.env.CODEX_MOCK_RESULT;
  process.env.CODEX_BIN = mockCodexPath;
  process.env.CODEX_MOCK_RESULT = JSON.stringify({ classifications: [{ id: 'thread-1', category: 'ARCHIVABLE' }] });
  try {
    const classified = await classifyThreads([{ id: 'thread-1', from: 'Sender <sender@example.test>', subject: 'Your receipt' }]);
    assert.equal(classified[0].category, 'ARCHIVABLE');
  } finally {
    if (previousBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previousBin;
    if (previousResult === undefined) delete process.env.CODEX_MOCK_RESULT; else process.env.CODEX_MOCK_RESULT = previousResult;
  }
});

test('does not expose email prompt contents when Codex fails', async () => {
  const previousBin = process.env.CODEX_BIN;
  const previousFail = process.env.CODEX_MOCK_FAIL;
  process.env.CODEX_BIN = mockCodexPath;
  process.env.CODEX_MOCK_FAIL = '1';
  try {
    await assert.rejects(
      classifyThreads([{ id: 'private-thread', from: 'Private Sender', subject: 'Sensitive subject' }]),
      error => /Codex classification failed/.test(error.message) && !/Sensitive subject/.test(error.message),
    );
  } finally {
    if (previousBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previousBin;
    if (previousFail === undefined) delete process.env.CODEX_MOCK_FAIL; else process.env.CODEX_MOCK_FAIL = previousFail;
  }
});

test('normalizes Gog search rows for the subject-only inbox list', () => {
  const message = normalizeThread({
    id: 'thread-42',
    threadId: 'thread-42',
    from: 'Alerts <alerts@example.test>',
    subject: 'Your account statement is ready',
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  });
  assert.equal(message.id, 'thread-42');
  assert.equal(message.subject, 'Your account statement is ready');
  assert.deepEqual(message.labels, ['INBOX', 'CATEGORY_UPDATES']);
  assert.equal(message.demo, false);
});

test('does not bake a personal Gmail address into the default Gog configuration', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', "import { GMAIL_ACCOUNT } from './lib/gog.js'; process.stdout.write(GMAIL_ACCOUNT)"] , {
    cwd: new URL('..', import.meta.url),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GOG_ACCOUNT')),
  });
  assert.equal(stdout, '');
});

test('accepts the Gog default account when GOG_ACCOUNT is unset', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', "import { gogConnected } from './lib/gog.js'; process.stdout.write(String(await gogConnected()))"], {
    cwd: new URL('..', import.meta.url),
    env: Object.fromEntries(Object.entries({ ...process.env, GOG_BIN: mockGogPath }).filter(([key]) => key !== 'GOG_ACCOUNT')),
  });
  assert.equal(stdout, 'true');
});

test('does not report Gmail connected when the stored token is rejected', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', "import { gogConnected } from './lib/gog.js'; process.stdout.write(String(await gogConnected()))"], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GOG_BIN: mockGogPath, GOG_ACCOUNT: 'test@example.test', GOG_MOCK_AUTH_ERROR: '1' },
  });
  assert.equal(stdout, 'false');
});

test('stores local state in platform-standard application data directories', () => {
  assert.equal(defaultDataDirectory({ platform: 'darwin', home: '/home/test', env: {}, exists: () => false }), '/home/test/Library/Application Support/GNAIL');
  assert.equal(defaultDataDirectory({ platform: 'darwin', home: '/home/test', env: {}, exists: path => path.endsWith('G-NAIL') }), '/home/test/Library/Application Support/G-NAIL');
  assert.equal(defaultDataDirectory({ platform: 'linux', home: '/home/test', env: {} }), '/home/test/.local/share/gnail');
  assert.equal(defaultDataDirectory({ platform: 'linux', home: '/home/test', env: { XDG_DATA_HOME: '/data' } }), '/data/gnail');
});

test('suggests a sender filter after two distinct label choices, but not before', () => {
  const history = [
    { type: 'executed', action: 'label', messageId: 'msg-1', sender: 'Financial Desk <news@example.test>', senderName: 'Financial Desk', label: 'Financial Newsletter' },
    { type: 'executed', action: 'label', messageId: 'msg-2', sender: 'Financial Desk <news@example.test>', senderName: 'Financial Desk', label: 'Financial Newsletter' },
  ];
  const suggestions = labelFilterSuggestions(history, [], [], [{ id: 'Label_42', name: 'Financial Newsletter' }]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].senderName, 'Financial Desk');
  assert.equal(suggestions[0].count, 2);
  assert.equal(labelFilterSuggestions(history.slice(0, 1), [], [], [{ id: 'Label_42', name: 'Financial Newsletter' }]).length, 0);
  assert.equal(labelFilterSuggestions(history, [], [{ criteria: { from: 'news@example.test' }, action: { addLabelIds: ['Label_42'] } }], [{ id: 'Label_42', name: 'Financial Newsletter' }]).length, 0);
});

test('extracts a display name and sender address without confusing them', () => {
  assert.equal(senderDisplayName('Cobble Hill Ballet <ballet@example.test>'), 'Cobble Hill Ballet');
  assert.equal(senderEmail('Cobble Hill Ballet <ballet@example.test>'), 'ballet@example.test');
});

test('the app has a password-manager-compatible access-code field and no stale-session reload', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /type="password" autocomplete="current-password"/);
  assert.doesNotMatch(html, /localStorage\.getItem\('gnail-token'\)/);
  assert.doesNotMatch(html, /location\.reload\(\)/);
});

test('README explains the OAuth client and headless-server authorization flow', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /First-time Gmail setup/);
  assert.match(readme, /Desktop app/);
  assert.match(readme, /codex login --device-auth/);
  assert.match(readme, /--remote --step 1/);
  assert.match(readme, /--remote --step 2 --auth-url/);
  assert.match(readme, /use \*\*FETCH 50\*\* only when you are ready/);
});

test('shows the requested caption and an accessible activity spinner for fetch and execution', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Nail those gmails to the wall!/);
  assert.match(html, /id="processing-overlay" class="processing-overlay hidden" role="dialog" aria-modal="true"/);
  assert.match(html, /id="processing-rail" class="processing-rail"/);
  assert.match(html, /id="processing-error-code"/);
  assert.match(html, /ERROR CODE \/\//);
  assert.match(html, /setActivity\('FETCHING \+ CLASSIFYING…'/);
  assert.match(html, /setActivity\('EXECUTING QUEUE…'/);
  assert.match(html, /@keyframes gnail-spin/);
  assert.match(html, /@keyframes gnail-rail/);
});

test('Execute Queue uses the progress modal without a second confirmation dialog', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const executeStart = html.indexOf("document.getElementById('execute-queue').addEventListener");
  const executeEnd = html.indexOf("document.getElementById('processing-close').addEventListener", executeStart);
  assert(executeStart >= 0 && executeEnd > executeStart);
  assert.doesNotMatch(html.slice(executeStart, executeEnd), /confirm\(/);
  assert.match(html.slice(executeStart, executeEnd), /setActivity\('EXECUTING QUEUE…'/);
});
