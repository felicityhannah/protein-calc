/** Account-scoped Supabase adapter. No legacy browser passwords are read here. */
const SDK_PATH = './vendor/supabase-2.118.0.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 500;
let sdkPromise;

export function validateCloudConfig(config = {}) {
  const url = String(config.supabaseUrl || '').trim();
  const publicKey = String(config.supabasePublicKey || '').trim();
  if (!url && !publicKey) return { configured: false, url: '', publicKey: '' };
  if (!url || !publicKey) throw new Error('Set both the Supabase project URL and its public publishable/anon key.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('The Supabase project URL is invalid.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('Use the HTTPS Supabase project URL without a path or credentials.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publicKey)) {
    try {
      const parts = publicKey.split('.');
      if (parts.length !== 3) throw new Error();
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role !== 'anon') throw new Error();
    } catch {
      throw new Error('Only a public publishable key or legacy anon key is allowed in browser code. Never use a secret/service-role key.');
    }
  }
  return { configured: true, url: parsed.origin, publicKey };
}

function numberInRange(value, name, min, max) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`${name} must be a number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return number;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use a valid calendar date.');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > '2199-12-31') {
    throw new Error('Use a valid calendar date between 1900 and 2199.');
  }
  return value;
}

export function normalizeCloudEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('A food entry is required.');
  const food = typeof entry.food === 'string' ? entry.food.trim() : '';
  if (!food || food.length > 120 || /[\u0000-\u001f\u007f]/.test(food)) throw new Error('Food names must contain 1–120 characters.');
  const amount = Math.round(numberInRange(entry.amount, 'Serving weight', 0.1, 2000) * 1000) / 1000;
  const p100 = Math.round(numberInRange(entry.p100, 'Protein per 100 g', 0, 100) * 1000) / 1000;
  const date = validDate(entry.date);
  const ts = entry.ts == null ? Date.now() : numberInRange(entry.ts, 'Entry timestamp', 0, Date.parse('2199-12-31T23:59:59.999Z'));
  const id = entry.id == null ? globalThis.crypto.randomUUID() : String(entry.id);
  if (!UUID.test(id)) throw new Error('Food entry IDs must be UUIDs.');
  return { id, food, amount, p100, protein: Math.round((amount * p100 / 100 + Number.EPSILON) * 100) / 100, date, ts };
}

function dbRow(entry, userId, legacyKey = null) {
  return {
    id: entry.id, user_id: userId, food: entry.food, amount: entry.amount, p100: entry.p100,
    entry_date: entry.date, created_at: new Date(entry.ts).toISOString(), legacy_key: legacyKey,
  };
}

function uiEntry(row) {
  return {
    id: row.id, food: row.food, amount: Number(row.amount), p100: Number(row.p100),
    protein: Number(row.protein), date: row.entry_date, ts: Date.parse(row.created_at),
  };
}

function ensureResult(result) {
  if (result.error) throw result.error;
  return result.data;
}

function emailInput(value) {
  const email = String(value || '').trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  return email;
}

function passwordInput(value, creating = true) {
  const password = typeof value === 'string' ? value : '';
  if (password.length > 128 || password.length < (creating ? 12 : 1)) {
    throw new Error(creating ? 'Use a password with 12–128 characters.' : 'Enter your password (up to 128 characters).');
  }
  return password;
}

async function sdkFactory() {
  if (globalThis.supabase?.createClient) return globalThis.supabase.createClient;
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      if (typeof document === 'undefined') { reject(new Error('The Supabase SDK needs a browser.')); return; }
      const script = document.createElement('script');
      script.src = new URL(SDK_PATH, import.meta.url).href;
      script.async = true;
      script.onload = () => globalThis.supabase?.createClient
        ? resolve(globalThis.supabase.createClient)
        : reject(new Error('The Supabase SDK did not load.'));
      script.onerror = () => { sdkPromise = null; reject(new Error('The account service could not load. Please refresh.')); };
      document.head.append(script);
    });
  }
  return sdkPromise;
}

async function digest(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * onAuthChange(user|null, event) is always invoked outside Supabase's auth lock.
 * onRemoteChange() signals a completed local write; the UI also refreshes on focus.
 * clientFactory and redirectUrl are injectable for tests; production uses the vendored SDK.
 */
export function createCloudStore(config, { onAuthChange, onRemoteChange, clientFactory, redirectUrl } = {}) {
  const settings = validateCloudConfig(config);
  let client;
  let session = null;
  let subscription;
  let initialized;
  let disposed = false;
  let authRevision = 0;
  const timers = new Set();

  function later(callback) {
    const timer = setTimeout(() => { timers.delete(timer); if (!disposed) callback(); }, 0);
    timers.add(timer);
  }

  function notify() { if (onRemoteChange) later(() => onRemoteChange()); }

  async function init() {
    if (disposed) throw new Error('The account connection has been closed.');
    if (!settings.configured) return null;
    if (!initialized) {
      initialized = (async () => {
        const factory = clientFactory || await sdkFactory();
        if (disposed) throw new Error('The account connection has been closed.');
        client = factory(settings.url, settings.publicKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        const listener = client.auth.onAuthStateChange((event, nextSession) => {
          session = nextSession;
          authRevision++;
          later(() => onAuthChange?.(nextSession?.user || null, event));
        });
        subscription = listener.data.subscription;
        const revision = authRevision;
        const result = await client.auth.getSession();
        ensureResult(result);
        if (authRevision === revision) session = result.data.session;
        return session;
      })().catch(error => {
        subscription?.unsubscribe();
        initialized = null;
        throw error;
      });
    }
    await initialized;
    return session;
  }

  async function account() {
    // Bind a user-initiated operation to the owner present before yielding.
    // A queued initialization must not silently move that operation to a new user.
    const previousOwner = session?.user?.id;
    await init();
    if (!settings.configured) throw new Error('Cloud accounts are not connected yet.');
    const id = session?.user?.id;
    if (previousOwner && previousOwner !== id) throw new Error('Your account changed. Please retry from the current account.');
    if (!id || !UUID.test(id)) throw new Error('Sign in to save and sync your tracker.');
    return id;
  }

  function requireSameAccount(userId) {
    if (disposed || session?.user?.id !== userId) throw new Error('Your account changed. Please retry from the current account.');
  }

  async function authClient() {
    await init();
    if (!settings.configured) throw new Error('Cloud accounts are not connected yet.');
    return client.auth;
  }

  function callbackUrl(recovery = false) {
    const value = redirectUrl || (globalThis.location ? `${location.origin}${location.pathname}` : 'http://localhost:4173/');
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    if (recovery) url.searchParams.set('reset', '1');
    return url.href;
  }

  async function addEntries(entries) {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) throw new Error('Add between 1 and 100 foods at a time.');
    const normalized = entries.map(normalizeCloudEntry);
    if (new Set(normalized.map(entry => entry.id)).size !== normalized.length) throw new Error('Each food entry needs a unique ID.');
    const userId = await account();
    // A retry retains the original UUIDs. DO NOTHING preserves committed rows
    // after a lost response, without updating or replacing anyone's history.
    const result = await client.from('protein_entries')
      .upsert(normalized.map(entry => dbRow(entry, userId)), { onConflict: 'id', ignoreDuplicates: true });
    ensureResult(result);
    notify();
    return normalized;
  }

  return {
    configured: settings.configured,
    init,
    async signUp(email, password) {
      const payload = { email: emailInput(email), password: passwordInput(password), options: { emailRedirectTo: callbackUrl() } };
      const auth = await authClient();
      const data = ensureResult(await auth.signUp(payload));
      return { needsEmailConfirmation: !data.session };
    },
    async signIn(email, password) {
      const payload = { email: emailInput(email), password: passwordInput(password, false) };
      const auth = await authClient();
      ensureResult(await auth.signInWithPassword(payload));
    },
    async signOut() {
      const auth = await authClient();
      ensureResult(await auth.signOut({ scope: 'local' }));
      session = null;
    },
    async requestPasswordReset(email) {
      const address = emailInput(email);
      const auth = await authClient();
      ensureResult(await auth.resetPasswordForEmail(address, { redirectTo: callbackUrl(true) }));
    },
    async updatePassword(password) {
      const value = passwordInput(password);
      await account();
      ensureResult(await client.auth.updateUser({ password: value }));
    },
    async load() {
      const userId = await account();
      const profile = ensureResult(await client.from('profiles').select('goal').eq('id', userId).maybeSingle());
      const entries = [];
      // A stable order and explicit pages avoid Supabase's default 1,000-row cap.
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = ensureResult(await client.from('protein_entries')
          .select('id,food,amount,p100,protein,entry_date,created_at')
          .eq('user_id', userId).order('created_at', { ascending: true }).order('id', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1));
        entries.push(...rows.map(uiEntry));
        if (rows.length < PAGE_SIZE) break;
      }
      if (session?.user?.id !== userId) throw new Error('Your account changed. Please refresh the tracker.');
      return { goal: Number(profile?.goal ?? 120), entries };
    },
    async saveGoal(goal) {
      const value = numberInRange(goal, 'Daily goal', 40, 500);
      const userId = await account();
      // DO NOTHING on an existing profile; never reset another device's current goal.
      ensureResult(await client.from('profiles').upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true }));
      ensureResult(await client.from('profiles').update({ goal: Math.round(value * 10) / 10 }).eq('id', userId));
      notify();
    },
    addEntries,
    async addEntry(entry) { return (await addEntries([entry]))[0]; },
    async deleteEntry(id) {
      if (!UUID.test(String(id))) throw new Error('Food entry IDs must be UUIDs.');
      const userId = await account();
      ensureResult(await client.from('protein_entries').delete().eq('user_id', userId).eq('id', id));
      notify();
    },
    async importEntries(entries, sourceName = 'legacy-browser') {
      if (!Array.isArray(entries) || entries.length > 20000) throw new Error('Import up to 20,000 food entries at a time.');
      if (typeof sourceName !== 'string' || !sourceName.trim() || sourceName.length > 200) throw new Error('A valid import source name is required.');
      const userId = await account();
      const occurrences = new Map();
      const prepared = await Promise.all(entries.map(async entry => {
        const date = validDate(entry?.date);
        // Cloud IDs are new even when the local row already has a UUID. This lets
        // two users explicitly import the same device's rows without PK clashes.
        const normalized = normalizeCloudEntry({ ...entry, id: undefined,
          ts: entry?.ts == null ? Date.parse(`${date}T12:00:00Z`) : entry.ts });
        // Ignore generated IDs and passwords; repeated imports get identical keys.
        const canonical = JSON.stringify([sourceName, normalized.food, normalized.amount, normalized.p100, normalized.date, normalized.ts]);
        const occurrence = occurrences.get(canonical) || 0;
        occurrences.set(canonical, occurrence + 1);
        const legacyKey = `legacy:v1:${await digest(`${canonical}:${occurrence}`)}`;
        return { normalized, legacyKey };
      }));
      requireSameAccount(userId);
      let imported = 0;
      // Each batch is atomic. Retrying a partially completed import is safe.
      for (let offset = 0; offset < prepared.length; offset += 100) {
        requireSameAccount(userId);
        const batch = prepared.slice(offset, offset + 100).map(({ normalized, legacyKey }) => dbRow(normalized, userId, legacyKey));
        const rows = ensureResult(await client.from('protein_entries')
          .upsert(batch, { onConflict: 'user_id,legacy_key', ignoreDuplicates: true }).select('id'));
        imported += rows.length;
      }
      notify();
      return { imported, skipped: prepared.length - imported };
    },
    async clearEntries() {
      const userId = await account();
      ensureResult(await client.from('protein_entries').delete().eq('user_id', userId));
      notify();
    },
    dispose() {
      disposed = true;
      subscription?.unsubscribe();
      client?.auth.stopAutoRefresh();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      session = null;
    },
  };
}
