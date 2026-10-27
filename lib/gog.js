import { spawn } from 'node:child_process';
import { senderDisplayName } from './learning.js';

export const GMAIL_ACCOUNT = process.env.GOG_ACCOUNT || '';

function command(args, { json = true, timeout = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const global = ['--client', 'default', '--no-input', '--gmail-no-send'];
    if (GMAIL_ACCOUNT) global.unshift('--account', GMAIL_ACCOUNT);
    if (json) global.push('--json');
    const child = spawn(process.env.GOG_BIN || 'gog', [...global, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `gog exited with ${code}`));
      if (!json) return resolve(stdout.trim());
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('gog returned invalid JSON')); }
    });
  });
}

function unwrap(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['threads', 'messages', 'items', 'results', 'accounts', 'clients', 'labels']) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of ['result', 'data', 'response']) {
    const found = unwrap(value[key]);
    if (found.length) return found;
  }
  return [];
}

function text(...values) {
  const value = values.find(item => typeof item === 'string' && item.length);
  return value || '';
}

export function normalizeThread(row) {
  const headers = row.headers || {};
  const messageId = text(row.id, row.messageId, row.message_id);
  const threadId = text(row.threadId, row.thread_id, row.thread, messageId);
  const labels = Array.isArray(row.labels) ? row.labels.map(label => typeof label === 'string' ? label : label.name).filter(Boolean) : [];
  return {
    id: threadId,
    threadId,
    messageId,
    subject: text(row.subject, row.Subject, headers.Subject, '(no subject)'),
    from: text(row.from, row.sender, row.From, headers.From),
    senderName: senderDisplayName(text(row.from, row.sender, row.From, headers.From)),
    snippet: text(row.snippet, row.Snippet),
    date: text(row.date, row.internalDate, row.internal_date, row.Date, headers.Date),
    labels,
    category: 'NEEDS EYES',
    webUrl: text(row.webUrl, row.web_url, row.url, `https://mail.google.com/mail/u/0/#all/${threadId}`),
    demo: false,
  };
}

export async function gogConnected() {
  try {
    const result = await command(['auth', 'list']);
    const accounts = unwrap(result);
    const accountExists = GMAIL_ACCOUNT
      ? accounts.some(account => text(account.email, account.account).toLowerCase() === GMAIL_ACCOUNT.toLowerCase())
      : accounts.length > 0;
    if (!accountExists) return false;
    await command(['gmail', 'labels', 'list']);
    return true;
  } catch {
    return false;
  }
}

export async function gogCredentialsConfigured() {
  try {
    const result = await command(['auth', 'credentials', 'list']);
    return unwrap(result).some(client => text(client.client, client.name) === 'default');
  } catch {
    return false;
  }
}

export async function captureInboxSnapshot() {
  const result = await command(['gmail', 'search', 'in:inbox', '--all', '--max', '1000']);
  const rows = unwrap(result).map(normalizeThread).filter(thread => thread.id && thread.subject);
  const byId = new Map(rows.map(thread => [thread.id, thread]));
  return [...byId.values()];
}

export async function listGmailLabelRecords() {
  const result = await command(['gmail', 'labels', 'list']);
  return unwrap(result).filter(label => typeof label === 'object' && label.name && label.id);
}

export async function listGmailLabels() {
  const systemLabels = new Set(['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'SENT', 'DRAFT']);
  return (await listGmailLabelRecords())
    .filter(label => label.type === 'user' && !label.name.startsWith('CATEGORY_') && !systemLabels.has(label.name))
    .map(label => label.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function listGmailFilters() {
  const result = await command(['gmail', 'settings', 'filters', 'list']);
  return unwrap(result);
}

export async function createGmailFilter(from, label) {
  const [filters, labels] = await Promise.all([listGmailFilters(), listGmailLabelRecords()]);
  const labelId = labels.find(item => item.name.toLowerCase() === label.toLowerCase())?.id;
  const alreadyExists = filters.some(filter => {
    const criteria = filter.criteria || {};
    const action = filter.action || {};
    const fromValue = String(criteria.from || '').toLowerCase();
    const query = String(criteria.query || '').toLowerCase();
    return (fromValue === from.toLowerCase() || query.includes(`from:${from.toLowerCase()}`)) && (action.addLabelIds || []).map(String).includes(String(labelId));
  });
  if (alreadyExists) return { alreadyExists: true };
  await command(['gmail', 'settings', 'filters', 'create', '--from', from, '--add-label', label]);
  return { alreadyExists: false };
}

export async function applyGogAction(item, knownLabels, pendingLabelCreations = new Map()) {
  const threadId = item.threadId || item.messageId;
  if (item.action === 'archive') {
    await command(['gmail', 'thread', 'modify', threadId, '--remove', 'INBOX']);
    return;
  }
  if (item.action === 'trash') {
    await command(['gmail', 'thread', 'modify', threadId, '--add', 'TRASH']);
    return;
  }
  if (item.action === 'label') {
    const labels = knownLabels || new Set(await listGmailLabels());
    if (!labels.has(item.label)) {
      let creation = pendingLabelCreations.get(item.label);
      if (!creation) {
        creation = command(['gmail', 'labels', 'create', item.label]).then(() => labels.add(item.label));
        pendingLabelCreations.set(item.label, creation);
      }
      try { await creation; }
      finally { if (pendingLabelCreations.get(item.label) === creation) pendingLabelCreations.delete(item.label); }
    }
    await command(['gmail', 'thread', 'modify', threadId, '--add-label', item.label]);
    return;
  }
  if (item.action === 'unsubscribe') {
    throw new Error('Open the message in Gmail, unsubscribe there, then mark this queue item done.');
  }
}
