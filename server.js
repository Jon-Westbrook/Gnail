import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGogAction, captureInboxSnapshot, createGmailFilter, gogConnected, gogCredentialsConfigured, listGmailFilters, listGmailLabelRecords, listGmailLabels } from './lib/gog.js';
import { classifyThreads, hermesStatus } from './lib/classifier.js';
import { labelFilterSuggestions, senderDisplayName, senderEmail } from './lib/learning.js';

const app = express();
const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3457);
const host = '127.0.0.1';
const dataDir = process.env.GNAIL_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'G-NAIL');
const inboxPath = join(dataDir, 'inbox.jsonl');
const queuePath = join(dataDir, 'queue.jsonl');
const historyPath = join(dataDir, 'history.jsonl');
const gmailStatePath = join(dataDir, 'gmail-state.json');
const categories = ['NEEDS EYES', 'ARCHIVABLE', 'DELETABLE'];
const actions = ['keep', 'needs_eyes', 'archive', 'trash', 'unsubscribe', 'move', 'label'];
const demoRows = [
  ['A-001', 'Your appointment is confirmed for Thursday', 'NEEDS EYES', 'North Shore Dental'],
  ['A-002', 'Fwd: School field trip permission form', 'NEEDS EYES', 'Family Contact'],
  ['A-003', 'Following up on our conversation', 'NEEDS EYES', 'Sasha Patel'],
  ['A-004', 'Your interview is scheduled — Product Designer', 'NEEDS EYES', 'NovaGrid Talent'],
  ['A-005', 'Action required: verify your insurance details', 'NEEDS EYES', 'Lighthouse Insurance'],
  ['A-006', 'Updated custody schedule for October', 'NEEDS EYES', 'Family Calendar'],
  ['A-007', 'Receipt for your recent purchase', 'ARCHIVABLE', 'REI'],
  ['A-008', 'Your monthly account statement is ready', 'ARCHIVABLE', 'Vanguard'],
  ['A-009', 'October newsletter: ideas worth keeping', 'ARCHIVABLE', 'The Atlantic'],
  ['A-010', 'Your reservation details', 'ARCHIVABLE', 'Airbnb'],
  ['A-011', 'Your weekly project activity summary', 'ARCHIVABLE', 'GitHub'],
  ['A-012', 'Order shipped: your package is on its way', 'ARCHIVABLE', 'Bookshop.org'],
  ['A-013', 'Flash sale ends tonight — 40% off everything', 'DELETABLE', 'MegaDeal'],
  ['A-014', 'You have 17 new people to follow', 'DELETABLE', 'SocialWorld'],
  ['A-015', 'Daily digest: 6 new articles', 'DELETABLE', 'Research Daily'],
  ['A-016', 'Don’t miss these picks selected for you', 'DELETABLE', 'ShopMore'],
  ['A-017', 'Your weekly product tips', 'DELETABLE', 'CloudNotes'],
  ['A-018', 'Claim your exclusive member reward', 'DELETABLE', 'RewardClub'],
  ['A-019', 'Security alert: new sign-in detected', 'NEEDS EYES', 'Google'],
  ['A-020', 'Payment processed for your electricity bill', 'ARCHIVABLE', 'Pacific Power'],
];

let operationInProgress = false;
let activeOperation = null;
app.use(express.json({ limit: '128kb' }));

function ensureData() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!existsSync(inboxPath)) {
    writeFileSync(inboxPath, demoRows.map(([id, subject, category, from]) => JSON.stringify({
      id, subject, category, from, labels: [], demo: true,
    })).join('\n') + '\n', { mode: 0o600 });
  }
  for (const path of [queuePath, historyPath]) {
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
  }
  if (!existsSync(gmailStatePath)) {
    writeFileSync(gmailStatePath, JSON.stringify({ snapshot: [], offset: 0, connectedAt: null }, null, 2), { mode: 0o600 });
  } else {
    try {
      const state = JSON.parse(readFileSync(gmailStatePath, 'utf8'));
      if (!Array.isArray(state.snapshot)) writeFileSync(gmailStatePath, JSON.stringify({ snapshot: [], offset: 0, connectedAt: state.connectedAt || null }, null, 2), { mode: 0o600 });
    } catch {
      writeFileSync(gmailStatePath, JSON.stringify({ snapshot: [], offset: 0, connectedAt: null }, null, 2), { mode: 0o600 });
    }
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function flaggedNeedsEyesIds(history = readJsonl(historyPath)) {
  const ids = new Set();
  for (const event of history) {
    const explicitFlag = event.type === 'needs_eyes_flagged';
    const oldExplicitFlag = event.type === 'executed'
      && ['keep', 'move'].includes(event.action)
      && event.category === 'NEEDS EYES';
    if (!explicitFlag && !oldExplicitFlag) continue;
    for (const id of [event.inboxId, event.threadId, event.messageId]) if (id) ids.add(String(id));
  }
  return ids;
}

function messageIsFlagged(message, flaggedIds) {
  return [message.id, message.inboxId, message.threadId, message.messageId]
    .filter(Boolean)
    .some(id => flaggedIds.has(String(id)));
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.length ? rows.map((row) => JSON.stringify(row)).join('\n') + '\n' : '', { mode: 0o600 });
}

