'use strict';

const $ = (id) => document.getElementById(id);
let state = null;
let editingId = null;
let assigningId = null;
let renamingStartupId = null;
let changingPass = false;
let sorting = false;
const pickedSession = {};
let sortKey = 'pins';
let sortDir = -1;

async function send(msg) {
  const r = await browser.runtime.sendMessage(msg);
  if (r && r.error) throw new Error(r.error);
  return r;
}
function fmt(ms) {
  return ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
}
function shortId(id, manual) {
  return (manual ? 'S' : 'B') + String(id || '').replace(/-/g, '').slice(0, 4).toUpperCase();
}
function setStatus(text, err) {
  const el = $('status');
  el.textContent = text || '';
  el.className = err ? 'status err' : 'status';
}
function applyConnectedState() {
  const on = !!(state && state.connected);
  $('syncNow').disabled = !on;
  $('addStartup').disabled = !on;
  $('addBrowserSel').disabled = !on;
  $('addBrowserSel').title = on ? '' : 'Connect Dropbox first so new browsers can sync';
  $('addStartup').title = on ? '' : 'Connect Dropbox first so new startups can sync';
}
function busy(on) {
  ['connect', 'syncNow', 'disconnect', 'addStartup', 'addSave', 'addBrowserSel', 'browserSave', 'encSave'].forEach((id) => { $(id).disabled = on; });
  if (!on) applyConnectedState();
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function setIfIdle(input, value) {
  if (document.activeElement !== input) input.value = value;
}

let addTarget = null;
function fillAddBrowser(startups) {
  const sel = $('addBrowserSel');
  if (document.activeElement === sel) return;
  sel.textContent = '';
  const first = el('option', '', '+ Add New Browser');
  first.value = '';
  sel.append(first);
  const def = el('option', '', 'Add to Connected browsers');
  def.value = '__default';
  sel.append(def);
  for (const st of startups) {
    const o = el('option', '', 'Add to Startup: ' + (st.name || 'Unnamed startup'));
    o.value = st.id;
    sel.append(o);
  }
  sel.value = '';
}
function closeBrowserForm() {
  $('browserForm').hidden = true;
  $('browserName').value = '';
  addTarget = null;
}

// A browser reports in every sync; if it stops, its add-on is probably gone or the browser is off.
function addonStatus(b, current) {
  if (current) return ['ok', 'Installed', 'This browser is running the add-on.'];
  const last = Number(b.lastSync) || 0;
  if (!last) return ['none', 'Not installed', 'No browser has reported in under this name yet.'];
  const every = Number(b.every) || 120 * 60000;
  const age = Date.now() - last;
  if (age <= every * 2 + 10 * 60000) return ['ok', 'Installed', `Last seen ${fmt(last)}.`];
  return ['stale', 'Not responding', `Last seen ${fmt(last)}. The add-on may be removed, disabled, or the browser is closed.`];
}

function makeTable(list, s, startups, emptyText) {
  list = [...list].sort((a, b) => {
    const av = Number(a[sortKey]) || 0;
    const bv = Number(b[sortKey]) || 0;
    return (av - bv) * sortDir || (a.name || '').localeCompare(b.name || '');
  });
  const scroll = el('div', 'scroll');
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'id', 'ID:'), el('th', 'grow', 'Browser:'), el('th', 'sess', 'Last saved session'));
  const thPins = el('th', 'num');
  const sortBtn = el('button', 'sort');
  sortBtn.type = 'button';
  sortBtn.append(document.createTextNode('Active Pin Tabs '), el('span', 'arr', sortKey === 'pins' ? (sortDir < 0 ? '↓' : '↑') : '⇅'));
  sortBtn.addEventListener('click', () => { sortDir = -sortDir; if (state) render(state); });
  thPins.append(sortBtn);
  const thAct = el('th', 'act');
  thAct.append(el('span', 'sr', 'Actions'));
  hr.append(thPins, el('th', 'stat', 'Status'), thAct);
  thead.append(hr);
  const tbody = el('tbody');
  let total = 0;
  if (!list.length) {
    const tr = el('tr');
    const td = el('td', 'muted', emptyText);
    td.colSpan = 6;
    tr.append(td);
    tbody.append(tr);
  }
  for (const b of list) {
    total += Number(b.pins) || 0;
    tbody.append(makeRow(b, s, startups));
  }
  const tfoot = el('tfoot');
  const fr = el('tr');
  fr.append(el('td', 'id', 'Total'), el('td', 'grow', `${list.length} browser${list.length === 1 ? '' : 's'}`), el('td'), el('td', 'num', String(total)), el('td'), el('td'));
  tfoot.append(fr);
  table.append(thead, tbody, tfoot);
  scroll.append(table);
  return scroll;
}

