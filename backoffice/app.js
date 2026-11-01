/* Standalone, same-origin admin client. No credentials or session data in localStorage. */
const $ = id => document.getElementById(id);
let page = 1;
let activeSession = null;
let priceTable = {};
let generation = 0;
const number = value => value == null ? 'Unknown' : value.toLocaleString();
const cost = value => value == null ? 'Unknown' : `~$${value.toFixed(5)}`;
const date = value => value ? new Date(value).toLocaleString() : '—';
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function show(view) { for (const id of ['login', 'history', 'detail']) $(id).hidden = id !== view; }
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(path, body) {
  const response = await fetch(`/api/admin${path}`, { credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Fairbuy-Request': '1' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      generation++; activeSession = null; $('session-content').replaceChildren(); $('sessions').replaceChildren(); $('account').hidden = true; show('login');
    }
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}
function guarded(action) { return async event => { event?.preventDefault(); notice(''); try { await action(event); } catch (error) { notice(error.message); } }; }
function account(data) { $('username').textContent = data.username; $('account').hidden = false; priceTable = data.prices || {}; }
$('login-form').addEventListener('submit', guarded(async event => {
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target));
    await api('/login', values); event.target.reset(); account(await api('/me')); await load();
  } finally { button.disabled = false; }
}));
$('logout').addEventListener('click', guarded(async () => {
  await api('/logout', {}); generation++; activeSession = null; $('session-content').replaceChildren(); $('sessions').replaceChildren(); $('account').hidden = true; show('login');
}));
$('filters').addEventListener('submit', guarded(async () => { page = 1; await load(); }));
$('refresh').addEventListener('click', guarded(load));
$('previous').addEventListener('click', guarded(async () => { page--; await load(); }));
$('next').addEventListener('click', guarded(async () => { page++; await load(); }));
$('back').addEventListener('click', guarded(load));
async function load() {
  const request = ++generation;
  const query = new URLSearchParams(new FormData($('filters'))); query.set('page', page);
  $('sessions').setAttribute('aria-busy', 'true');
  const result = await api(`/sessions?${query}`);
  if (request !== generation) return;
  activeSession = null; $('session-content').replaceChildren(); show('history'); $('sessions').replaceChildren();
  for (const session of result.sessions) {
    const row = node('tr');
    const title = node('td'); const open = node('button', session.category || 'Untitled session', 'link');
    open.addEventListener('click', guarded(() => detail(session.id))); title.append(open, node('small', `${session.id} · ${session.mode}`));
    const owner = node('td', session.owner.slice(0, 14), 'mono'); owner.title = session.owner;
    const phase = node('td'); phase.append(node('span', `${session.stage}${session.archived ? ' · Closed' : ''}`, 'badge'));
    const dates = node('td'); dates.append(node('span', date(session.createdAt)), node('small', date(session.updatedAt)));
    const usage = node('td', `${number(session.usage.inputTokens)} / ${number(session.usage.outputTokens)}`);
    const estimate = node('td', `${cost(session.usage.estimatedCostUsd)}${session.usage.partial ? ' *' : ''}`);
    row.append(title, owner, phase, dates, usage, estimate); $('sessions').append(row);
  }
  if (!result.sessions.length) { const row = node('tr'); const cell = node('td', 'No sessions match these filters.', 'empty'); cell.colSpan = 6; row.append(cell); $('sessions').append(row); }
  $('sessions').removeAttribute('aria-busy'); $('count').textContent = `${result.total} sessions · Page ${page}`;
  $('previous').disabled = page <= 1; $('next').disabled = page * result.pageSize >= result.total;
}
function jsonDisclosure(title, data) { const details = node('details'); details.append(node('summary', title), node('pre', JSON.stringify(data, null, 2))); return details; }
function section(title) { const section = node('section', null, 'panel'); section.append(node('h2', title)); return section; }
function metric(label, value) { const card = node('div', null, 'metric'); card.append(node('small', label), node('strong', value)); return card; }
function usageTable(events) {
  const wrap = node('div', null, 'table-wrap'); const table = node('table'); const head = node('thead'); const headings = node('tr');
  for (const label of ['Phase', 'Calls', 'Input', 'Output', 'Est. USD']) headings.append(node('th', label));
  head.append(headings); const body = node('tbody');
  for (const phase of ['preview', 'ask', 'configure', 'learn', 'discovery', 'buy']) {
    const group = events.filter(e => e.phase === phase);
    const sum = key => group.some(e => e[key] != null) ? group.reduce((total, e) => total + (e[key] || 0), 0) : null;
    const row = node('tr');
    for (const value of [phase, group.length, number(sum('inputTokens')), number(sum('outputTokens')), cost(sum('estimatedCostUsd'))]) row.append(node('td', value));
    body.append(row);
  }
  table.append(head, body); wrap.append(table); return wrap;
}
async function detail(id) {
  const request = ++generation;
  const result = await api(`/sessions/${id}`);
  if (request !== generation) return;
  activeSession = id; const s = result.session; show('detail'); const root = $('session-content'); root.replaceChildren();
  const heading = node('div', null, 'heading'); const title = node('div'); title.append(node('h1', s.config.category || 'Untitled session'), node('p', `${s.id} · ${s.mode} · ${s.stage}`));
  const refresh = node('button', 'Refresh', 'secondary'); refresh.addEventListener('click', guarded(() => detail(activeSession)));
  heading.append(title, refresh); root.append(heading);
  const metrics = node('div', null, 'metrics'); metrics.append(metric('Input tokens', number(result.summary.inputTokens)), metric('Output tokens', number(result.summary.outputTokens)), metric('Estimated USD', cost(result.summary.estimatedCostUsd)), metric('Provider calls tracked', result.summary.calls)); root.append(metrics);
  root.append(node('p', `Created ${date(s.createdAt)} · Updated ${date(s.updatedAt)} · Selected product: ${s.selectedProductId || 'None'}`, 'policy'));
  const usage = section('Usage by phase'); usage.append(usageTable(result.usage));
  usage.append(node('p', 'Unknown means usage was not reported or not tracked. Totals cover tracked calls only and can be partial, particularly for older sessions. Reasoning tokens are included in output; cached tokens are included in input. Preview calls are attributed to the latest session when one exists; pre-session previews are not included.', 'policy'));
  usage.append(jsonDisclosure('Budgeting rates (USD per million input / output tokens; * = fallback)', priceTable));
  for (const event of result.usage) {
    const item = node('div', null, 'call');
    item.append(node('strong', `${event.phase} / ${event.operation}`), node('small', `${event.provider} · ${event.model} · ${event.status} · ${(event.durationMs / 1000).toFixed(1)}s · ${date(event.createdAt)}`), node('p', `Input ${number(event.inputTokens)} / output ${number(event.outputTokens)} · cached ${number(event.cachedTokens)} · reasoning ${number(event.reasoningTokens)} · ${cost(event.estimatedCostUsd)}${event.roundId ? ` · Round ${event.roundId}` : ''}`));
    usage.append(item);
  }
  root.append(usage);
  for (const [title, messages] of [['Ask conversation', s.askMessages], ['Configure conversation', s.configureMessages]]) {
    const chat = section(title);
    if (!messages.length) chat.append(node('p', 'No messages recorded.', 'policy'));
    for (const message of messages) { const bubble = node('div', null, `message ${message.role}`); bubble.append(node('strong', message.role), node('p', message.content)); chat.append(bubble); }
    root.append(chat);
  }
  const configuration = section('Configuration & feedback'); configuration.append(jsonDisclosure('Current configuration', s.config), jsonDisclosure('Initial configuration', s.initialConfig), jsonDisclosure('Feedback and learned requirements', s.feedback), jsonDisclosure('Readiness and missing information', { ready: s.ready, missing: s.missing })); root.append(configuration);
  const rounds = section('Discovery rounds');
  if (!s.rounds.length) rounds.append(node('p', 'No discovery rounds yet.', 'policy'));
  for (const round of s.rounds) {
    const panel = node('article', null, 'round'); panel.append(node('h3', `Round ${round.number} · ${round.status}`), node('small', `${round.trigger} · Attempt ${round.attempt} · ${round.durationMs == null ? 'Duration unknown' : `${(round.durationMs / 1000).toFixed(1)}s`} · ${date(round.createdAt)}`), node('p', round.summary));
    if (round.error) panel.append(node('p', round.error, 'error'));
    for (const product of round.products) {
      const card = node('div', null, 'product'); card.append(node('h4', `${product.name}${s.selectedProductId === product.id ? ' · Selected' : ''}`), node('p', product.summary), node('p', product.why));
      card.append(jsonDisclosure('Offers, prices, attributes and evidence', product.offers), jsonDisclosure('Tradeoffs', product.tradeoffs)); panel.append(card);
    }
    panel.append(jsonDisclosure('Sources', round.sources), jsonDisclosure('Round configuration, context and ranking', { context: round.context, ranking: round.ranking }), jsonDisclosure('Full round record', round)); rounds.append(panel);
  }
  root.append(rounds, jsonDisclosure('Complete stored session and usage data', result));
  const history = section('Immutable version history');
  const loadHistory = node('button', 'Load versions', 'secondary');
  loadHistory.addEventListener('click', guarded(async () => {
    loadHistory.disabled = true;
    try {
      const data = await api(`/sessions/${id}/history`);
      if (activeSession !== id || request !== generation) return;
      for (const revision of data.revisions) {
        history.append(jsonDisclosure(`Version ${revision.version} · ${revision.kind} · ${date(revision.createdAt)}${revision.revokedFeedbackIds.length ? ' · Feedback revoked' : ''}`, revision));
      }
      loadHistory.remove();
    } finally { loadHistory.disabled = false; }
  }));
  history.append(loadHistory); root.append(history);
  const maintenance = section('Maintenance');
  maintenance.append(node('p', 'Permanent deletion removes every version, legacy record, job and usage entry for this session. This cannot be undone. There is no automatic expiration.', 'policy'));
  const purge = node('button', 'Permanently delete this session', 'secondary');
  purge.addEventListener('click', guarded(async () => {
    const confirmation = window.prompt(`Maintenance: type the session ID to permanently delete all its data:\n${id}`);
    if (confirmation !== id) { if (confirmation !== null) notice('Session ID does not match. Nothing was deleted.'); return; }
    purge.disabled = true;
    try { await api(`/sessions/${id}/purge`, { confirmSessionId: confirmation }); await load(); }
    finally { purge.disabled = false; }
  }));
  maintenance.append(purge); root.append(maintenance);
  window.scrollTo({ top: 0 });
}
guarded(async () => { try { account(await api('/me')); await load(); } catch (error) { show('login'); if (error.message !== 'Admin login required.') notice(error.message); } })();