function logEvent(event) {
  appendFileSync(historyPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}

function getInbox() {
  const flaggedIds = flaggedNeedsEyesIds();
  return readJsonl(inboxPath)
    .filter(message => !messageIsFlagged(message, flaggedIds))
    .map(message => ({ ...message, senderName: message.senderName || senderDisplayName(message.from) }));
}
function getQueue() { return readJsonl(queuePath); }
function readGmailState() { return JSON.parse(readFileSync(gmailStatePath, 'utf8')); }
function writeGmailState(value) { writeFileSync(gmailStatePath, JSON.stringify(value, null, 2), { mode: 0o600 }); }
function labelCachePath() { return join(dataDir, 'gmail-labels.json'); }
function writeLabelCache(labels) { writeFileSync(labelCachePath(), JSON.stringify(labels, null, 2), { mode: 0o600 }); }

async function getFilterSuggestions(history = readJsonl(historyPath), queue = getQueue()) {
  const userLabelEvents = history.filter(event => event.type === 'executed' && event.action === 'label');
  if (userLabelEvents.length < 2) return [];
  let labels = [];
  let filters = [];
  try { labels = await listGmailLabelRecords(); } catch {}
  try { filters = await listGmailFilters(); } catch {}
  return labelFilterSuggestions(history, queue, filters, labels);
}

ensureData();
app.use(express.static(join(here, 'public')));

app.get('/api/progress', (_req, res) => {
  res.json(activeOperation || { active: false });
});

app.get('/api/state', async (_req, res) => {
  const inbox = getInbox();
  const queue = getQueue();
  const history = readJsonl(historyPath);
  const connected = await gogConnected();
  const agentStatus = await hermesStatus();
  let labels = existsSync(labelCachePath()) ? JSON.parse(readFileSync(labelCachePath(), 'utf8')) : [];
  if (connected) {
    try {
      labels = await listGmailLabels();
      writeLabelCache(labels);
    } catch {}
  }
  const filterSuggestions = connected ? await getFilterSuggestions(history, queue) : [];
  res.json({
    inbox,
    queue,
    categories,
    demo: inbox.some(message => message.demo),
    labelNames: labels,
    filterSuggestions,
    gmailConnected: connected,
    gmailConfigured: await gogCredentialsConfigured(),
    agentInstalled: agentStatus.installed,
    agentConfigured: agentStatus.configured,
    stats: {
      staged: queue.length,
      corrected: history.filter((event) => event.type === 'correction').length,
      processed: history.filter((event) => event.type === 'executed').length,
    },
  });
});

app.get('/api/gmail/connect', async (_req, res) => {
  if (await gogConnected()) return res.json({ connected: true });
  const configured = await gogCredentialsConfigured();
  res.status(409).json({ error: configured
    ? 'Gog is ready, but its local Keychain has no Gmail token yet. Import the existing refresh token to continue.'
    : 'Gog is not configured yet. Install gogcli and configure an OAuth client before connecting.' });
});

app.post('/api/gmail/sync', async (_req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Another GNAIL operation is still running' });
  operationInProgress = true;
  activeOperation = { active: true, kind: 'fetch', stage: 'CHECKING LOCAL GOG', completed: 0, total: 0 };
  try {
    if (!await gogConnected()) return res.status(409).json({ error: 'Connect Gmail through the local Gog Keychain before syncing' });
    const gmailState = readGmailState();
    const existingIds = flaggedNeedsEyesIds();
    for (const message of getInbox().filter(message => !message.demo)) {
      for (const id of [message.id, message.inboxId, message.threadId, message.messageId]) if (id) existingIds.add(String(id));
    }
    if (gmailState.offset >= gmailState.snapshot.length) {
      activeOperation.stage = 'SCANNING INBOX THREADS';
      const liveRows = await captureInboxSnapshot();
      gmailState.snapshot = liveRows.filter(message => !messageIsFlagged(message, existingIds));
      gmailState.offset = 0;
    }
    const fetched = gmailState.snapshot.slice(gmailState.offset, gmailState.offset + 50).map(message => ({ ...message, senderName: senderDisplayName(message.from) }));
    activeOperation.stage = `CLASSIFYING ${fetched.length} MESSAGES`;
    activeOperation.total = fetched.length;
    const corrections = readJsonl(historyPath).filter(event => event.type === 'correction');
    const classified = await classifyThreads(fetched, corrections);
    activeOperation.stage = 'SAVING TRIAGE RESULTS';
    activeOperation.completed = classified.length;
    const inbox = getInbox().filter(message => !message.demo);
    const ids = new Set(inbox.map(message => message.id));
    for (const thread of classified) {
      const existingIndex = inbox.findIndex(message => message.id === thread.id);
      if (existingIndex >= 0) inbox[existingIndex] = { ...inbox[existingIndex], ...thread };
      else if (!ids.has(thread.id)) inbox.push(thread);
    }
    writeJsonl(inboxPath, inbox);
    gmailState.offset += fetched.length;
    writeGmailState(gmailState);
    const labels = await listGmailLabels();
    writeLabelCache(labels);
    const hasMore = gmailState.offset < gmailState.snapshot.length;
    logEvent({ type: 'gmail_sync', count: classified.length, hasMore });
    res.json({ count: classified.length, hasMore, inbox, labels, filterSuggestions: await getFilterSuggestions(readJsonl(historyPath), getQueue()) });
  } catch (error) {
    res.status(502).json({ error: `Gmail sync failed: ${error.message}` });
  } finally {
    operationInProgress = false;
    activeOperation = null;
  }
});

app.post('/api/stage', (req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing the queue' });
  const { ids, action: requestedAction, category, label } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Choose at least one message' });
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length > 100) return res.status(400).json({ error: 'Choose no more than 100 messages' });
  const action = requestedAction === 'keep' || (requestedAction === 'move' && category === 'NEEDS EYES') ? 'needs_eyes' : requestedAction;
  if (!actions.includes(action)) return res.status(400).json({ error: 'Unsupported action' });
  if (['keep', 'move'].includes(action) && !categories.includes(category)) return res.status(400).json({ error: 'Choose a valid triage group' });
  if (action === 'label' && (!label || String(label).length > 120)) return res.status(400).json({ error: 'Choose a Gmail label' });

  const inbox = getInbox();
  const queue = getQueue();
  const staged = [];
  let updatedCount = 0;
  const actionCategory = action === 'needs_eyes' ? null : category || null;
  for (const id of uniqueIds) {
    const message = inbox.find((row) => row.id === id);
    if (!message) continue;
    const previous = queue.find(item => (item.inboxId || item.threadId || item.messageId) === id);
    const previousAction = previous?.action;
    const item = { id: previous?.id || randomUUID(), inboxId: id, messageId: message.messageId || id, threadId: message.threadId || id, subject: message.subject, from: message.from, senderName: message.senderName || senderDisplayName(message.from), webUrl: message.webUrl || null, originalCategory: message.category, action, category: actionCategory, label: label || null, stagedAt: new Date().toISOString() };
    const actionChanged = previous && (previousAction !== item.action || previous.category !== item.category || previous.label !== item.label);
    if (previous) Object.assign(previous, item);
    else queue.push(item);
    if (actionChanged) updatedCount += 1;
    staged.push(actionChanged ? { ...item, replacedAction: previousAction } : item);
  }
  writeJsonl(queuePath, queue);
  logEvent({ type: 'staged', count: staged.length, updatedCount, action, category: actionCategory });
  res.json({ staged, updatedCount, queue });
});

