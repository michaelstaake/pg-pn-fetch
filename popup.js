const api = typeof browser !== "undefined" ? browser : chrome;

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
          <div class="pn">${esc(item.realPn)}</div>
          <div class="meta">${esc(item.brand)} · PartsGeek ${esc(item.internalSku || item.suffix)}</div>
          <div class="meta">${esc(formatDate(item.savedAt))}</div>
        </div>
        <div>
          <button type="button" data-copy="${esc(item.realPn)}">Copy</button>
          <button type="button" data-key="${esc(item.key)}">Remove</button>
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
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1000);
    } catch (error) {
      button.textContent = "Failed";
    }
  }
  if (button.dataset.key) {
    await api.runtime.sendMessage({ type: "deleteLookup", key: button.dataset.key });
    await refresh();
  }
});

refresh();