function makeRow(b, s, startups) {
  const current = b.id === s.browserId;
  const tr = el('tr');
  tr.append(el('td', 'id', shortId(b.id, b.manual)));

  const nameTd = el('td', 'grow');
  if (current && editingId !== b.id) {
    nameTd.append(document.createTextNode(b.name || 'Unnamed browser'), el('span', 'badge', 'This browser'));
  } else if (editingId === b.id) {
    const input = el('input', 'wide');
    input.type = 'text';
    input.maxLength = 60;
    input.value = b.name || '';
    input.setAttribute('aria-label', 'Browser name');
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { editingId = null; render(state); }
      if (e.key === 'Enter') {
        try { editingId = null; render(await send({ type: 'renameBrowser', id: b.id, name: input.value })); setStatus('Name saved and synced.'); }
        catch (err) { setStatus(err.message, true); }
      }
    });
    nameTd.append(input);
    if (current) nameTd.append(el('span', 'badge', 'This browser'));
    setTimeout(() => input.focus(), 0);
  } else {
    nameTd.append(document.createTextNode(b.name || 'Unnamed browser'));
  }
  const mySessions = (s.sessions || []).filter((x) => x.browserId === b.id).sort((a, c) => c.at - a.at);
  const sessTd = el('td', 'sess');
  const ssel = el('select', 'sess-select');
  ssel.setAttribute('aria-label', 'Last saved session');
  if (!mySessions.length) {
    ssel.append(el('option', '', 'No saved session yet'));
    ssel.disabled = true;
  }
  for (const x of mySessions) {
    const o = el('option', '', `${fmt(x.at)} · ${x.count} pin${x.count === 1 ? '' : 's'}${x.manual ? ' · saved' : ''}`);
    o.value = x.id;
    ssel.append(o);
  }
  if (mySessions.some((x) => x.id === pickedSession[b.id])) ssel.value = pickedSession[b.id];
  ssel.addEventListener('change', () => { pickedSession[b.id] = ssel.value; });
  sessTd.append(ssel);
  const [kind, label, tip] = addonStatus(b, current);
  const statTd = el('td', 'stat');
  const pill = el('span', 'status-pill ' + kind);
  pill.append(el('span', 'dot'), document.createTextNode(label));
  pill.title = tip;
  statTd.append(pill);
  tr.append(nameTd, sessTd, el('td', 'num', String(b.pins ?? 0)), statTd);

  const act = el('td', 'act');
  const rest = el('button', 'btn link', 'Restore');
  rest.type = 'button';
  rest.disabled = !mySessions.length;
  rest.title = mySessions.length ? 'Replace the pinned tabs with the selected saved session' : 'No saved session yet';
  rest.addEventListener('click', async () => {
    const id = ssel.value;
    const x = mySessions.find((m) => m.id === id);
    if (!x) return;
    if (!confirm(`Restore ${x.count} pinned tab${x.count === 1 ? '' : 's'} saved ${fmt(x.at)}?\nThis replaces the pinned tabs in this browser.`)) return;
    busy(true);
    setStatus('Restoring session…');
    try { render(await send({ type: 'restoreSession', sessionId: id })); } catch (err) { setStatus(err.message, true); }
    busy(false);
  });
  if (assigningId === b.id) {
    const sel = el('select', 'assign-select');
    sel.setAttribute('aria-label', 'Assign to Startup');
    const none = el('option', '', 'Connected browsers (no Startup)');
    none.value = '';
    sel.append(none);
    for (const st of startups) {
      const o = el('option', '', st.name || 'Unnamed startup');
      o.value = st.id;
      sel.append(o);
    }
    sel.value = b.startupId && startups.some((x) => x.id === b.startupId) ? b.startupId : '';
    sel.addEventListener('change', async () => {
      assigningId = null;
      try { render(await send({ type: 'assignBrowser', id: b.id, startupId: sel.value || null })); setStatus('Assignment saved and synced.'); }
      catch (err) { setStatus(err.message, true); render(state); }
    });
    sel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { assigningId = null; render(state); } });
    act.append(sel);
    setTimeout(() => sel.focus(), 0);
  } else {
    const as = el('button', 'btn link', 'Assign to Startup');
    as.type = 'button';
    as.disabled = !startups.length || !s.connected;
    as.title = !s.connected ? 'Connect Dropbox first' : (startups.length ? '' : 'Add a Startup first');
    as.addEventListener('click', () => { assigningId = b.id; render(state); });
    act.append(as);
  }
  act.append(rest);
  const saveSess = el('button', 'btn link', 'Save Session');
  saveSess.type = 'button';
  saveSess.disabled = !current || !s.connected;
  saveSess.title = !s.connected ? 'Connect Dropbox first' : (current ? 'Save this browser\'s current pinned tabs as a session' : 'Open the add-on in that browser to save its session');
  saveSess.addEventListener('click', async () => {
    busy(true);
    setStatus('Saving session…');
    try { render(await send({ type: 'saveSession', id: b.id })); setStatus('Session saved.'); } catch (err) { setStatus(err.message, true); }
    busy(false);
  });
  act.append(saveSess);
  const ren = el('button', 'btn link', editingId === b.id ? 'Cancel' : 'Rename');
  ren.type = 'button';
  ren.addEventListener('click', () => { editingId = editingId === b.id ? null : b.id; render(state); });
  act.append(ren);
  if (!current) {
    const del = el('button', 'btn link danger', 'Forget');
    del.type = 'button';
    del.addEventListener('click', async () => {
      try { render(await send({ type: 'forgetBrowser', id: b.id })); }
      catch (err) { setStatus(err.message, true); }
    });
    act.append(del);
  }
  tr.append(act);
  return tr;
}