app.post('/api/filter-suggestions/stage', async (req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing the queue' });
  const { sender, label } = req.body || {};
  const email = senderEmail(sender);
  const suggestion = (await getFilterSuggestions()).find(item => item.sender === email && item.label === label);
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing the queue' });
  if (!suggestion) return res.status(409).json({ error: 'This sender-label pattern is not ready for a filter yet' });
  const queue = getQueue();
  const item = {
    id: randomUUID(), action: 'create_filter', filterFrom: suggestion.sender,
    senderName: suggestion.senderName, label: suggestion.label,
    subject: `${suggestion.senderName} → ${suggestion.label}`, stagedAt: new Date().toISOString(),
  };
  queue.push(item);
  writeJsonl(queuePath, queue);
  logEvent({ type: 'staged', action: 'create_filter', sender: suggestion.sender, senderName: suggestion.senderName, label: suggestion.label });
  res.json({ item, queue, filterSuggestions: await getFilterSuggestions(readJsonl(historyPath), queue) });
});

app.post('/api/filter-suggestions/dismiss', async (req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing filter suggestions' });
  const { sender, label } = req.body || {};
  const email = senderEmail(sender);
  const suggestion = (await getFilterSuggestions()).find(item => item.sender === email && item.label === label);
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing filter suggestions' });
  if (!suggestion) return res.status(409).json({ error: 'This filter suggestion is no longer available' });
  logEvent({ type: 'filter_dismissed', sender: suggestion.sender, senderName: suggestion.senderName, label: suggestion.label, count: suggestion.count });
  res.json({ filterSuggestions: await getFilterSuggestions() });
});

