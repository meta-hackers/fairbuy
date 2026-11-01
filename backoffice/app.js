/* Standalone, same-origin admin client. No credentials or session data in localStorage. */
const $ = id => document.getElementById(id);
let page = 1;
let activeSession = null;
let priceTable = {};
let generation = 0;
let sourceData = null;
let sourceMeta = { roles: [], verticals: [], builtinCount: 0 };
let editingSource = null;
const number = value => value == null ? 'Unknown' : value.toLocaleString();
const cost = value => value == null ? 'Unknown' : `~$${value.toFixed(5)}`;
const date = value => value ? new Date(value).toLocaleString() : '—';
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function show(view) {
  for (const id of ['login', 'history', 'detail', 'sources']) $(id).hidden = id !== view;
  $('admin-nav').hidden = view === 'login';
  $('nav-sessions').classList.toggle('active', view === 'history' || view === 'detail');
  $('nav-sources').classList.toggle('active', view === 'sources');
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api/admin${path}`, {
    credentials: 'same-origin', cache: 'no-store', method,
    headers: { 'Content-Type': 'application/json', 'X-Fairbuy-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) signedOut();
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}
function guarded(action) { return async event => { event?.preventDefault(); notice(''); try { await action(event); } catch (error) { notice(error.message); } }; }
function account(data) { $('username').textContent = data.username; $('account').hidden = false; $('admin-nav').hidden = false; priceTable = data.prices || {}; }
function signedOut() {
  generation++; activeSession = null; sourceData = null; editingSource = null; $('source-form').hidden = true;
  $('session-content').replaceChildren(); $('sessions').replaceChildren(); $('source-rows').replaceChildren();
  $('account').hidden = true; show('login');
}
$('login-form').addEventListener('submit', guarded(async event => {
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target));
    await api('/login', values); event.target.reset(); account(await api('/me')); await load();
  } finally { button.disabled = false; }
}));
$('logout').addEventListener('click', guarded(async () => { await api('/logout', {}); signedOut(); }));
$('filters').addEventListener('submit', guarded(async () => { page = 1; await load(); }));
$('refresh').addEventListener('click', guarded(load));
$('previous').addEventListener('click', guarded(async () => { page--; await load(); }));
$('next').addEventListener('click', guarded(async () => { page++; await load(); }));
$('back').addEventListener('click', guarded(load));
$('nav-sessions').addEventListener('click', guarded(load));
$('nav-sources').addEventListener('click', guarded(loadSources));
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
function fillSelect(id, values, allLabel, label = value => value) {
  const select = $(id); const current = select.value;
  const all = node('option', allLabel); all.value = '';
  select.replaceChildren(all, ...values.map(value => {
    const option = node('option', label(value)); option.value = value; return option;
  }));
  if (values.includes(current)) select.value = current;
}
function buildChecks(container, values, selected, name) {
  container.replaceChildren(...values.map(value => {
    const label = node('label'); const input = document.createElement('input');
    input.type = 'checkbox'; input.name = name; input.value = value; input.checked = selected.includes(value);
    label.append(input, document.createTextNode(value.replaceAll('_', ' ')));
    return label;
  }));
}
async function loadSources() {
  const request = ++generation;
  $('source-rows').setAttribute('aria-busy', 'true');
  try {
    const data = await api('/sources');
    if (request !== generation) return;
    sourceData = data.entries; sourceMeta = data;
    fillSelect('source-vertical-filter', data.verticals, 'All verticals', value => value.replaceAll('_', ' '));
    fillSelect('source-role-filter', data.roles, 'All roles');
    const countries = [...new Set(sourceData.flatMap(item => item.entry.countries === 'global' ? [] : item.entry.countries))].sort();
    fillSelect('source-country-filter', ['global', ...countries], 'All countries', value => value === 'global' ? 'Global only' : value);
    renderSources(); show('sources');
  } finally { $('source-rows').removeAttribute('aria-busy'); }
}
function renderSources() {
  if (!sourceData) return;
  const filters = Object.fromEntries(new FormData($('source-filters')));
  const search = String(filters.search ?? '').trim().toLowerCase();
  const rows = sourceData.filter(item => {
    const entry = item.entry;
    if (search && !`${entry.domain} ${entry.name}`.toLowerCase().includes(search)) return false;
    if (filters.vertical && !entry.verticals.includes(filters.vertical)) return false;
    if (filters.role && !entry.roles.includes(filters.role)) return false;
    if (filters.country === 'global') { if (entry.countries !== 'global') return false; }
    else if (filters.country && entry.countries !== 'global' && !entry.countries.includes(filters.country)) return false;
    if (filters.state === 'active' && entry.enabled === false) return false;
    if (filters.state === 'disabled' && entry.enabled !== false) return false;
    if (filters.state === 'custom' && item.origin !== 'custom') return false;
    if (filters.state === 'modified' && item.origin !== 'modified') return false;
    if (filters.state === 'default' && item.origin !== 'default') return false;
    return true;
  });
  $('source-rows').replaceChildren();
  for (const item of rows) {
    const entry = item.entry;
    const row = node('tr');
    const source = node('td');
    const open = node('button', entry.name, 'link');
    open.addEventListener('click', guarded(() => openSourceEditor(item)));
    source.append(open, node('small', `${entry.domain} · ${item.origin}${entry.enabled === false ? ' · disabled' : ''}`));
    const state = node('td');
    state.append(node('span', entry.enabled === false ? 'Disabled' : 'Active', 'badge'));
    const updated = node('td');
    updated.append(node('span', item.updatedAt ? date(item.updatedAt) : '—'), node('small', item.updatedBy || 'Built-in default'));
    const actions = node('td', null, 'row-actions');
    const edit = node('button', 'Edit', 'secondary');
    edit.addEventListener('click', guarded(() => openSourceEditor(item)));
    actions.append(edit);
    if (item.origin === 'modified' && item.hasDefault) {
      const reset = node('button', 'Reset', 'secondary');
      reset.addEventListener('click', guarded(() => resetSource(entry.domain)));
      actions.append(reset);
    }
    if (item.origin === 'custom') {
      const remove = node('button', 'Delete', 'secondary');
      remove.addEventListener('click', guarded(() => deleteCustomSource(entry.domain)));
      actions.append(remove);
    }
    row.append(
      source, node('td', entry.roles.join(', ')), node('td', entry.verticals.map(value => value.replaceAll('_', ' ')).join(', ')),
      node('td', entry.countries === 'global' ? 'Global' : entry.countries.join(', ')),
      node('td', String(entry.priority)), state, updated, actions,
    );
    $('source-rows').append(row);
  }
  if (!rows.length) {
    const row = node('tr'); const cell = node('td', 'No sources match these filters.', 'empty');
    cell.colSpan = 8; row.append(cell); $('source-rows').append(row);
  }
  $('source-count').textContent = `${rows.length} of ${sourceData.length} sources · ${sourceMeta.builtinCount} built-in`;
}
function openSourceEditor(item = null) {
  editingSource = item;
  const form = $('source-form'); form.hidden = false; form.reset();
  $('source-form-title').textContent = item ? `Edit ${item.entry.domain}` : 'Add source';
  const entry = item?.entry ?? { domain: '', name: '', roles: [], verticals: [], countries: [], priority: 3, enabled: true };
  form.elements.domain.value = entry.domain; form.elements.domain.readOnly = !!item;
  form.elements.name.value = entry.name; form.elements.priority.value = String(entry.priority);
  form.elements.countries.value = entry.countries === 'global' ? 'global' : entry.countries.join(', ');
  form.elements.note.value = entry.note ?? ''; form.elements.enabled.checked = entry.enabled !== false;
  buildChecks($('source-roles'), sourceMeta.roles, entry.roles, 'role');
  buildChecks($('source-verticals'), sourceMeta.verticals, entry.verticals, 'vertical');
  $('source-reset').hidden = !(item?.origin === 'modified' && item.hasDefault);
  $('source-delete').hidden = item?.origin !== 'custom';
  $('source-form-note').textContent = item
    ? `${item.origin === 'default' ? 'Built-in entry.' : item.origin === 'modified' ? 'Overrides a built-in entry.' : 'Custom entry.'}${item.updatedAt ? ` Last changed ${date(item.updatedAt)} by ${item.updatedBy}.` : ''}${item.defaultEntry ? ` Default name: ${item.defaultEntry.name}.` : ''}`
    : 'New custom entry. Choose roles and verticals explicitly; nothing is assumed.';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeSourceEditor() { editingSource = null; $('source-form').hidden = true; }
async function resetSource(domain) {
  await api(`/sources/${encodeURIComponent(domain)}`, undefined, 'DELETE');
  if (editingSource?.entry.domain === domain) closeSourceEditor();
  await loadSources();
}
async function deleteCustomSource(domain) {
  if (!window.confirm(`Delete ${domain} from the catalog? This removes the custom entry.`)) return;
  await resetSource(domain);
}
$('sources-refresh').addEventListener('click', guarded(loadSources));
$('sources-add').addEventListener('click', guarded(() => openSourceEditor(null)));
$('source-cancel').addEventListener('click', () => closeSourceEditor());
$('source-reset').addEventListener('click', guarded(async () => { if (editingSource) await resetSource(editingSource.entry.domain); }));
$('source-delete').addEventListener('click', guarded(async () => { if (editingSource) await deleteCustomSource(editingSource.entry.domain); }));
$('source-filters').addEventListener('submit', event => { event.preventDefault(); renderSources(); });
$('source-form').addEventListener('submit', guarded(async event => {
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form));
  const domain = String(form.elements.domain.value).trim().toLowerCase();
  const roles = [...form.querySelectorAll('input[name="role"]:checked')].map(input => input.value);
  const verticals = [...form.querySelectorAll('input[name="vertical"]:checked')].map(input => input.value);
  const rawCountries = String(values.countries ?? '').trim();
  const countries = rawCountries.toLowerCase() === 'global' ? 'global'
    : rawCountries.split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!domain) throw new Error('Enter a domain.');
  if (!roles.length) throw new Error('Choose at least one role.');
  if (!verticals.length) throw new Error('Choose at least one vertical.');
  if (!countries.length) throw new Error('Enter at least one country code or global.');
  const entry = {
    domain, name: String(values.name).trim(), roles, verticals, countries,
    priority: Number(values.priority), note: String(values.note ?? '').trim() || undefined,
    enabled: form.elements.enabled.checked,
  };
  await api(`/sources/${encodeURIComponent(domain)}`, { entry }, 'PUT');
  closeSourceEditor(); await loadSources();
}));
$('sources-reset-all').addEventListener('click', guarded(async () => {
  const confirmation = window.prompt('Type reset to remove every catalog override and restore built-in defaults.');
  if (confirmation !== 'reset') { if (confirmation !== null) notice('Confirmation did not match. Nothing was reset.'); return; }
  await api('/sources/reset', { confirm: 'reset' });
  closeSourceEditor(); await loadSources();
}));
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