function renderEnc(s) {
  const e = s.enc || {};
  $('encCard').hidden = !s.connected;
  if (!s.connected) return;
  const unlocked = !!e.unlocked;
  const form = $('encForm');
  if (unlocked && !changingPass) {
    $('encSub').textContent = 'On. Pinned tabs are encrypted inside this add-on (AES-256-GCM) before they reach Dropbox.';
    form.hidden = true;
    $('encActions').hidden = false;
    return;
  }
  $('encActions').hidden = true;
  form.hidden = false;
  $('encCancel').hidden = !changingPass;
  if (unlocked) {
    $('encSub').textContent = 'Choose a new passphrase. Your other browsers will ask for it on their next sync.';
    $('encLabel').textContent = 'New passphrase';
    $('encPass2Field').hidden = false;
    $('encSave').textContent = 'Change passphrase';
  } else if (e.remoteKind === 'encrypted') {
    $('encSub').textContent = 'Encrypted data found in Dropbox. Enter your passphrase to unlock it on this browser. Dropbox never sees it.';
    $('encLabel').textContent = 'Passphrase';
    $('encPass2Field').hidden = true;
    $('encSave').textContent = 'Unlock';
  } else {
    $('encSub').textContent = 'Not encrypted yet. Choose a passphrase of at least 12 characters. If you lose it, the synced data cannot be recovered.';
    $('encLabel').textContent = 'Passphrase';
    $('encPass2Field').hidden = false;
    $('encSave').textContent = 'Enable encryption';
  }
}