app.delete('/api/queue/:id', (req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing the queue' });
  const queue = getQueue();
  const next = queue.filter((item) => item.id !== req.params.id);
  if (next.length === queue.length) return res.status(404).json({ error: 'Queue item not found' });
  writeJsonl(queuePath, next);
  logEvent({ type: 'unstaged', queueId: req.params.id });
  res.json({ queue: next });
});

app.post('/api/queue/:id/done', (req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing the queue' });
  const queue = getQueue();
  const item = queue.find(entry => entry.id === req.params.id);
  if (!item || item.action !== 'unsubscribe' || !item.error) return res.status(409).json({ error: 'Only a failed manual unsubscribe can be marked done here' });
  const next = queue.filter(entry => entry.id !== item.id);
  writeJsonl(queuePath, next);
  logEvent({ type: 'executed', messageId: item.messageId, subject: item.subject, action: 'unsubscribe', manual: true });
  res.json({ queue: next });
});

app.delete('/api/queue', (_req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before changing the queue' });
  const count = getQueue().length;
  writeJsonl(queuePath, []);
  logEvent({ type: 'queue_cleared', count });
  res.json({ queue: [] });
});

app.post('/api/execute', async (_req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Another GNAIL operation is still running' });
  const inbox = getInbox();
  const queue = getQueue();
  if (!queue.length) return res.json({ completed: 0, failed: [], inbox, queue: [], demo: inbox.some(message => message.demo) });
  if (queue.some(item => item.action !== 'create_filter' && !inbox.some(message => message.id === (item.inboxId || item.threadId || item.messageId)))) {
    return res.status(409).json({ error: 'The inbox changed since staging. Refresh and review the queue.' });
  }

  operationInProgress = true;
  activeOperation = { active: true, kind: 'execute', stage: 'PREPARING QUEUE', completed: 0, total: queue.length };
  const completed = [];
  const remaining = [];
  const needsLabelSet = queue.some(item => item.action === 'label' && inbox.some(message => message.id === (item.inboxId || item.threadId || item.messageId) && !message.demo));
  let knownLabels = new Set();
  const pendingLabelCreations = new Map();
  let refreshedLabels = false;

  try {
    if (needsLabelSet) {
      activeOperation.stage = 'PREPARING GMAIL LABELS';
      knownLabels = new Set(await listGmailLabels());
    }

    let nextIndex = 0;
    let settled = 0;
    async function processItem(item) {
      const actionName = item.action === 'needs_eyes' || item.action === 'keep' ? 'NEEDS EYES' : item.action.toUpperCase();
      activeOperation.stage = `${actionName} · ${settled + 1}/${queue.length}`;
      try {
        if (item.action === 'create_filter') {
          const filterResult = await createGmailFilter(item.filterFrom, item.label);
          logEvent({ type: 'filter_created', sender: item.filterFrom, senderName: item.senderName, label: item.label, alreadyExists: filterResult.alreadyExists });
          completed.push(item.id);
          return;
        }

        const identity = item.inboxId || item.threadId || item.messageId;
        const index = inbox.findIndex(message => message.id === identity);
        const message = inbox[index];
        if (!message) throw new Error('Message is no longer in the local batch');

        if (item.action === 'needs_eyes' || item.action === 'keep' || (item.action === 'move' && item.category === 'NEEDS EYES')) {
          if (message.category !== 'NEEDS EYES') {
            logEvent({ type: 'correction', messageId: message.messageId || message.id, sender: message.from, senderName: message.senderName, subject: message.subject, from: message.category, to: 'NEEDS EYES' });
          }
          logEvent({ type: 'needs_eyes_flagged', inboxId: message.id, threadId: message.threadId || message.id, messageId: message.messageId || message.id, sender: message.from, senderName: message.senderName, subject: message.subject });
          logEvent({ type: 'executed', messageId: message.messageId || message.id, sender: message.from, senderName: message.senderName, subject: message.subject, action: 'needs_eyes', category: 'NEEDS EYES', demo: Boolean(message.demo) });
          inbox.splice(inbox.findIndex(row => row.id === identity), 1);
          completed.push(item.id);
          return;
        }

        if (message.demo) {
          if (['archive', 'trash', 'unsubscribe'].includes(item.action)) inbox.splice(inbox.findIndex(row => row.id === identity), 1);
          else if (item.action === 'move') message.category = item.category;
          else if (item.action === 'label') message.labels = [...new Set([...(message.labels || []), item.label])];
        } else if (['archive', 'trash', 'label', 'unsubscribe'].includes(item.action)) {
          await applyGogAction(item, knownLabels, pendingLabelCreations);
          if (['archive', 'trash', 'unsubscribe'].includes(item.action)) inbox.splice(inbox.findIndex(row => row.id === identity), 1);
          if (item.action === 'label') {
            message.labels = [...new Set([...(message.labels || []), item.label])];
            refreshedLabels = true;
          }
        } else if (item.action === 'move') {
          message.category = item.category;
        }

        const confirmedCategory = item.action === 'archive' ? 'ARCHIVABLE' : ['trash', 'unsubscribe'].includes(item.action) ? 'DELETABLE' : item.action === 'move' ? item.category : null;
        if (confirmedCategory && confirmedCategory !== item.originalCategory) {
          logEvent({ type: 'correction', messageId: message.messageId || message.id, subject: message.subject, sender: message.from, senderName: message.senderName, from: item.originalCategory, to: confirmedCategory });
        }
        logEvent({ type: 'executed', messageId: message.messageId || message.id, subject: message.subject, sender: message.from, senderName: message.senderName, action: item.action, category: item.category, label: item.label, demo: Boolean(message.demo) });
        completed.push(item.id);
      } catch (error) {
        item.error = error.message;
        remaining.push(item);
      } finally {
        settled += 1;
        activeOperation.completed = settled;
        activeOperation.stage = `${actionName} · ${settled}/${queue.length}`;
      }
    }

    const workerCount = Math.min(3, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < queue.length) {
        const item = queue[nextIndex++];
        await processItem(item);
      }
    }));

    writeJsonl(inboxPath, inbox);
    writeJsonl(queuePath, remaining);
    if (refreshedLabels) writeLabelCache(await listGmailLabels());
    const history = readJsonl(historyPath);
    const response = { completed: completed.length, failed: remaining.map(item => ({ subject: item.subject, error: item.error })), inbox, queue: remaining, demo: inbox.some(message => message.demo) };
    const changedFilterInputs = queue.some(item => completed.includes(item.id) && ['label', 'create_filter'].includes(item.action));
    if (changedFilterInputs) response.filterSuggestions = await getFilterSuggestions(history, remaining);
    res.json(response);
  } catch (error) {
    res.status(502).json({ error: `Queue execution failed: ${error.message}` });
  } finally {
    operationInProgress = false;
    activeOperation = null;
  }
});

app.post('/api/demo/reset', (_req, res) => {
  if (operationInProgress) return res.status(409).json({ error: 'Wait for the current operation to finish before resetting demo data' });
  const rows = demoRows.map(([id, subject, category, from]) => ({ id, subject, category, from, labels: [], demo: true }));
  writeJsonl(inboxPath, rows);
  writeJsonl(queuePath, []);
  logEvent({ type: 'demo_reset' });
  res.json({ inbox: rows, queue: [] });
});

app.listen(port, host, () => {
  console.log(`GNAIL running at http://${host}:${port}`);
  console.log(`Local data: ${dataDir}`);
});
