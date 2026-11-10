const api = typeof browser !== "undefined" ? browser : chrome;

const COPY_ICON = `<svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON = `<svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>`;

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const filterEl = document.getElementById("filter");
const clearEl = document.getElementById("clear");

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    return "";
  }
}

function lookupTitle(item) {
  return [item.brand, item.realPn].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
}

async function loadLookups() {
  const data = await api.runtime.sendMessage({ type: "getCache" });
  return Object.values(data || {}).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

function render(items) {
  const query = filterEl.value.trim().toLowerCase();
  const filtered = items.filter((item) => {
    const hay = [item.realPn, item.brand, item.suffix, item.internalSku, item.title, ...(item.interchange || [])]
      .join(" ")
      .toLowerCase();
    return !query || hay.includes(query);
  });

  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", filtered.length > 0 || items.length === 0 ? filtered.length > 0 : false);
  if (!items.length) {
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = "No saved lookups yet. Open a PartsGeek listing and the plugin will start filling this list.";
    return;
  }
  if (!filtered.length) {
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = "No saved lookups match that filter.";
    return;
  }
  emptyEl.classList.add("hidden");

  for (const item of filtered) {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <div class="row">
        <div>
          <div class="pn">${esc(lookupTitle(item))}</div>
          <div class="meta">PartsGeek ${esc(item.internalSku || item.suffix)}</div>
          <div class="meta">${esc(formatDate(item.savedAt))}</div>
        </div>
        <div class="actions">
          <button type="button" class="icon-btn" data-copy="${esc(item.realPn)}" aria-label="Copy" title="Copy">${COPY_ICON}${CHECK_ICON}</button>
          <button type="button" class="icon-btn" data-key="${esc(item.key)}" aria-label="Remove" title="Remove">${TRASH_ICON}</button>
        </div>
      </div>
    `;
    listEl.appendChild(li);
  }
}

async function refresh() {
  const items = await loadLookups();
  render(items);
  listEl.dataset.count = String(items.length);
  listEl._items = items;
}

filterEl.addEventListener("input", () => render(listEl._items || []));

clearEl.addEventListener("click", async () => {
  if (!window.confirm("Clear all saved lookups on this computer?")) return;
  await api.runtime.sendMessage({ type: "clearCache" });
  await refresh();
});

listEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.copy) {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.remove("is-failed");
      button.classList.add("is-copied");
      button.setAttribute("aria-label", "Copied");
      button.title = "Copied";
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", "Copy");
        button.title = "Copy";
      }, 1000);
    } catch (error) {
      button.classList.remove("is-copied");
      button.classList.add("is-failed");
      button.setAttribute("aria-label", "Failed");
      button.title = "Failed";
    }
  }
  if (button.dataset.key) {
    await api.runtime.sendMessage({ type: "deleteLookup", key: button.dataset.key });
    await refresh();
  }
});

refresh();