function render(s) {
  state = s;
  renderEnc(s);
  $('redirect').textContent = s.redirectUri;
  $('steps').hidden = s.connected;
  $('appField').hidden = s.connected;
  setIfIdle($('appKey'), s.appKey || '');
  $('connect').hidden = s.connected;
  $('disconnect').hidden = !s.connected;
  $('conn').textContent = s.connected ? `Connected as ${s.email || 'your Dropbox account'}` : 'Not connected';

  $('autoSync').checked = s.settings.autoSync;
  setIfIdle($('syncMinutes'), s.settings.syncMinutes);
  $('sameInEveryWindow').checked = s.settings.sameInEveryWindow;

  applyConnectedState();
  $('sub').textContent = s.lastSync ? `Last synced ${fmt(s.lastSync)}.` : 'Browsers not assigned to a Startup. Use “Assign to Startup” to move one into its own section.';

  const all = Object.entries(s.browsers).map(([id, b]) => ({ id, ...b }));
  const startups = all.filter((b) => b.manual).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const stat = (st) => {
    const members = all.filter((b) => !b.manual && b.startupId === st.id);
    return { n: members.length, pins: members.reduce((t, b) => t + (Number(b.pins) || 0), 0) };
  };
  // Manual order (set with the Sort button); sections never sorted by hand fall back to A-Z.
  const cmp = (a, b) => (a.order ?? 1e15) - (b.order ?? 1e15) || (a.name || '').localeCompare(b.name || '');
  const shown = [...startups].sort(cmp);
  const startupIds = new Set(startups.map((b) => b.id));
  const browsers = all.filter((b) => !b.manual);
  const inStartup = (b) => b.startupId && startupIds.has(b.startupId);

  fillAddBrowser(startups);
  $('defaultTable').textContent = '';
  $('defaultTable').append(makeTable(browsers.filter((b) => !inStartup(b)), s, startups, 'No unassigned browsers.'));

  const wrap = $('startups');
  wrap.textContent = '';
  const idsNow = shown.map((x) => x.id);
  async function saveOrder(ids) {
    try { render(await send({ type: 'setStartupOrder', ids })); }
    catch (err) { setStatus(err.message, true); }
  }
  let dragId = null;
  const clearMarks = () => wrap.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));
  wrap.classList.toggle('sorting', sorting);
  $('sortMode').textContent = sorting ? 'Done' : 'Sort';
  $('sortMode').title = startups.length < 2 ? 'Add at least two Startups to sort them' : (s.connected ? '' : 'Connect Dropbox first so the order can sync');
  $('sortMode').disabled = (startups.length < 2 && !sorting) || !s.connected;
  if (sorting) {
    const hint = el('p', 'sort-hint', 'Drag a section by ⠿ to its new place, or focus ⠿ and press ↑ / ↓. Click Done (or press Esc) when finished.');
    wrap.append(hint);
  }

  shown.forEach((st, idx) => {
    const card = el('section', 'card startup-card' + (sorting ? ' compact' : ''));
    card.dataset.id = st.id;
    const head = el('header', 'card-head head startup-head');
    const left = el('div');
    const del = el('button', 'btn link danger', 'Delete startup');
    del.type = 'button';
    del.addEventListener('click', async () => {
      try { render(await send({ type: 'forgetBrowser', id: st.id })); setStatus('Startup deleted. Its browsers moved back to Connected browsers.'); }
      catch (err) { setStatus(err.message, true); }
    });
    const tools = el('div');
    if (sorting) {
      const handle = el('span', 'handle', '⠿'); // a span, because Firefox does not drag <button> elements
      handle.setAttribute('role', 'button');
      handle.tabIndex = 0;
      handle.draggable = true;
      handle.title = 'Drag to reorder';
      handle.setAttribute('aria-label', `Move Startup ${st.name || ''}. Use arrow up or down.`);
      handle.addEventListener('dragstart', (e) => {
        dragId = st.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', st.id);
        try { e.dataTransfer.setDragImage(card, 20, 20); } catch (err) {}
        setTimeout(() => card.classList.add('dragging'), 0);
      });
      handle.addEventListener('dragend', () => { dragId = null; clearMarks(); });
      handle.addEventListener('keydown', async (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const i = idsNow.indexOf(st.id);
        const j = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (j < 0 || j >= idsNow.length) return;
        const next = [...idsNow];
        [next[i], next[j]] = [next[j], next[i]];
        await saveOrder(next);
        const again = wrap.querySelector(`[data-id="${st.id}"] .handle`);
        if (again) again.focus();
      });
      card.addEventListener('dragover', (e) => {
        if (!dragId || dragId === st.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = card.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        wrap.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
        card.classList.add(before ? 'drop-before' : 'drop-after');
      });
      card.addEventListener('drop', async (e) => {
        if (!dragId || dragId === st.id) return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        const moving = dragId;
        dragId = null;
        clearMarks();
        const next = idsNow.filter((x) => x !== moving);
        const at = next.indexOf(st.id) + (before ? 0 : 1);
        next.splice(at, 0, moving);
        if (next.join() !== idsNow.join()) await saveOrder(next);
      });
      const stt = stat(st);
      left.append(handle, el('span', 'startup-name-static', st.name || 'Unnamed startup'),
        el('span', 'badge', `${stt.n} browser${stt.n === 1 ? '' : 's'} · ${stt.pins} pin tabs`));
      for (const [label, dir, dis] of [['▲', -1, idx === 0], ['▼', 1, idx === shown.length - 1]]) {
        const mv = el('button', 'btn link move', label);
        mv.type = 'button';
        mv.disabled = dis;
        mv.title = dir < 0 ? 'Move section up' : 'Move section down';
        mv.addEventListener('click', async () => {
          const next = [...idsNow];
          [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
          await saveOrder(next);
        });
        tools.append(mv);
      }
      head.append(left, tools);
      card.append(head);
    } else {
      const stt = stat(st);
      // Same headline + sub-line format as "Connected browsers:" (no field).
      left.append(el('h2', '', st.name || 'Unnamed startup'), el('p', '', `Total Browsers: ${stt.n}`));
      const ren = el('button', 'btn link', 'Rename');
      ren.type = 'button';
      ren.addEventListener('click', () => { renamingStartupId = renamingStartupId === st.id ? null : st.id; render(state); });
      if (renamingStartupId === st.id) {
        left.textContent = '';
        const input = el('input', 'wide name-input');
        input.type = 'text';
        input.maxLength = 60;
        input.value = st.name || '';
        input.setAttribute('aria-label', 'Startup name');
        input.addEventListener('keydown', async (e) => {
          if (e.key === 'Escape') { renamingStartupId = null; render(state); }
          if (e.key === 'Enter') {
            try { renamingStartupId = null; render(await send({ type: 'renameBrowser', id: st.id, name: input.value })); setStatus('Startup renamed and synced.'); }
            catch (err) { setStatus(err.message, true); }
          }
        });
        left.append(input);
        setTimeout(() => input.focus(), 0);
        ren.textContent = 'Cancel';
      }
      tools.append(ren, del);
      head.append(left, tools);
      card.append(head, makeTable(browsers.filter((b) => b.startupId === st.id), s, startups, 'No browsers assigned yet.'));
    }
    wrap.append(card);
  });

  if (s.status) setStatus(`${s.status.text} (${fmt(s.status.at)})`, s.status.error);
}

async function refresh() {
  try { render(await send({ type: 'getState' })); } catch (e) { setStatus(e.message, true); }
}

$('connect').addEventListener('click', async () => {
  const key = $('appKey').value.trim();
  if (!key) { setStatus('Enter your Dropbox app key first.', true); return; }
  busy(true);
  setStatus('Finish the Dropbox sign-in in the window that opened…');
  try {
    render(await send({ type: 'connect', appKey: key }));
    setStatus('Syncing…');
    render(await send({ type: 'syncNow' })); // same as pressing Sync now, so the list is final
  } catch (e) {
    await refresh().catch(() => {});
    setStatus(e.message, true);
  }
  busy(false);
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('redirect').textContent); setStatus('Address copied.'); }
  catch (e) { setStatus('Could not copy. Select the address and copy it manually.', true); }
});
$('disconnect').addEventListener('click', async () => {
  try { render(await send({ type: 'disconnect' })); } catch (e) { setStatus(e.message, true); }
});
$('syncNow').addEventListener('click', async () => {
  busy(true);
  setStatus('Syncing…');
  try { render(await send({ type: 'syncNow' })); } catch (e) { await refresh().catch(() => {}); setStatus(e.message, true); }
  busy(false);
});

