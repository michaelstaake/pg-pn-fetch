(() => {
  if (window.__pgrpnLoaded) return;
  window.__pgrpnLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const MAX_WORKERS = 2;
  const GAP_MS = 300;

  const PART_ALIASES = {
    oxygen_sensor: "O2 Sensor",
    air_fuel_ratio_sensor: "Air Fuel Ratio Sensor",
    liftgate_release_switch: "Liftgate Switch",
    liftgate_latch: "Liftgate Latch",
    door_lock_actuator: "Door Lock Actuator",
  };

  // ---------- request queue ----------

  const queue = [];
  let active = 0;
  let blockedByChallenge = false;

  function enqueue(task) {
    return new Promise((resolve) => {
      queue.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          resolve({ error: String(error && error.message ? error.message : error) });
        }
      });
      pump();
    });
  }

  function pump() {
    while (active < MAX_WORKERS && queue.length) {
      const task = queue.shift();
      active += 1;
      task().finally(() => {
        window.setTimeout(() => {
          active -= 1;
          pump();
        }, GAP_MS);
      });
    }
  }

  // ---------- fetching ----------

  // Firefox: content.fetch() sends the request as the page itself, with the
  // page's cookies and origin, which is what Cloudflare expects.
  async function pageFetch(url) {
    let response;
    try {
      if (typeof content !== "undefined" && content && typeof content.fetch === "function") {
        response = await content.fetch(url);
      }
    } catch (error) {
      response = null;
    }
    if (!response) response = await fetch(url, { credentials: "include" });
    const status = response.status;
    const html = await response.text();
    return { status, html };
  }

  // Search results this tab has already seen, keyed by brand|suffix and by suffix.
  const seenCards = new Map();
  const inflightSearches = new Map();

  function rememberCards(cards) {
    for (const card of cards) {
      if (!card.realPn) continue;
      const byBrand = PGRPN.cacheKey(card.brand, card.suffix);
      if (!seenCards.has(byBrand)) seenCards.set(byBrand, card);
      const list = seenCards.get(`*|${card.suffix}`) || [];
      list.push(card);
      seenCards.set(`*|${card.suffix}`, list);
    }
  }

  function searchUrl(query, page) {
    const url = new URL("/ss/", location.origin);
    url.searchParams.set("ssq", query);
    if (page > 1) url.searchParams.set("page", String(page));
    return url.href;
  }

  async function siteSearch(query, page = 1, force = false) {
    const url = searchUrl(query, page);
    if (force) inflightSearches.delete(url);
    if (inflightSearches.has(url)) return inflightSearches.get(url);
    const job = (async () => {
      const { status, html } = await pageFetch(url);
      if (PGRPN.isChallenge(status, html)) return { challenge: true, url };
      if (status < 200 || status >= 300) return { error: `HTTP ${status}`, url };
      const doc = new DOMParser().parseFromString(html, "text/html");
      const cards = PGRPN.parseSearchCards(doc);
      rememberCards(cards);
      const hasNext = Boolean(doc.querySelector(`a[href*="page=${page + 1}"]`));
      return { cards, hasNext, url };
    })();
    inflightSearches.set(url, job);
    job.finally(() => window.setTimeout(() => inflightSearches.delete(url), 60000));
    return job;
  }

  // Choose the manufacturer number for this suffix from search result cards.
  function pickMatch(suffix, brand) {
    const exact = seenCards.get(PGRPN.cacheKey(brand, suffix));
    if (exact?.realPn) return exact;
    const all = seenCards.get(`*|${suffix}`) || [];
    if (!all.length) return null;
    const counts = new Map();
    for (const card of all) {
      const pn = card.realPn.toUpperCase();
      counts.set(pn, (counts.get(pn) || 0) + 1);
    }
    // Only accept a different brand label when every card agrees on one number.
    if (counts.size !== 1) return null;
    return all[0];
  }

  // ---------- page reading ----------

  function headingValue(root, label) {
    return PGRPN.attributeValue(root, label);
  }

  function partNumberRow(root) {
    for (const heading of root.querySelectorAll(".product-attribute-heading")) {
      if (/part number/i.test(heading.textContent)) return heading.parentElement;
    }
    return null;
  }

  function readCard(card) {
    const internal =
      card.querySelector('input[name="part_number"]')?.value ||
      headingValue(card, "part number") ||
      "";
    const altSku = card.querySelector('input[name="alt_sku"]')?.value || "";
    const shownPn = headingValue(card, "part number");
    const brand =
      headingValue(card, "brand") ||
      card.querySelector(".product-title-red")?.textContent?.trim() ||
      "";
    const title = PGRPN.clean(card.querySelector(".product-title")?.textContent);
    return { card, internal: internal.trim(), altSku: altSku.trim(), shownPn, brand: brand.trim(), title };
  }

  function contextFromPage() {
    return PGRPN.parseCatalogPath(location.pathname) || {};
  }

  function titleCaseSlug(value) {
    let text = String(value || "");
    try {
      text = decodeURIComponent(text);
    } catch (error) {
      // keep raw text
    }
    return text
      .replace(/-ar-/g, " & ")
      .replace(/-fs-/g, " / ")
      .replace(/[_-]+/g, " ")
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  }

  function friendlyPartName(partType) {
    const slug = String(partType || "");
    return PART_ALIASES[slug] || titleCaseSlug(slug);
  }

  function readEngine(card) {
    const root = card || document;
    for (const cell of root.querySelectorAll(".application-content")) {
      const match = cell.textContent.match(/(\d+(?:\.\d+)?)\s*L\b/i);
      if (match) return match[1];
    }
    return "";
  }

  function describeListing(card, brand) {
    const ctx = contextFromPage();
    const year = ctx.year || "";
    const make = titleCaseSlug(ctx.make);
    const model = titleCaseSlug(ctx.model);
    const engine = readEngine(card);
    const position = card ? headingValue(card, "position") : "";
    const part = ctx.partType ? friendlyPartName(ctx.partType) : "";
    const bits = [brand, year, make, model, engine, position, part].filter(Boolean);
    if (year && part) return bits.join(" ");

    const productTitle = PGRPN.clean(card?.querySelector(".product-title")?.textContent || document.title || "")
      .replace(/\s*-\s*PartsGeek.*$/i, "")
      .trim();
    return productTitle;
  }

  function googleSearchUrl(query) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }

  // ---------- rendering (look unchanged from 0.3) ----------

  function ensurePanel(card) {
    let panel = card.querySelector(".pgrpn-panel");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "pgrpn-panel";
    panel.setAttribute("aria-live", "polite");
    const row = partNumberRow(card);
    if (row) {
      row.insertAdjacentElement("afterend", panel);
    } else {
      const info = card.querySelector(".product-info") || card;
      info.appendChild(panel);
    }
    return panel;
  }

  function renderPanel(panel, state) {
    panel.textContent = "";
    panel.classList.remove("pgrpn-ok", "pgrpn-fail", "pgrpn-loading");
    const line = document.createElement("div");
    line.className = "pgrpn-line";

    const icon = (kind, symbol) => {
      const el = document.createElement("span");
      el.className = `pgrpn-icon pgrpn-icon-${kind}`;
      el.setAttribute("aria-hidden", "true");
      if (symbol) el.textContent = symbol;
      return el;
    };

    const textLink = (label, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pgrpn-link";
      btn.textContent = label;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return btn;
    };

    const anchor = (label, href) => {
      const link = document.createElement("a");
      link.className = "pgrpn-link";
      link.href = href || "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = label;
      return link;
    };

    const text = (value) => {
      const el = document.createElement("span");
      el.className = "pgrpn-text";
      el.textContent = value;
      return el;
    };

    if (state.status === "ready" && state.realPn) {
      panel.classList.add("pgrpn-ok");
      const value = document.createElement("span");
      value.className = "pgrpn-real";
      value.textContent = state.realPn;
      if (state.sourceLabel) panel.title = `Manufacturer # ${state.realPn} (${state.sourceLabel})`;
      const copy = textLink("Copy", async () => {
        try {
          await navigator.clipboard.writeText(state.realPn);
          copy.textContent = "Copied";
          window.setTimeout(() => {
            copy.textContent = "Copy";
          }, 1200);
        } catch (error) {
          copy.textContent = "Copy failed";
        }
      });
      line.append(icon("ok", "✓"), value, copy);
    } else if (state.status === "loading") {
      panel.classList.add("pgrpn-loading");
      line.append(icon("spin"), text("Fetching..."));
    } else if (state.status === "challenge") {
      panel.classList.add("pgrpn-fail");
      panel.title = "PartsGeek wants a quick security check before its search can be used. Open the check, finish it, then click Try again.";
      line.append(
        icon("fail", "✕"),
        text("Security check"),
        anchor("Open check", state.checkHref),
        textLink("Try again", () => state.onRetry && state.onRetry())
      );
    } else if (state.status === "missing") {
      panel.classList.add("pgrpn-fail");
      panel.title = state.reason || "";
      line.append(
        icon("fail", "✕"),
        text("Failed to fetch"),
        textLink("Try again", () => state.onRetry && state.onRetry()),
        anchor("Google it", state.searchHref)
      );
    } else if (state.message) {
      line.append(text(state.message));
    }
    panel.appendChild(line);
  }

  // ---------- storage ----------

  async function saveEntry(entry) {
    if (!entry?.realPn || !entry.suffix) return entry;
    try {
      return (await api.runtime.sendMessage({ type: "saveLookup", entry })) || entry;
    } catch (error) {
      return entry;
    }
  }

  async function cachedEntry(key) {
    try {
      const hit = await api.runtime.sendMessage({ type: "getLookup", key });
      return hit?.realPn ? { ...hit, cached: true } : null;
    } catch (error) {
      return null;
    }
  }

  // ---------- resolving ----------

  async function resolveListing({ brand, suffix, internal, title, altSku, shownPn, force }) {
    const key = PGRPN.cacheKey(brand, suffix);
    const base = { key, brand, suffix, internalSku: internal, title };

    // Search pages (and some listings) already show the manufacturer number.
    const direct = [altSku, shownPn].find((value) => PGRPN.looksLikePn(value));
    if (direct) {
      return saveEntry({ ...base, realPn: direct, interchange: [], source: "listing", sourceUrl: location.href });
    }

    if (!force) {
      const cached = await cachedEntry(key);
      if (cached) return cached;
    }

    const earlier = force ? null : pickMatch(suffix, brand);
    if (earlier) {
      return saveEntry({ ...base, realPn: earlier.realPn, interchange: [], source: "site-search", sourceUrl: searchUrl(suffix) });
    }

    // Search on the 8-digit product suffix first; it is the most precise query.
    // The search is fuzzy, so only cards whose own SKU ends in this suffix count.
    const attempts = [
      [suffix, 1],
      [internal, 1],
      [`${brand} ${suffix}`, 1],
    ];
    let sawResults = false;
    for (let i = 0; i < attempts.length; i += 1) {
      const [query, page] = attempts[i];
      if (!query || !query.trim()) continue;
      const result = await siteSearch(query.trim(), page, force);
      if (result.challenge) return { ...base, realPn: null, challenge: true };
      if (result.error) continue;
      sawResults = sawResults || result.cards.length > 0;
      const match = pickMatch(suffix, brand);
      if (match) {
        return saveEntry({ ...base, realPn: match.realPn, interchange: [], source: "site-search", sourceUrl: result.url });
      }
      // The match may sit on page 2 of the suffix search.
      if (i === 0 && result.hasNext) attempts.splice(1, 0, [suffix, 2]);
    }

    return {
      ...base,
      realPn: null,
      reason: sawResults
        ? "PartsGeek's search has no manufacturer number for this listing (it only lists its own code)."
        : "PartsGeek's search did not return this listing.",
    };
  }

  function sourceLabel(entry) {
    if (entry.cached) return "saved lookup";
    if (entry.source === "title" || entry.source === "meta") return "from this page";
    if (entry.source === "site-search") return "from PartsGeek search";
    if (entry.source === "listing") return "shown in listing data";
    return "found";
  }

  // ---------- wiring ----------

  const challenged = new Set();

  function retryChallenged() {
    blockedByChallenge = false;
    const runs = [...challenged];
    challenged.clear();
    runs.forEach((run) => run(true));
  }

  function enhanceCard(card) {
    if (card.dataset.pgrpnBound === "1") return;
    const info = readCard(card);
    const parsed = PGRPN.parseInternalSku(info.internal) || PGRPN.parseInternalSku(info.altSku);
    if (!info.brand && !parsed) return;
    card.dataset.pgrpnBound = "1";
    const panel = ensurePanel(card);

    if (!parsed) {
      const realPn = [info.altSku, info.shownPn, info.internal].find((value) => PGRPN.looksLikePn(value));
      if (realPn) renderPanel(panel, { status: "ready", realPn, sourceLabel: "shown in listing data" });
      else panel.remove();
      return;
    }

    const run = (force = false) => {
      renderPanel(panel, { status: "loading" });
      const job = blockedByChallenge
        ? Promise.resolve({ challenge: true })
        : enqueue(() =>
            blockedByChallenge
              ? { challenge: true }
              : resolveListing({ ...info, suffix: parsed.suffix, internal: parsed.full, force })
          );
      job.then((result) => {
        if (result?.realPn) {
          renderPanel(panel, {
            status: "ready",
            realPn: result.realPn,
            sourceLabel: sourceLabel(result),
          });
        } else if (result?.challenge) {
          blockedByChallenge = true;
          challenged.add(run);
          renderPanel(panel, {
            status: "challenge",
            checkHref: searchUrl(parsed.suffix),
            onRetry: retryChallenged,
          });
        } else {
          renderPanel(panel, {
            status: "missing",
            reason: result?.reason || result?.error || "",
            searchHref: googleSearchUrl(describeListing(card, info.brand)),
            onRetry: () => run(true),
          });
        }
      });
    };

    run();
  }

  function enhanceDetailPage() {
    const card = document.querySelector(".product.dp-product, .product");
    if (!card || card.dataset.pgrpnBound === "1") return false;
    const extracted = PGRPN.extractFromDocument(document);
    if (!extracted.realPn || !extracted.suffix) return false;
    card.dataset.pgrpnBound = "1";
    const brand = extracted.brand || headingValue(card, "brand");
    saveEntry({
      key: PGRPN.cacheKey(brand, extracted.suffix),
      brand,
      suffix: extracted.suffix,
      internalSku: extracted.internalSku,
      realPn: extracted.realPn,
      interchange: extracted.interchange || [],
      source: extracted.source || "title",
      sourceUrl: location.href,
      title: extracted.title,
    });
    renderPanel(ensurePanel(card), {
      status: "ready",
      realPn: extracted.realPn,
      sourceLabel: "from this page",
    });
    return true;
  }

  function enhanceAll() {
    if (PGRPN.isSeoPath(location.pathname)) enhanceDetailPage();
    document.querySelectorAll(".product").forEach((card) => {
      if (card.querySelector('input[name="part_number"]')) enhanceCard(card);
    });
  }

  function start() {
    enhanceAll();
    let scheduled = 0;
    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) =>
        [...mutation.addedNodes].some(
          (node) => node.nodeType === 1 && !node.closest?.(".pgrpn-panel") && !node.classList?.contains("pgrpn-panel")
        )
      );
      if (!relevant || scheduled) return;
      scheduled = window.setTimeout(() => {
        scheduled = 0;
        enhanceAll();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  start();
})();
