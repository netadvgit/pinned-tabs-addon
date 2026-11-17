'use strict';

const REMOTE_PATH = '/pinned-tabs.json';
const SCOPE = 'files.content.read files.content.write account_info.read';
const DEFAULT_SETTINGS = { autoSync: true, syncMinutes: 120, sameInEveryWindow: true, startupSort: 'name' };
const MIN_SYNC_MINUTES = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let suppressUntil = 0;
let captureTimer = null;
let syncTimer = null;
let lock = Promise.resolve();
let syncChain = Promise.resolve();

function serial(fn) {
  const p = lock.then(fn);
  lock = p.catch(() => {});
  return p;
}
function suppress(ms = 2500) {
  suppressUntil = Math.max(suppressUntil, Date.now() + ms);
}

/* ---------- storage ---------- */

const DEFAULT_APP_KEY = 'd42evp2e2u7okva';

async function getLocal() {
  const d = await browser.storage.local.get(null);
  return {
    pins: [], pinsUpdatedAt: 0, dropbox: null, appKey: DEFAULT_APP_KEY, sessions: [],
    remoteBrowsers: {}, lastSync: 0, status: null,
    ...d,
    appKey: d.appKey || DEFAULT_APP_KEY,
    settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
  };
}
const save = (o) => browser.storage.local.set(o);
async function setStatus(text, error = false) {
  await save({ status: { text, error, at: Date.now() } });
}

async function defaultName() {
  let name = 'Firefox';
  try { name = (await browser.runtime.getBrowserInfo()).name; } catch (e) {}
  return name;
}
function cleanName(n) {
  return String(n || '').replace(/\s+on (macOS|Windows|Linux|Android)\s*$/i, '').trim();
}

async function ensureIdentity() {
  const L = await getLocal();
  const patch = {};
  if (!L.browserId) patch.browserId = crypto.randomUUID();
  if (!L.browserName) patch.browserName = await defaultName();
  else if (cleanName(L.browserName) !== L.browserName) {
    patch.browserName = cleanName(L.browserName) || await defaultName();
    patch.browserNameAt = Date.now();
  }
  patch.settings = L.settings;
  await save(patch);
  await browser.storage.local.remove(['google', 'creds', 'driveFileId']);
}

/* ---------- pinned tab helpers ---------- */

async function normalWindows() {
  const wins = await browser.windows.getAll({ windowTypes: ['normal'] });
  return wins.filter((w) => !w.incognito);
}
async function pinnedTabs(windowId) {
  const tabs = await browser.tabs.query({ windowId, pinned: true });
  return tabs.sort((a, b) => a.index - b.index);
}
function originOf(u) {
  try { return new URL(u).origin; } catch (e) { return 'null'; }
}
function samePins(a, b) {
  return a.length === b.length && a.every((p, i) => p.url === b[i].url);
}

// Pair each saved pin with a pinned tab (exact URL first, then same origin).
function matchPins(pins, tabs) {
  const used = new Set();
  const pairs = new Array(pins.length).fill(null);
  pins.forEach((p, i) => {
    const t = tabs.find((t) => !used.has(t.id) && t.url === p.url);
    if (t) { used.add(t.id); pairs[i] = t; }
  });
  pins.forEach((p, i) => {
    if (pairs[i]) return;
    const o = originOf(p.url);
    if (o === 'null') return;
    const t = tabs.find((t) => !used.has(t.id) && originOf(t.url) === o);
    if (t) { used.add(t.id); pairs[i] = t; }
  });
  return { pairs, extras: tabs.filter((t) => !used.has(t.id)) };
}