$('encForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const passphrase = $('encPass').value;
  const confirm = $('encPass2').value;
  if (!passphrase) { setStatus('Enter a passphrase.', true); return; }
  const changing = changingPass;
  busy(true);
  setStatus(changing ? 'Changing passphrase…' : 'Unlocking and syncing…');
  try {
    const r = await send({ type: changing ? 'changePassphrase' : 'unlock', passphrase, confirm });
    $('encPass').value = '';
    $('encPass2').value = '';
    changingPass = false;
    render(r);
    setStatus(changing ? 'Passphrase changed and synced.' : 'Encryption is on and synced.');
  } catch (err) { setStatus(err.message, true); }
  busy(false);
});
$('encCancel').addEventListener('click', () => {
  changingPass = false;
  $('encPass').value = '';
  $('encPass2').value = '';
  if (state) render(state);
});
$('encChange').addEventListener('click', () => {
  changingPass = true;
  if (state) render(state);
  $('encPass').focus();
});
/* ----- Add new Startup ----- */
function closeAddForm() {
  $('addForm').hidden = true;
  $('startupName').value = '';
}
$('addStartup').addEventListener('click', () => {
  const form = $('addForm');
  form.hidden = !form.hidden;
  if (!form.hidden) $('startupName').focus();
});
$('addCancel').addEventListener('click', closeAddForm);
$('startupName').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAddForm(); });
$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('startupName').value.trim();
  if (!name) { setStatus('Enter a name for the new startup.', true); return; }
  busy(true);
  setStatus('Adding startup and syncing…');
  try {
    render(await send({ type: 'addStartup', name }));
    closeAddForm();
    setStatus('Startup added and synced.');
  } catch (err) { setStatus(err.message, true); }
  busy(false);
});

