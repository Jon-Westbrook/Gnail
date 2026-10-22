export function senderEmail(from) {
  const value = String(from || '').trim();
  const bracketed = value.match(/<([^<>]+)>/);
  const candidate = bracketed?.[1] || value;
  return candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
}

export function senderDisplayName(from) {
  const value = String(from || '').trim();
  const bracketed = value.match(/^\s*"?([^"<>]+?)"?\s*<[^<>]+>\s*$/);
  if (bracketed?.[1]) return bracketed[1].trim().replace(/^"|"$/g, '');
  if (value.includes('@')) return value.slice(0, value.indexOf('@'));
  return value;
}

function pairKey(email, label) {
  return `${String(email || '').toLowerCase()}\u0000${String(label || '').toLowerCase()}`;
}

function filterMatches(filter, email, labelId) {
  const criteria = filter.criteria || {};
  const action = filter.action || {};
  const from = String(criteria.from || '').toLowerCase();
  const query = String(criteria.query || '').toLowerCase();
  const matchesSender = from === email || query.includes(`from:${email}`);
  const labels = (Array.isArray(action.addLabelIds) ? action.addLabelIds : []).map(String);
  return matchesSender && labels.includes(String(labelId));
}

export function labelFilterSuggestions(history, queue = [], existingFilters = [], labels = []) {
  const labelIds = new Map(labels.map(label => [String(label.name || '').toLowerCase(), String(label.id || '')]));
  const votes = new Map();
  for (const event of history) {
    if (event.type !== 'executed' || event.action !== 'label' || !event.label) continue;
    const email = senderEmail(event.sender || event.from);
    if (!email || !event.messageId) continue;
    const key = pairKey(email, event.label);
    const vote = votes.get(key) || { email, label: event.label, count: 0, messageIds: new Set(), senderName: event.senderName || senderDisplayName(event.sender || event.from) };
    if (!vote.messageIds.has(event.messageId)) {
      vote.messageIds.add(event.messageId);
      vote.count += 1;
    }
    if (event.senderName) vote.senderName = event.senderName;
    votes.set(key, vote);
  }

  const dismissed = new Map();
  const created = new Set();
  for (const event of history) {
    const email = senderEmail(event.sender || event.from);
    if (!email || !event.label) continue;
    const key = pairKey(email, event.label);
    if (event.type === 'filter_dismissed') dismissed.set(key, Math.max(dismissed.get(key) || 0, Number(event.count) || 0));
    if (event.type === 'filter_created') created.add(key);
  }

  const staged = new Set(queue.filter(item => item.action === 'create_filter').map(item => pairKey(item.filterFrom, item.label)));
  const suggestions = [];
  for (const [key, vote] of votes) {
    if (vote.count < 2 || (dismissed.get(key) || 0) >= vote.count || created.has(key) || staged.has(key)) continue;
    const labelId = labelIds.get(vote.label.toLowerCase());
    if (labelId && existingFilters.some(filter => filterMatches(filter, vote.email, labelId))) continue;
    suggestions.push({ sender: vote.email, senderName: vote.senderName, label: vote.label, count: vote.count, key: `${encodeURIComponent(vote.email)}::${encodeURIComponent(vote.label)}` });
  }
  return suggestions.sort((a, b) => a.senderName.localeCompare(b.senderName) || a.label.localeCompare(b.label));
}