function reconcileWindow(win, pins, opts) {
  return serial(() => reconcileInner(win, pins, opts || {}));
}
async function reconcileInner(win, pins, { removeExtras = false }) {
  suppress();
  const tabs = await pinnedTabs(win.id);
  const { pairs, extras } = matchPins(pins, tabs);
  for (let i = 0; i < pins.length; i++) {
    if (pairs[i]) continue;
    try {
      pairs[i] = await browser.tabs.create({
        windowId: win.id, url: pins[i].url, pinned: true, active: false, index: i,
      });
    } catch (e) { /* URL not allowed for extensions */ }
  }
  if (removeExtras && extras.length) {
    await browser.tabs.remove(extras.map((t) => t.id)).catch(() => {});
  }
  for (let i = 0; i < pins.length; i++) {
    if (pairs[i]) await browser.tabs.move(pairs[i].id, { index: i }).catch(() => {});
  }
  suppress();
}

async function applyAll({ removeExtras = false, except = null } = {}) {
  const L = await getLocal();
  if (!L.settings.sameInEveryWindow) return;
  for (const w of await normalWindows()) {
    if (w.id === except) continue;
    await reconcileWindow(w, L.pins, { removeExtras });
  }
}

async function captureFrom(windowId) {
  let win;
  try { win = await browser.windows.get(windowId); } catch (e) { return; }
  if (win.incognito || win.type !== 'normal') return;
  const L = await getLocal();
  const tabs = (await pinnedTabs(windowId)).filter((t) => t.url && t.url !== 'about:blank');
  const { pairs } = matchPins(L.pins, tabs);
  const pins = tabs.map((t) => {
    const i = pairs.findIndex((x) => x && x.id === t.id);
    return { url: i >= 0 ? L.pins[i].url : t.url, title: t.title || '' };
  });
  if (samePins(pins, L.pins)) return;
  await save({ pins, pinsUpdatedAt: Date.now() });
  await applyAll({ removeExtras: true, except: windowId });
  scheduleSync();
}

async function adoptExtras() {
  const L = await getLocal();
  const pins = [...L.pins];
  for (const w of await normalWindows()) {
    const tabs = (await pinnedTabs(w.id)).filter((t) => t.url && t.url !== 'about:blank');
    const { extras } = matchPins(L.pins, tabs);
    for (const t of extras) {
      if (!pins.some((p) => p.url === t.url)) pins.push({ url: t.url, title: t.title || '' });
    }
  }
  if (pins.length !== L.pins.length) {
    await save({ pins, pinsUpdatedAt: Date.now() });
    await applyAll({ removeExtras: false });
    scheduleSync();
  }
}

function userChange(windowId) {
  if (Date.now() < suppressUntil) return;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    if (Date.now() < suppressUntil) return;
    captureFrom(windowId).catch(console.error);
  }, 400);
}

browser.tabs.onUpdated.addListener((id, change, tab) => userChange(tab.windowId), { properties: ['pinned'] });
browser.tabs.onRemoved.addListener((id, info) => { if (!info.isWindowClosing) userChange(info.windowId); });
browser.tabs.onMoved.addListener((id, info) => userChange(info.windowId));
browser.tabs.onAttached.addListener((id, info) => userChange(info.newWindowId));
browser.tabs.onDetached.addListener((id, info) => userChange(info.oldWindowId));

browser.windows.onCreated.addListener(async (w) => {
  if (w.incognito || w.type !== 'normal') return;
  suppress(3000);
  const L = await getLocal();
  if (!L.settings.sameInEveryWindow) return;
  await sleep(400);
  await reconcileWindow(w, L.pins, { removeExtras: false });
});

async function startup() {
  suppress(10000);
  await sleep(3000);
  let removeExtras = false;
  const L0 = await getLocal();
  if (L0.dropbox) {
    try { removeExtras = !!(await syncNow('startup')).adopted; } catch (e) {}
  }
  const L = await getLocal();
  for (const w of await normalWindows()) {
    await reconcileWindow(w, L.pins, { removeExtras });
  }
  if (!removeExtras) await adoptExtras();
  suppress(1500);
}

/* ---------- Dropbox auth (OAuth 2.0 + PKCE, no client secret) ---------- */