$('addBrowserSel').addEventListener('change', () => {
  const v = $('addBrowserSel').value;
  $('addBrowserSel').value = '';
  if (!v) return;
  addTarget = v === '__default' ? null : v;
  const st = state && state.browsers[v];
  $('browserFormTitle').textContent = st ? `New browser name (in Startup: ${st.name})` : 'New browser name';
  $('browserForm').hidden = false;
  $('browserName').focus();
});
$('browserCancel').addEventListener('click', closeBrowserForm);
$('browserName').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBrowserForm(); });
$('browserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('browserName').value.trim();
  if (!name) { setStatus('Enter a name for the new browser.', true); return; }
  busy(true);
  setStatus('Adding browser and syncing…');
  try {
    render(await send({ type: 'addBrowser', name, startupId: addTarget }));
    closeBrowserForm();
    setStatus('Browser added and synced.');
  } catch (err) { setStatus(err.message, true); }
  busy(false);
});

async function pushSettings(patch) {
  try { render(await send({ type: 'setSettings', settings: patch })); } catch (e) { setStatus(e.message, true); }
}
$('sortMode').addEventListener('click', async () => {
  if (sorting) { sorting = false; render(state); return; }
  try {
    // Start from the order currently on screen, so nothing jumps when manual mode begins.
    const shownIds = [...document.querySelectorAll('#startups .startup-card')].map((c) => c.dataset.id).filter(Boolean);
    const unordered = Object.values(state.browsers).some((b) => b.manual && b.order === undefined);
    if (unordered) await send({ type: 'setStartupOrder', ids: shownIds });
    sorting = true;
    render(await send({ type: 'getState' }));
  } catch (err) { setStatus(err.message, true); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sorting && !(e.target && e.target.matches && e.target.matches('input, select'))) { sorting = false; if (state) render(state); } });
$('autoSync').addEventListener('change', () => pushSettings({ autoSync: $('autoSync').checked }));
$('sameInEveryWindow').addEventListener('change', () => pushSettings({ sameInEveryWindow: $('sameInEveryWindow').checked }));
$('syncMinutes').addEventListener('change', () => pushSettings({ syncMinutes: Number($('syncMinutes').value) }));
browser.storage.onChanged.addListener(() => {
  if (!editingId && !assigningId && !(document.activeElement && document.activeElement.closest('table, .startup-head'))) refresh();
});

// Opening the page pulls the latest browser names and startups from Dropbox.
(async () => {
  await refresh();
  if (state && state.connected) {
    try { render(await send({ type: 'syncNow' })); } catch (e) { await refresh().catch(() => {}); }
  }
})();
