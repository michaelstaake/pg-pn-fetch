const api = typeof browser !== "undefined" ? browser : chrome;

// The background page only owns storage. All PartsGeek requests happen in the
// content script so they carry the tab's PartsGeek cookies (including the
// Cloudflare clearance cookie that the site search requires).

api.runtime.onMessage.addListener((message) => {
  if (message?.type === "getCache") return getLookups();
  if (message?.type === "getLookup") return getLookups().then((all) => all[message.key] || null);
  if (message?.type === "saveLookup") return saveLookup(message.entry);
  if (message?.type === "clearCache") return clearCache();
  if (message?.type === "deleteLookup") return deleteLookup(message.key);
  return undefined;
});

// Every write is a read-modify-write of one object, so run them one at a time.
// Without this, several listings finishing together overwrite each other's saves.
let writeChain = Promise.resolve();
function serialized(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

async function getLookups() {
  const data = await api.storage.local.get({ lookups: {} });
  return data.lookups || {};
}

function saveLookup(entry) {
  if (!entry || !entry.realPn || !entry.suffix) return Promise.resolve(entry);
  return serialized(async () => {
    const lookups = await getLookups();
    const key = entry.key || PGRPN.cacheKey(entry.brand, entry.suffix);
    const saved = {
      ...entry,
      key,
      savedAt: entry.savedAt || Date.now(),
    };
    delete saved.cached;
    lookups[key] = saved;
    await api.storage.local.set({ lookups });
    return saved;
  });
}

function deleteLookup(key) {
  return serialized(async () => {
    const lookups = await getLookups();
    delete lookups[key];
    await api.storage.local.set({ lookups });
    return { ok: true };
  });
}

function clearCache() {
  return serialized(async () => {
    await api.storage.local.set({ lookups: {} });
    return { ok: true };
  });
}