function b64url(buf) {
  let str = '';
  new Uint8Array(buf).forEach((b) => { str += String.fromCharCode(b); });
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function makePkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

async function tokenRequest(params) {
  const L = await getLocal();
  if (!L.appKey) throw new Error('Enter your Dropbox app key first.');
  const body = new URLSearchParams({ client_id: L.appKey, ...params });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Token request failed (${r.status})`);
  return j;
}

async function accessToken(force = false) {
  const L = await getLocal();
  const d = L.dropbox;
  if (!d) throw new Error('Not connected to Dropbox.');
  if (!force && d.accessToken && d.expiresAt > Date.now() + 60000) return d.accessToken;
  let t;
  try {
    t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: d.refreshToken });
  } catch (e) {
    try { await connect(false); } catch (e2) {
      throw new Error('Dropbox sign-in expired. Click "Connect with Dropbox" again.');
    }
    return (await getLocal()).dropbox.accessToken;
  }
  d.accessToken = t.access_token;
  d.expiresAt = Date.now() + (t.expires_in || 14400) * 1000;
  await save({ dropbox: d });
  return d.accessToken;
}

async function connect(interactive = true) {
  const L = await getLocal();
  if (!L.appKey) throw new Error('Enter your Dropbox app key first.');
  const redirect = browser.identity.getRedirectURL();
  const state = crypto.randomUUID();
  const { verifier, challenge } = await makePkce();
  const url = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
    client_id: L.appKey, response_type: 'code', redirect_uri: redirect,
    token_access_type: 'offline', scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  let resp;
  try {
    resp = await browser.identity.launchWebAuthFlow({ url, interactive });
  } catch (e) {
    if (!interactive) throw e;
    throw new Error(`Dropbox sign-in did not finish. If Dropbox reported an invalid redirect URI, add this exact address under Redirect URIs in your Dropbox app settings, click Add, and try again: ${redirect}`);
  }
  const u = new URL(resp);
  if (u.searchParams.get('error')) {
    throw new Error(`Dropbox: ${u.searchParams.get('error_description') || u.searchParams.get('error')}`);
  }
  if (u.searchParams.get('state') !== state) throw new Error('Sign-in state mismatch. Try again.');
  const code = u.searchParams.get('code');
  if (!code) throw new Error('Dropbox did not return an authorization code.');
  const t = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier,
  });
  const refreshToken = t.refresh_token || (L.dropbox && L.dropbox.refreshToken) || '';
  if (!refreshToken) throw new Error('Dropbox did not return a refresh token. Try connecting again.');
  let email = (L.dropbox && L.dropbox.email) || '';
  try {
    const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST', headers: { Authorization: `Bearer ${t.access_token}` },
    });
    email = (await r.json()).email || email;
  } catch (e) {}
  await save({
    dropbox: {
      refreshToken, accessToken: t.access_token,
      expiresAt: Date.now() + (t.expires_in || 14400) * 1000, email,
    },
  });
}

/* ---------- encryption (AES-256-GCM; key derived from a passphrase, kept only in this browser) ---------- */

const ENC_ITER = 600000;
const ENC_AAD = new TextEncoder().encode('persistent-pinned-tabs:v2');
const te = new TextEncoder();
const td = new TextDecoder();
class LockedError extends Error {}
const MSG_LOCKED = 'Encryption is locked on this browser. Enter your passphrase in the add-on settings.';
const MSG_NOT_SET = 'Encryption is not set up yet. Choose a passphrase in the add-on settings to start syncing.';

function b64e(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64d = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const isEnvelope = (o) => !!o && typeof o === 'object' && o.v === 2
  && typeof o.ct === 'string' && typeof o.iv === 'string' && typeof o.salt === 'string';
const clampIter = (n) => Math.min(5000000, Math.max(100000, Number(n) || ENC_ITER));

// The derived key is a non-extractable CryptoKey kept in IndexedDB; the passphrase is never stored.
function keyDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('pp-crypto', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function keyOp(mode, fn) {
  const db = await keyDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode);
      const req = fn(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
const loadKey = () => keyOp('readonly', (st) => st.get('main'));
const storeKey = (v) => keyOp('readwrite', (st) => st.put(v, 'main'));

async function deriveKey(passphrase, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function newKeyPair(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(passphrase, salt, ENC_ITER), salt: b64e(salt), iter: ENC_ITER };
}
async function encryptEnvelope(data, ck) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ENC_AAD }, ck.key, te.encode(JSON.stringify(data)));
  return { v: 2, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: ck.iter, salt: ck.salt, iv: b64e(iv), ct: b64e(ct) };
}
async function decryptEnvelope(env, key) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv), additionalData: ENC_AAD }, key, b64d(env.ct));
    return JSON.parse(td.decode(pt));
  } catch (e) {
    throw new Error('Could not decrypt the Dropbox data (wrong passphrase, or the file was changed). Sync stopped and nothing was overwritten.');
  }
}
function checkNewPassphrase(pass, confirm) {
  if (pass.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
  if (pass !== String(confirm || '')) throw new Error('The two passphrases do not match.');
}

/* ---------- Dropbox storage ---------- */

async function dfetch(url, opts = {}, retried = false) {
  const token = await accessToken(retried);
  const r = await fetch(url, {
    ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (r.status === 401 && !retried) return dfetch(url, opts, true);
  return r;
}
async function apiError(r) {
  let m = '';
  try {
    const t = await r.text();
    try { const j = JSON.parse(t); m = j.error_summary || j.error_description || t; } catch (e) { m = t; }
  } catch (e) {}
  return new Error(`Dropbox ${r.status}${m ? ': ' + String(m).slice(0, 200) : ''}`);
}
async function remoteRead() {
  const r = await dfetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST', headers: { 'Dropbox-API-Arg': JSON.stringify({ path: REMOTE_PATH }) },
  });
  if (r.status === 409) {
    const t = await r.text();
    if (t.includes('not_found')) return null;
    throw new Error(`Dropbox 409: ${t.slice(0, 200)}`);
  }
  if (!r.ok) throw await apiError(r);
  const text = await r.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch (e) { throw new Error('The Dropbox file is not valid data, so sync was stopped to avoid overwriting it.'); }
}
async function remoteWrite(data, ck) {
  const r = await dfetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Dropbox-API-Arg': JSON.stringify({ path: REMOTE_PATH, mode: 'overwrite', mute: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: JSON.stringify(await encryptEnvelope(data, ck)),
  });
  if (!r.ok) throw await apiError(r);
}

/* ---------- browser names ---------- */

const sameName = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
async function platformOs() {
  try { return (await browser.runtime.getPlatformInfo()).os; } catch (e) { return ''; }
}

/* ---------- sync ---------- */

function syncNow(reason, mutate, newCk) {
  const p = syncChain.then(() => doSync(reason, mutate, newCk));
  syncChain = p.catch(() => {});
  return p;
}

async function doSync(reason, mutate, newCk) {
  const L = await getLocal();
  if (!L.dropbox) throw new Error('Not connected to Dropbox.');
  try {
    const raw = await remoteRead();
    const kind = raw == null ? 'none' : (isEnvelope(raw) ? 'encrypted' : 'plain');
    // Someone swapping the encrypted file for a readable one must not be able to inject pinned tabs.
    if (kind === 'plain' && L.remoteKind === 'encrypted') {
      throw new Error('The Dropbox file is no longer encrypted, so sync was stopped. If you replaced it yourself, disconnect and connect Dropbox again.');
    }
    if (L.remoteKind !== kind) await save({ remoteKind: kind });
    const ck = await loadKey().catch(() => null);
    let remote = raw;
    if (kind === 'encrypted') {
      if (!ck || ck.salt !== raw.salt || ck.iter !== clampIter(raw.iter)) throw new LockedError(MSG_LOCKED);
      remote = await decryptEnvelope(raw, ck.key);
    } else if (!ck) {
      throw new LockedError(MSG_NOT_SET);
    }
    const data = remote && typeof remote === 'object' ? remote : {};
    data.version = 2;
    data.browsers = data.browsers || {};
    data.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    data.pinsBy = (data.pinsBy && typeof data.pinsBy === 'object') ? data.pinsBy : {};
    delete data.pins; // the old list shared by every browser: each browser now keeps its own
    delete data.updatedAt;

    let browserId = L.browserId;
    let browserName = L.browserName;
    let browserNameAt = Number(L.browserNameAt) || 0;
    let pins = L.pins;
    let updatedAt = L.pinsUpdatedAt;
    let claimed = false;
    const platform = await platformOs();

    // Renaming this browser to the name of a saved one takes over that saved entry and loads its pinned tabs.
    if (L.claimName) {
      const hit = Object.entries(data.browsers).find(([id, e]) =>
        id !== browserId && e && !e.manual && sameName(e.name, browserName));
      if (hit) {
        const [id, e] = hit;
        const rec = data.pinsBy[id];
        const last = data.sessions.filter((x) => x.browserId === id).sort((x, y) => y.at - x.at)[0];
        const saved = rec && Array.isArray(rec.pins) ? rec.pins
          : (last ? last.pins : (Array.isArray(e.pinUrls) ? e.pinUrls.map((url) => ({ url, title: '' })) : []));
        for (const x of data.sessions) if (x.browserId === browserId) x.browserId = id;
        delete data.browsers[browserId];
        delete data.pinsBy[browserId];
        browserId = id;
        browserName = String(e.name);
        browserNameAt = Number(e.nameAt) || browserNameAt;
        pins = saved.map((p) => ({ url: p.url, title: p.title || '' }));
        updatedAt = Date.now();
        claimed = true;
      }
    }
    // A browser the data does not know yet is NEW: it keeps its own pinned tabs and gets its own entry.
    // Its default name is made unique ("Firefox 2") so it is never mistaken for another browser.
    if (!claimed && !data.browsers[browserId] && !L.browserNamed) {
      const base = cleanName(browserName) || browserName;
      const taken = new Set(Object.entries(data.browsers)
        .filter(([id, e]) => id !== browserId && e && !e.manual)
        .map(([, e]) => cleanName(e.name).toLowerCase()));
      let nm = base;
      for (let k = 2; taken.has(nm.toLowerCase()); k++) nm = `${base} ${k}`;
      if (nm !== browserName) { browserName = nm; browserNameAt = Date.now(); }
    }
    if (!claimed) {
      const rec = data.pinsBy[browserId];
      if (rec && Array.isArray(rec.pins) && Number(rec.updatedAt) > L.pinsUpdatedAt) {
        pins = rec.pins;
        updatedAt = Number(rec.updatedAt);
      }
    }
    data.pinsBy[browserId] = { pins: pins.map((p) => ({ url: p.url, title: p.title || '' })), updatedAt };
    const adopted = !samePins(pins, L.pins);

    const cleaned = cleanName(browserName) || browserName;
    if (cleaned !== browserName) { browserName = cleaned; browserNameAt = Date.now(); }

    // A rename made from another browser wins if it is newer than our own name.
    const theirs = data.browsers[browserId];
    if (theirs && theirs.name && Number(theirs.nameAt) > browserNameAt) {
      browserName = String(theirs.name);
      browserNameAt = Number(theirs.nameAt);
    }
    data.browsers[browserId] = {
      ...(theirs || {}),
      name: browserName, nameAt: browserNameAt, lastSync: Date.now(), pins: pins.length,
      platform, pinUrls: pins.map((p) => p.url).slice(0, 200),
      // how often this browser reports in, so others can tell if the add-on is still active
      every: L.settings.autoSync ? Math.max(MIN_SYNC_MINUTES, Number(L.settings.syncMinutes) || 120) * 60000 : 7 * 86400000,
    };
    // Save a session snapshot whenever this browser's pinned tabs changed.
    const lastSession = data.sessions.find((s) => s.browserId === browserId);
    if (pins.length && (!lastSession || !samePins(lastSession.pins, pins))) {
      data.sessions.unshift({
        id: crypto.randomUUID(), at: Date.now(), browserId,
        pins: pins.map((p) => ({ url: p.url, title: p.title || '' })),
      });
    }
    const perBrowser = {};
    const perManual = {};
    data.sessions = data.sessions.filter((s) => {
      const t = s.manual ? perManual : perBrowser;
      return (t[s.browserId] = (t[s.browserId] || 0) + 1) <= (s.manual ? 30 : 20);
    }).slice(0, 300);
    if (mutate) mutate(data, { browserId, pins });
    await remoteWrite(data, newCk || ck);
    if (newCk) await storeKey(newCk);
    await save({
      pins, pinsUpdatedAt: updatedAt, remoteBrowsers: data.browsers, sessions: data.sessions, lastSync: Date.now(),
      browserId, browserName, browserNameAt, identityChecked: true, claimName: false,
    });
    await setStatus(adopted ? 'Synced. Pinned tabs updated from Dropbox.' : 'Synced.');
    if (adopted) await applyAll({ removeExtras: true });
    return { adopted };
  } catch (e) {
    await setStatus(`Sync failed: ${e.message}`, true);
    throw e;
  }
}

function scheduleSync() {
  getLocal().then((L) => {
    if (!L.dropbox || !L.settings.autoSync) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow('change').catch(() => {}), 8000);
  });
}

async function setupAlarm() {
  await browser.alarms.clear('sync');
  const L = await getLocal();
  if (L.dropbox && L.settings.autoSync) {
    const m = Math.max(MIN_SYNC_MINUTES, Number(L.settings.syncMinutes) || 120);
    browser.alarms.create('sync', { periodInMinutes: m });
  }
}
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') syncNow('alarm').catch(() => {});
});

/* ---------- messages from the settings page ---------- */

async function getState() {
  const L = await getLocal();
  const mine = { ...(L.remoteBrowsers[L.browserId] || {}), name: L.browserName, pins: L.pins.length };
  if (L.lastSync) mine.lastSync = L.lastSync;
  return {
    redirectUri: browser.identity.getRedirectURL(),
    appKey: L.appKey,
    connected: !!L.dropbox, email: L.dropbox ? L.dropbox.email : null,
    browserId: L.browserId, browserName: L.browserName,
    settings: L.settings, pinCount: L.pins.length,
    browsers: { ...L.remoteBrowsers, [L.browserId]: mine },
    lastSync: L.lastSync, status: L.status,
    enc: { unlocked: !!(await loadKey().catch(() => null)), remoteKind: L.remoteKind || 'unknown' },
    sessions: L.sessions.map((s) => ({ id: s.id, at: s.at, browserId: s.browserId, count: s.pins.length, manual: !!s.manual })),
  };
}

async function handle(msg) {
  const L = await getLocal();
  switch (msg.type) {
    case 'getState':
      return getState();
    case 'connect': {
      const key = String(msg.appKey || '').trim();
      if (!key) throw new Error('Enter your Dropbox app key first.');
      if (key !== L.appKey) await save({ appKey: key, dropbox: null, remoteBrowsers: {}, lastSync: 0, remoteKind: null });
      await connect();
      await setupAlarm();
      try {
        await syncNow('connect');
        await syncNow('connect-verify').catch(() => {});
      } catch (e) { if (!(e instanceof LockedError)) throw e; }
      return getState();
    }
    case 'disconnect':
      await save({ dropbox: null, remoteBrowsers: {}, lastSync: 0, remoteKind: null });
      await browser.alarms.clear('sync');
      await setStatus('Disconnected.');
      return getState();
    case 'syncNow':
      await syncNow('manual');
      return getState();
    case 'unlock': {
      if (!L.dropbox) throw new Error('Connect Dropbox first.');
      const pass = String(msg.passphrase || '');
      if (!pass) throw new Error('Enter a passphrase.');
      const raw = await remoteRead();
      let ck;
      if (isEnvelope(raw)) {
        const iter = clampIter(raw.iter);
        const key = await deriveKey(pass, b64d(raw.salt), iter);
        try { await decryptEnvelope(raw, key); } catch (e) { throw new Error('Wrong passphrase.'); }
        ck = { key, salt: raw.salt, iter };
      } else {
        checkNewPassphrase(pass, msg.confirm);
        ck = await newKeyPair(pass);
      }
      await storeKey(ck);
      await save({ remoteKind: raw == null ? 'none' : (isEnvelope(raw) ? 'encrypted' : 'plain') });
      await syncNow('unlock');
      return getState();
    }
    case 'changePassphrase': {
      if (!L.dropbox) throw new Error('Connect Dropbox first.');
      if (!(await loadKey().catch(() => null))) throw new LockedError(MSG_LOCKED);
      const pass = String(msg.passphrase || '');
      checkNewPassphrase(pass, msg.confirm);
      const newCk = await newKeyPair(pass);
      await syncNow('rekey', null, newCk);
      await setStatus('Passphrase changed. Other browsers need the new passphrase on their next sync.');
      return getState();
    }
    case 'setSettings': {
      const s = { ...L.settings, ...msg.settings };
      s.syncMinutes = Math.max(MIN_SYNC_MINUTES, Math.round(Number(s.syncMinutes)) || 120);
      await save({ settings: s });
      await setupAlarm();
      if (s.sameInEveryWindow && !L.settings.sameInEveryWindow) await applyAll({ removeExtras: false });
      return getState();
    }
    case 'renameBrowser': {
      const name = String(msg.name || '').trim().slice(0, 60);
      if (!name) throw new Error('The name cannot be empty.');
      if (msg.id === L.browserId) {
        await save({ browserName: name, browserNameAt: Date.now(), browserNamed: true, claimName: true });
        if (L.dropbox) await syncNow('rename');
      } else {
        await syncNow('rename', (d) => {
          if (d.browsers[msg.id]) { d.browsers[msg.id].name = name; d.browsers[msg.id].nameAt = Date.now(); }
        });
      }
      return getState();
    }
    case 'addStartup': {
      const name = String(msg.name || '').trim().slice(0, 60);
      if (!name) throw new Error('Enter a name for the new startup.');
      if (!L.dropbox) throw new Error('Connect Dropbox first so the new startup can sync.');
      const id = crypto.randomUUID();
      const now = Date.now();
      await syncNow('addStartup', (d) => {
        d.browsers[id] = { name, nameAt: now, manual: true, pins: 0, lastSync: 0, createdAt: now };
      });
      return getState();
    }
    case 'addBrowser': {
      const name = cleanName(String(msg.name || '').trim().slice(0, 60)) || String(msg.name || '').trim().slice(0, 60);
      if (!name) throw new Error('Enter a name for the new browser.');
      if (!L.dropbox) throw new Error('Connect Dropbox first so the new browser can sync.');
      const sid = msg.startupId ? String(msg.startupId) : null;
      const id = crypto.randomUUID();
      const now = Date.now();
      await syncNow('addBrowser', (d) => {
        if (sid && !(d.browsers[sid] && d.browsers[sid].manual)) throw new Error('That Startup no longer exists.');
        d.browsers[id] = { name, nameAt: now, pins: 0, lastSync: 0, createdAt: now, added: true };
        if (sid) d.browsers[id].startupId = sid;
      });
      return getState();
    }
    case 'setStartupOrder': {
      if (!L.dropbox) throw new Error('Connect Dropbox first so the order can sync.');
      const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
      await syncNow('setStartupOrder', (d) => {
        const rest = Object.entries(d.browsers).filter(([id, b]) => b.manual && !ids.includes(id))
          .sort((a, b) => (a[1].order ?? 1e15) - (b[1].order ?? 1e15) || (a[1].name || '').localeCompare(b[1].name || ''))
          .map(([id]) => id);
        [...ids.filter((id) => d.browsers[id] && d.browsers[id].manual), ...rest].forEach((id, k) => { d.browsers[id].order = k; });
      });
      return getState();
    }
    case 'moveStartup': {
      if (!L.dropbox) throw new Error('Connect Dropbox first so the order can sync.');
      await syncNow('moveStartup', (d) => {
        const list = Object.entries(d.browsers).filter(([, b]) => b.manual)
          .sort((a, b) => (a[1].order ?? 1e15) - (b[1].order ?? 1e15) || (a[1].name || '').localeCompare(b[1].name || ''));
        const i = list.findIndex(([id]) => id === msg.id);
        const j = i + (msg.dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        list.forEach(([id], k) => { d.browsers[id].order = k; });
      });
      return getState();
    }
    case 'assignBrowser': {
      if (!L.dropbox) throw new Error('Connect Dropbox first so the assignment can sync.');
      const sid = msg.startupId ? String(msg.startupId) : null;
      await syncNow('assign', (d) => {
        if (sid && !(d.browsers[sid] && d.browsers[sid].manual)) throw new Error('That Startup no longer exists.');
        const b = d.browsers[msg.id];
        if (!b || b.manual) throw new Error('That browser is no longer listed.');
        if (sid) b.startupId = sid; else delete b.startupId;
      });
      return getState();
    }
    case 'saveSession': {
      if (!L.dropbox) throw new Error('Connect Dropbox first so the session can be saved.');
      if (msg.id !== L.browserId) throw new Error('A session can only be saved from the browser itself.');
      await syncNow('saveSession', (d, c) => {
        if (!c.pins.length) throw new Error('This browser has no pinned tabs to save.');
        const same = d.sessions.find((x) => x.browserId === c.browserId && samePins(x.pins, c.pins));
        if (same) { same.manual = true; same.at = Date.now(); return; }
        d.sessions.unshift({
          id: crypto.randomUUID(), at: Date.now(), browserId: c.browserId, manual: true,
          pins: c.pins.map((p) => ({ url: p.url, title: p.title || '' })),
        });
      });
      await setStatus('Session saved.');
      return getState();
    }
    case 'restoreSession': {
      const s = L.sessions.find((x) => x.id === msg.sessionId);
      if (!s) throw new Error('That saved session is no longer available. Click Sync now and try again.');
      suppress(8000);
      await save({ pins: s.pins.map((p) => ({ url: p.url, title: p.title || '' })), pinsUpdatedAt: Date.now() });
      const L2 = await getLocal();
      for (const w of await normalWindows()) await reconcileWindow(w, L2.pins, { removeExtras: true });
      if (L.dropbox) await syncNow('restore');
      await setStatus(`Restored ${s.pins.length} pinned tabs from the session saved ${new Date(s.at).toLocaleString()}.`);
      return getState();
    }
    case 'forgetBrowser':
      if (msg.id === L.browserId) throw new Error('You cannot forget the browser you are using.');
      await syncNow('forget', (d) => {
        delete d.browsers[msg.id];
        if (d.pinsBy) delete d.pinsBy[msg.id];
        d.sessions = (d.sessions || []).filter((s) => s.browserId !== msg.id);
      });
      return getState();
    default:
      throw new Error('Unknown message');
  }
}

browser.runtime.onMessage.addListener((msg) =>
  handle(msg).catch((e) => ({ error: String((e && e.message) || e) })));

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

(async () => {
  await ensureIdentity();
  await setupAlarm();
  await startup();
})().catch(console.error);
