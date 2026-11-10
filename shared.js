(function (global) {
  // PartsGeek internal SKUs look like 143530-02358171 or 92779-03642776.
  // The first half changes per vehicle application; the last 8 digits identify the product.
  const INTERNAL_SKU = /^(\d{2,7})-(\d{8})$/;

  function isInternalSku(value) {
    return INTERNAL_SKU.test(String(value || "").trim());
  }

  function parseInternalSku(value) {
    const match = String(value || "").trim().match(INTERNAL_SKU);
    return match ? { prefix: match[1], suffix: match[2], full: match[0] } : null;
  }

  // Warehouse codes such as W0133-2097268 are not manufacturer numbers.
  function isWarehouseCode(value) {
    return /^W\d{4}-/i.test(String(value || "").trim());
  }

  function looksLikePn(value) {
    const text = String(value || "").trim();
    if (text.length < 3 || text.length > 24) return false;
    if (isInternalSku(text)) return false;
    if (isWarehouseCode(text)) return false;
    if (/^(rear|front|left|right|upper|lower|inner|outer|center|middle|partsgeek)/i.test(text)) {
      return false;
    }
    if (!/\d/.test(text)) return false;
    return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(text);
  }

  function cacheKey(brand, suffix) {
    return `${String(brand || "").trim().toLowerCase()}|${String(suffix || "").trim()}`;
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  // "2002-2018 Ford Explorer Liftgate Release Switch - Dorman 901-209 - PartsGeek.com"
  function extractFromTitle(title, brand) {
    if (!title) return null;
    const text = clean(title);

    if (brand) {
      const re = new RegExp(`(?:^|\\s-\\s)${escapeRegExp(brand)}\\s+([A-Za-z0-9][A-Za-z0-9._\\/-]*)(?:\\s+-\\s|$)`, "i");
      const match = text.match(re);
      if (match && looksLikePn(match[1])) {
        return { brand: String(brand).trim(), realPn: match[1].trim(), source: "title" };
      }
    }

    const parts = text
      .split(" - ")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/partsgeek/i.test(part));

    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const match = parts[i].match(/^(.+?)\s+(\S+)$/);
      if (match && looksLikePn(match[2]) && !/\d{4}/.test(match[1])) {
        return { brand: match[1].trim(), realPn: match[2].trim(), source: "title" };
      }
    }
    return null;
  }

  // "... FLAT RATE SHIPPING on most Dorman 901-209 orders."
  function extractFromMeta(description) {
    if (!description) return null;
    const match = description.match(/on most\s+(.+?)\s+([A-Za-z0-9][A-Za-z0-9._\/-]*)\s+orders/i);
    if (match && looksLikePn(match[2])) {
      return { brand: match[1].trim(), realPn: match[2].trim(), source: "meta" };
    }
    return null;
  }

  function parseInterchange(text) {
    if (!text) return [];
    const seen = new Set();
    return text
      .split(/[,;]+/)
      .map((item) => item.trim())
      .filter((item) => item && item.length < 32)
      .filter((item) => {
        const key = item.toUpperCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function attributeValue(root, label) {
    const want = label.toLowerCase();
    for (const heading of root.querySelectorAll(".product-attribute-heading")) {
      const name = heading.textContent.replace(":", "").trim().toLowerCase();
      if (name !== want) continue;
      const row = heading.parentElement;
      const content = row?.querySelector(".product-attribute-content");
      if (content) return clean(content.textContent);
      return clean((row?.textContent || "").replace(heading.textContent, ""));
    }
    return "";
  }

  // Product detail ("SEO") pages carry the real number in the title and meta description.
  function extractFromDocument(doc) {
    const title = doc.querySelector("title")?.textContent || "";
    const meta = doc.querySelector('meta[name="description"]')?.getAttribute("content") || "";
    const interchange = parseInterchange(
      doc.querySelector(".attribute-value-interchange")?.textContent || ""
    );
    const hiddenSku =
      doc.querySelector('.product-form input[name="part_number"]')?.value ||
      doc.querySelector('input[name="part_number"]')?.value ||
      "";
    const parsed = parseInternalSku(hiddenSku);
    const pageBrand = attributeValue(doc, "brand");
    const fromMeta = extractFromMeta(meta);
    const fromTitle = extractFromTitle(title, pageBrand || fromMeta?.brand);
    const hit = fromTitle || fromMeta;

    return {
      realPn: hit?.realPn || null,
      brand: pageBrand || hit?.brand || null,
      interchange,
      internalSku: parsed ? parsed.full : "",
      suffix: parsed ? parsed.suffix : "",
      source: hit?.source || null,
      title: clean(title),
    };
  }

  // Result cards from PartsGeek's own site search (/ss/?ssq=...).
  // On search pages, part_number holds the internal SKU and alt_sku holds the
  // manufacturer number that the card displays as "Part Number:".
  function parseSearchCards(doc) {
    const out = [];
    doc.querySelectorAll(".product").forEach((card) => {
      const internal = card.querySelector('input[name="part_number"]')?.value || "";
      const parsed = parseInternalSku(internal);
      if (!parsed) return;
      const alt = clean(card.querySelector('input[name="alt_sku"]')?.value);
      const shown = attributeValue(card, "part number");
      const realPn = [alt, shown].find((value) => looksLikePn(value)) || "";
      out.push({
        internalSku: parsed.full,
        suffix: parsed.suffix,
        realPn,
        brand: attributeValue(card, "brand"),
        title: clean(card.querySelector(".product-title")?.textContent),
      });
    });
    return out;
  }

  function isChallenge(status, html) {
    if (status === 403 || status === 503 || status === 429) {
      if (/just a moment|challenge-platform|cf-chl|performing security verification|attention required/i.test(html || "")) {
        return true;
      }
    }
    return /<title>\s*just a moment/i.test(html || "");
  }

  function isSeoPath(pathname) {
    if (/^\/(catalog|brands|ymm|ym|ss|search|cart|makes|models|assets|css|js|images|blog)\b/i.test(pathname)) {
      return false;
    }
    // Detail page codes are short base-36 strings such as 1x6h3ms and always contain a digit.
    const match = String(pathname || "").match(/^\/([a-z0-9]{5,10})-.+\.html$/i);
    return Boolean(match && /\d/.test(match[1]));
  }

  function isSeoUrl(url) {
    try {
      const parsed = new URL(url);
      if (!/(^|\.)partsgeek\.com$/i.test(parsed.hostname)) return false;
      return isSeoPath(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function parseCatalogPath(pathname) {
    const match = String(pathname || "").match(
      /\/catalog\/(\d{4})\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.html/i
    );
    if (!match) return null;
    return {
      year: match[1],
      make: match[2],
      model: match[3],
      category: match[4],
      partType: match[5],
    };
  }

  global.PGRPN = {
    isInternalSku,
    parseInternalSku,
    isWarehouseCode,
    looksLikePn,
    cacheKey,
    clean,
    extractFromTitle,
    extractFromMeta,
    parseInterchange,
    attributeValue,
    extractFromDocument,
    parseSearchCards,
    isChallenge,
    isSeoPath,
    isSeoUrl,
    parseCatalogPath,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
