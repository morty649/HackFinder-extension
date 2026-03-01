const MLH_SEASON_URL = (season) => `https://www.mlh.com/seasons/${season}/events`;
const AGGREGATED_SOURCE_CACHE_KEY = "hf_aggregated_source_cache_v1";
const AGGREGATED_SOURCE_HTML = "https://devpost.com/hackathons";
const AGGREGATED_SOURCE_API = "https://devpost.com/api/hackathons";
const AGGREGATED_SOURCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const SOURCE_CONFIG = {
  eventbriteApiToken: "",
  meetupApiToken: "",
  mlhApiUrl: "",
  hackathonComApiUrl: "",
  hackerEarthApiUrl: ""
};

const DOMAIN_TAGS = {
  "AI/ML": ["ai", "machine-learning", "ml", "deep-learning", "artificial-intelligence"],
  "Web3": ["blockchain", "web3", "crypto", "nft", "defi", "ethereum"],
  "HealthTech": ["health", "healthcare", "medical", "biotech", "wellness"],
  "FinTech": ["fintech", "finance", "banking", "payments"],
  "SocialImpact": ["social-good", "nonprofit", "education", "environment", "social"],
  "GameDev": ["gaming", "game-development", "ar", "vr", "xr", "game"],
  "Cybersecurity": ["security", "cybersecurity", "privacy", "hacking"],
  "Mobile": ["mobile", "ios", "android", "react-native"],
  "Open": []
};

const MLH_DOMAINS = new Set(["mlh.com", "www.mlh.com", "mlh.io", "www.mlh.io"]);
const geocodeCache = new Map();

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toAbsoluteUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return "#";
  }
}

function isMlhUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const d of MLH_DOMAINS) {
      if (host === d || host.endsWith(`.${d}`)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function domainKeywords(domains = []) {
  const out = new Set();
  for (const d of domains) {
    const mapped = DOMAIN_TAGS[d] || [String(d).toLowerCase()];
    for (const k of mapped) out.add(String(k).toLowerCase());
  }
  return [...out];
}

function matchesDomains(item, keywords) {
  if (!keywords.length) return true;
  const haystack = [item.title, item.location, item.date, (item.tags || []).join(" ")].join(" ").toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

function dedupeHackathons(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${cleanText(item.title).toLowerCase()}|${cleanText(item.link).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizePlaceToken(text) {
  return cleanText(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function textualLocationMatch(userQuery, eventLocation) {
  const uq = normalizePlaceToken(userQuery);
  const el = normalizePlaceToken(eventLocation);
  if (!uq || !el) return false;
  if (uq === el) return true;
  return uq.length >= 4 && el.includes(uq);
}

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function storageGet(key) {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => resolve(result?.[key] || null));
    });
  }
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function storageSet(key, value) {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

function getFirstText(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el) {
      const text = cleanText(el.textContent || "");
      if (text) return text;
    }
  }
  return "";
}

function getFirstAttr(root, selectors, attr) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el && el.getAttribute(attr)) {
      return cleanText(el.getAttribute(attr));
    }
  }
  return "";
}

function extractTags(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((t) => {
        if (t && typeof t === "object") return cleanText(t.name || t.title || t.slug || "");
        return cleanText(t);
      })
      .filter(Boolean);
  }
  if (raw && typeof raw === "object") {
    const tag = cleanText(raw.name || raw.title || raw.slug || "");
    return tag ? [tag] : [];
  }
  const text = cleanText(raw);
  return text ? [text] : [];
}

function extractLocation(raw) {
  if (typeof raw === "string") return cleanText(raw);
  if (!raw || typeof raw !== "object") return "";
  const parts = [
    raw.city,
    raw.addressLocality,
    raw.region,
    raw.state,
    raw.province,
    raw.addressRegion,
    raw.country,
    raw.addressCountry
  ]
    .map(cleanText)
    .filter(Boolean);
  if (parts.length) return parts.join(", ");
  return cleanText(raw.name || raw.label || raw.display_name || "");
}

function findEventList(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === "object") {
      const keys = new Set(Object.keys(node[0] || {}));
      if (keys.has("name") && (keys.has("location") || keys.has("date_range") || keys.has("url"))) {
        return node;
      }
    }
    for (const item of node) {
      const found = findEventList(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) {
      const found = findEventList(value);
      if (found) return found;
    }
  }
  return null;
}

function normalizeMlhEventPath(url) {
  const fixed = toAbsoluteUrl(url, "https://mlh.io");
  if (!isMlhUrl(fixed)) return fixed;
  try {
    const u = new URL(fixed);
    const match = u.pathname.match(/\/events\/([^/?#]+)/);
    if (match) u.pathname = `/events/${match[1]}`;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return fixed;
  }
}

function findFirstExternalUrl(node) {
  if (!node) return "";
  if (typeof node === "string") {
    const text = cleanText(node);
    if (/^https?:\/\//i.test(text) && !isMlhUrl(text)) return text;
    return "";
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstExternalUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) {
      const found = findFirstExternalUrl(value);
      if (found) return found;
    }
  }
  return "";
}

function chooseMlhEventLink(event) {
  const linkKeys = [
    "official_website",
    "official_website_url",
    "website",
    "website_url",
    "external_url",
    "event_url",
    "hackathon_url",
    "registration_url",
    "apply_url",
    "url",
    "link",
    "path"
  ];

  for (const key of linkKeys) {
    const v = event?.[key];
    const c = typeof v === "object" ? cleanText(v?.url || v?.href || v?.link || "") : cleanText(v || "");
    if (!c) continue;
    const fixed = toAbsoluteUrl(c, "https://mlh.io");
    if (!isMlhUrl(fixed)) return fixed;
  }

  for (const key of linkKeys) {
    const v = event?.[key];
    const c = typeof v === "object" ? cleanText(v?.url || v?.href || v?.link || "") : cleanText(v || "");
    if (!c) continue;
    return toAbsoluteUrl(c, "https://mlh.io");
  }

  const nested = findFirstExternalUrl(event);
  return nested || "#";
}

function parseExternalFromMlhEventPage(html) {
  const utmMatch = html.match(/https?:\/\/[^"\s<>]+utm_source=mlh[^"\s<>]*/i);
  if (utmMatch && utmMatch[0] && !isMlhUrl(utmMatch[0])) return utmMatch[0];

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const anchors = [...doc.querySelectorAll("a[href]")];
  const candidates = [];

  for (const a of anchors) {
    const href = toAbsoluteUrl(cleanText(a.getAttribute("href") || ""), "https://mlh.io");
    if (!href || href === "#" || isMlhUrl(href)) continue;
    const text = cleanText(a.textContent || "").toLowerCase();
    if (/(website|hackathon|apply|register|signup|event)/.test(text)) return href;
    candidates.push(href);
  }

  if (candidates.length) return candidates[0];

  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  for (const script of scripts) {
    try {
      const payload = JSON.parse(script.textContent || "{}");
      const found = findFirstExternalUrl(payload);
      if (found) return found;
    } catch {
      continue;
    }
  }

  return "";
}

async function resolveMlhDestination(link, cache) {
  const fixed = toAbsoluteUrl(link, "https://mlh.io");
  if (!fixed || fixed === "#") return "#";
  if (!isMlhUrl(fixed)) return fixed;

  const eventUrl = normalizeMlhEventPath(fixed);
  if (cache.has(eventUrl)) return cache.get(eventUrl);

  try {
    const html = await fetchText(eventUrl);
    const external = parseExternalFromMlhEventPage(html);
    if (external) {
      cache.set(eventUrl, external);
      return external;
    }
  } catch {
    cache.set(eventUrl, eventUrl);
    return eventUrl;
  }

  cache.set(eventUrl, eventUrl);
  return eventUrl;
}

function normalizeMlhEvents(list) {
  return list
    .map((event) => {
      const title = cleanText(event?.name || event?.title || event?.event_name || "Unknown");
      let location = extractLocation(event?.location);
      if (!location) {
        const fallbackParts = [event?.city, event?.state, event?.province, event?.country].map(cleanText).filter(Boolean);
        location = fallbackParts.join(", ");
      }
      const formatType = cleanText(event?.format_type || event?.format || "").toLowerCase();
      const isOnline = ["digital", "online", "virtual", "remote"].includes(formatType) || !location;
      return {
        title,
        link: chooseMlhEventLink(event),
        image: cleanText(event?.background_url || event?.image || ""),
        location: location || (isOnline ? "Online" : "Unknown"),
        is_online: isOnline,
        date: cleanText(event?.date_range || event?.date || event?.dates || ""),
        tags: extractTags(event?.tags || event?.themes || event?.tracks || []),
        prize: cleanText(event?.prize || ""),
        participants: cleanText(event?.participants || ""),
        source: "mlh",
        lat: null,
        lon: null
      };
    })
    .filter((item) => item.title && item.link);
}

function normalizeMlhLdJson(list) {
  return list
    .map((event) => {
      if (!event || typeof event !== "object") return null;
      let location = "Online";
      let isOnline = true;
      if (event.location && typeof event.location === "object") {
        location = extractLocation(event.location.address || event.location) || "Online";
        isOnline = location === "Online";
      }
      return {
        title: cleanText(event.name || "MLH event"),
        link: toAbsoluteUrl(cleanText(event.url || ""), "https://mlh.io"),
        image: "",
        location,
        is_online: isOnline,
        date: cleanText(event.startDate || event.endDate || ""),
        tags: extractTags(event.keywords || []),
        prize: "",
        participants: "",
        source: "mlh",
        lat: null,
        lon: null
      };
    })
    .filter(Boolean);
}

function fallbackMlhFromDom(doc) {
  const anchors = [...doc.querySelectorAll('a[href*="/events/"], a[href*="/event/"], a[href*="mlh.io/events"]')];
  const seen = new Set();
  const out = [];

  for (const a of anchors) {
    const href = cleanText(a.getAttribute("href") || "");
    if (!href || seen.has(href)) continue;
    seen.add(href);

    const title = cleanText(a.textContent || a.getAttribute("title") || "MLH event");
    const parent = a.parentElement;
    const blockText = cleanText(parent ? parent.textContent || "" : "");

    let location = "";
    if (/online/i.test(blockText)) {
      location = "Online";
    } else {
      const locMatch = blockText.match(/([A-Za-z\s\-.]+,\s*[A-Za-z]{2,})/);
      if (locMatch) location = cleanText(locMatch[1]);
    }

    const dateMatch = blockText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:\s*-\s*\d{1,2})?(?:,\s*\d{4})?/i);

    out.push({
      title,
      link: toAbsoluteUrl(href, "https://mlh.io"),
      image: "",
      location: location || "Online",
      is_online: !location || location.toLowerCase() === "online",
      date: cleanText(dateMatch ? dateMatch[0] : ""),
      tags: [],
      prize: "",
      participants: "",
      source: "mlh",
      lat: null,
      lon: null
    });
  }

  return out;
}

function normalizeDateRange(startValue, endValue) {
  const start = cleanText(startValue || "");
  const end = cleanText(endValue || "");
  if (start && end) return `${start} - ${end}`;
  return start || end || "";
}

function normalizeGenericEvent(item, source) {
  const title = cleanText(
    item?.title || item?.name || item?.event_name || item?.eventName || item?.headline || "Unknown"
  );
  const link = toAbsoluteUrl(cleanText(item?.url || item?.link || item?.event_url || item?.registration_url || ""), "https://");
  const location = extractLocation(item?.location || item?.venue || item?.address || item?.city || "");
  const isOnline = Boolean(
    item?.is_online ||
      item?.online_event ||
      /(online|virtual|remote|worldwide)/i.test(cleanText(location || ""))
  );

  return {
    title,
    link: link === "#" ? "" : link,
    image: "",
    location: location || (isOnline ? "Online" : ""),
    is_online: isOnline,
    date: normalizeDateRange(item?.date || item?.startDate || item?.start_time, item?.endDate || item?.end_time),
    tags: extractTags(item?.tags || item?.themes || item?.topic || []),
    prize: "",
    participants: "",
    source,
    lat: null,
    lon: null
  };
}

async function scrapeMlhApi(domains = []) {
  const keys = domainKeywords(domains);
  const candidateUrls = [SOURCE_CONFIG.mlhApiUrl, "https://my.mlh.io/api/v3/events"].filter(Boolean);
  for (const url of candidateUrls) {
    try {
      const payload = await fetchJson(url);
      const events = findEventList(payload) || payload?.events || payload?.data || [];
      if (!Array.isArray(events) || !events.length) continue;
      const parsed = normalizeMlhEvents(events);
      if (parsed.length) return dedupeHackathons(parsed).filter((item) => matchesDomains(item, keys));
    } catch {
      continue;
    }
  }
  return [];
}

async function scrapeEventbrite(domains = []) {
  const token = cleanText(SOURCE_CONFIG.eventbriteApiToken || "");
  if (!token) return [];
  try {
    const params = new URLSearchParams({
      "q": "hackathon",
      "sort_by": "date",
      "expand": "venue",
      "page_size": "50"
    });
    const data = await fetchJson(`https://www.eventbriteapi.com/v3/events/search/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const events = Array.isArray(data?.events) ? data.events : [];
    const out = events
      .map((event) => {
        const venue = event?.venue || {};
        const addr = venue?.address || {};
        const location = [addr?.city, addr?.region, addr?.country].map(cleanText).filter(Boolean).join(", ");
        return {
          title: cleanText(event?.name?.text || "Unknown"),
          link: cleanText(event?.url || ""),
          image: "",
          location: location || (event?.online_event ? "Online" : ""),
          is_online: Boolean(event?.online_event),
          date: normalizeDateRange(event?.start?.local, event?.end?.local),
          tags: [],
          prize: "",
          participants: "",
          source: "eventbrite",
          lat: null,
          lon: null
        };
      })
      .filter((item) => item.title && item.link);

    const keys = domainKeywords(domains);
    return dedupeHackathons(out).filter((item) => matchesDomains(item, keys));
  } catch {
    return [];
  }
}

async function scrapeMeetup(domains = []) {
  const token = cleanText(SOURCE_CONFIG.meetupApiToken || "");
  if (!token) return [];
  try {
    const query = `
      query {
        keywordSearch(input:{query:\"hackathon\", first:50}) {
          edges {
            node {
              ... on Event {
                title
                eventUrl
                dateTime
                endTime
                isOnline
                venue { city state country }
              }
            }
          }
        }
      }
    `;
    const data = await fetchJson("https://api.meetup.com/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ query })
    });
    const edges = data?.data?.keywordSearch?.edges || [];
    const out = edges
      .map((edge) => edge?.node)
      .filter(Boolean)
      .map((event) => {
        const location = [event?.venue?.city, event?.venue?.state, event?.venue?.country]
          .map(cleanText)
          .filter(Boolean)
          .join(", ");
        return {
          title: cleanText(event?.title || "Unknown"),
          link: cleanText(event?.eventUrl || ""),
          image: "",
          location: location || (event?.isOnline ? "Online" : ""),
          is_online: Boolean(event?.isOnline),
          date: normalizeDateRange(event?.dateTime, event?.endTime),
          tags: [],
          prize: "",
          participants: "",
          source: "meetup",
          lat: null,
          lon: null
        };
      })
      .filter((item) => item.title && item.link);

    const keys = domainKeywords(domains);
    return dedupeHackathons(out).filter((item) => matchesDomains(item, keys));
  } catch {
    return [];
  }
}

async function scrapeConfigFeed(url, source, domains = []) {
  if (!cleanText(url)) return [];
  try {
    const payload = await fetchJson(url);
    const events =
      (Array.isArray(payload) && payload) ||
      payload?.events ||
      payload?.data ||
      payload?.results ||
      findEventList(payload) ||
      [];
    if (!Array.isArray(events)) return [];

    const normalized = events
      .map((event) => normalizeGenericEvent(event, source))
      .filter((item) => item.title && item.link);
    const keys = domainKeywords(domains);
    return dedupeHackathons(normalized).filter((item) => matchesDomains(item, keys));
  } catch {
    return [];
  }
}

async function scrapeMLH(domains = []) {
  const fromApi = await scrapeMlhApi(domains);
  if (fromApi.length) return fromApi;

  const season = new Date().getFullYear();
  const urls = [MLH_SEASON_URL(season), MLH_SEASON_URL(season + 1)];
  const all = [];
  const parser = new DOMParser();

  for (const url of urls) {
    let html = "";
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }

    if (!html) continue;

    let parsed = [];
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      try {
        const payload = JSON.parse(nextDataMatch[1].trim());
        const events = findEventList(payload);
        if (events) parsed = normalizeMlhEvents(events);
      } catch {
        parsed = [];
      }
    }

    if (!parsed.length) {
      const dataPageMatch = html.match(/id="app"[^>]*data-page="([^"]+)"/i) || html.match(/data-page="([^"]+)"/i);
      if (dataPageMatch) {
        try {
          const payload = JSON.parse(new DOMParser().parseFromString(`<p>${dataPageMatch[1]}</p>`, "text/html").querySelector("p").textContent || "{}");
          const props = payload?.props || {};
          const events = props.upcoming_events || props.events || findEventList(props);
          if (events) parsed = normalizeMlhEvents(events);
        } catch {
          parsed = [];
        }
      }
    }

    if (!parsed.length) {
      const doc = parser.parseFromString(html, "text/html");
      const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
      for (const script of scripts) {
        try {
          const payload = JSON.parse(script.textContent || "{}");
          if (Array.isArray(payload)) {
            const candidates = payload.filter((p) => p && typeof p === "object" && ["Event", "CreativeWork"].includes(p["@type"]));
            if (candidates.length) {
              parsed = normalizeMlhLdJson(candidates);
              break;
            }
          } else if (payload && typeof payload === "object") {
            if (payload["@type"] === "ItemList" && Array.isArray(payload.itemListElement)) {
              const candidates = payload.itemListElement
                .map((e) => (e && typeof e === "object" ? (e.item && typeof e.item === "object" ? e.item : e) : null))
                .filter(Boolean);
              parsed = normalizeMlhLdJson(candidates);
              break;
            }
            if (payload["@type"] === "Event") {
              parsed = normalizeMlhLdJson([payload]);
              break;
            }
          }
        } catch {
          continue;
        }
      }

      if (!parsed.length) parsed = fallbackMlhFromDom(doc);
    }

    all.push(...parsed);
  }

  const cache = new Map();
  await Promise.all(
    all.map(async (item) => {
      item.link = await resolveMlhDestination(item.link, cache);
    })
  );

  const keys = domainKeywords(domains);
  return dedupeHackathons(all).filter((item) => matchesDomains(item, keys));
}

function parseAggregatedSourceApiItems(items) {
  return items
    .map((h) => {
      const loc = h?.displayed_location;
      const icon = cleanText(loc?.icon || "").toLowerCase();
      const location = cleanText(typeof loc === "object" ? loc?.location || "" : loc || "");
      const isOnline = icon === "globe" || /(online|virtual|remote|worldwide)/i.test(location);
      const tags = Array.isArray(h?.themes)
        ? h.themes.map((t) => cleanText(t?.name || "")).filter(Boolean)
        : [];
      return {
        title: cleanText(h?.title || "Unknown"),
        link: toAbsoluteUrl(cleanText(h?.url || ""), "https://devpost.com"),
        image: cleanText(h?.thumbnail_url || ""),
        location: isOnline ? "Online" : location,
        is_online: isOnline,
        date: cleanText(h?.submission_period_dates || ""),
        tags,
        prize: cleanText((h?.prize_amount || "").replace(/<[^>]*>/g, "")),
        participants: h?.registrations_count !== undefined && h?.registrations_count !== null ? String(h.registrations_count) : "",
        source: "aggregated_source",
        lat: null,
        lon: null
      };
    })
    .filter((item) => item.title && item.link);
}

function parseAggregatedSourceHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const cards = doc.querySelectorAll(".hackathon-tile, article.challenge-listing, article[data-challenge-id], li.challenge-listing, [data-software-id]");
  const out = [];

  for (const card of cards) {
    const title = getFirstText(card, ["h3", "h2", ".title", "[class*='title'] a", "a[href*='/software/']"]);
    let link = getFirstAttr(card, ["a.link-to-software", "[class*='title'] a[href]", "a[href*='/software/']", "a[href]"], "href");
    link = toAbsoluteUrl(link, "https://devpost.com");
    if (!title && (!link || link === "#")) continue;
    const location = getFirstText(card, [".info .icon-location", "[class*='location']", "[data-role*='location']", ".location"]);
    const isOnline = !location || /(online|virtual|remote)/i.test(location);
    const tags = [...card.querySelectorAll(".challenge-tags span, .tag, [class*='theme'], [class*='tag']")]
      .map((el) => cleanText(el.textContent || ""))
      .filter(Boolean);

    out.push({
      title: title || cleanText(link.split("/").pop() || "Unknown"),
      link,
      image: getFirstAttr(card, ["img", "source"], "src") || getFirstAttr(card, ["img", "source"], "data-src"),
      location,
      is_online: isOnline,
      date: getFirstText(card, ["time", "[class*='date']", ".submissions-period", ".submission-period"]),
      tags,
      prize: getFirstText(card, ["[class*='prize']", ".prize"]),
      participants: getFirstText(card, ["[class*='participant']", ".participants-count"]),
      source: "aggregated_source",
      lat: null,
      lon: null
    });
  }

  return out;
}

async function scrapeAggregatedSource(domains = []) {
  const keys = domainKeywords(domains);
  let out = [];
  const now = Date.now();
  const cached = await storageGet(AGGREGATED_SOURCE_CACHE_KEY);
  if (
    cached &&
    typeof cached === "object" &&
    Array.isArray(cached.items) &&
    Number.isFinite(Number(cached.timestamp)) &&
    now - Number(cached.timestamp) <= AGGREGATED_SOURCE_CACHE_TTL_MS
  ) {
    out = cached.items;
    return dedupeHackathons(out).filter((item) => matchesDomains(item, keys));
  }

  for (let page = 1; page <= 2; page += 1) {
    try {
      const params = new URLSearchParams();
      params.append("page", String(page));
      params.append("per_page", "30");
      params.append("status[]", "open");
      params.append("status[]", "upcoming");
      params.append("order_by", "deadline");
      const data = await fetchJson(`${AGGREGATED_SOURCE_API}?${params.toString()}`);
      const items = Array.isArray(data?.hackathons) ? data.hackathons : [];
      out.push(...parseAggregatedSourceApiItems(items));
    } catch {
      try {
        const html = await fetchText(`${AGGREGATED_SOURCE_HTML}?page=${page}&status=open`);
        out.push(...parseAggregatedSourceHtml(html));
      } catch {
        continue;
      }
    }
  }

  await storageSet(AGGREGATED_SOURCE_CACHE_KEY, {
    timestamp: now,
    items: dedupeHackathons(out).map((item) => ({
      title: cleanText(item.title),
      link: toAbsoluteUrl(item.link, "https://devpost.com"),
      image: "",
      location: cleanText(item.location),
      is_online: Boolean(item.is_online),
      date: cleanText(item.date),
      tags: [],
      prize: "",
      participants: "",
      source: "aggregated_source",
      lat: null,
      lon: null
    }))
  });

  return dedupeHackathons(out).filter((item) => matchesDomains(item, keys));
}

export async function fetchHackathons(domains = []) {
  const mlh = await scrapeMLH(domains);

  // Aggregated source (Devpost) scraping is intentionally disabled.
  // To re-enable later:
  // const aggregatedSource = await scrapeAggregatedSource(domains);
  // return dedupeHackathons([...mlh, ...aggregatedSource]);

  return dedupeHackathons([...mlh]);
}

export async function geocodeLocation(query) {
  const key = cleanText(query).toLowerCase();
  if (!key) return { lat: null, lon: null };
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const params = new URLSearchParams({ q: query, format: "json", limit: "1" });
    const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { "Accept": "application/json" }
    });
    const result = Array.isArray(data) && data[0] ? { lat: Number(data[0].lat), lon: Number(data[0].lon) } : { lat: null, lon: null };
    geocodeCache.set(key, result);
    return result;
  } catch {
    const result = { lat: null, lon: null };
    geocodeCache.set(key, result);
    return result;
  }
}

export async function resolveUserCoordinates(city, userLat, userLon) {
  const lat = toFiniteNumberOrNull(userLat);
  const lon = toFiniteNumberOrNull(userLon);
  if (lat !== null && lon !== null) return { lat, lon };
  if (!cleanText(city)) return { lat: null, lon: null };
  return geocodeLocation(city);
}

export async function categorizeHackathons(hackathons, userLat, userLon, userQuery = "") {
  const userLatNum = toFiniteNumberOrNull(userLat);
  const userLonNum = toFiniteNumberOrNull(userLon);
  const nearby = [];
  const online = [];
  const far = [];
  const others = [];

  for (const h of hackathons) {
    if (h.is_online) {
      online.push(h);
      continue;
    }

    let hLat = toFiniteNumberOrNull(h.lat);
    let hLon = toFiniteNumberOrNull(h.lon);
    if (hLat === null || hLon === null) {
      const g = await geocodeLocation(h.location || "");
      hLat = g.lat;
      hLon = g.lon;
      h.lat = g.lat;
      h.lon = g.lon;
    }

    if (hLat !== null && hLon !== null && userLatNum !== null && userLonNum !== null) {
      const dist = haversine(userLatNum, userLonNum, hLat, hLon);
      h.distance_km = Math.round(dist);
      if (dist <= 200) nearby.push(h);
      else if (dist <= 2000) far.push(h);
      else others.push(h);
    } else if (textualLocationMatch(userQuery, h.location || "")) {
      nearby.push(h);
    } else {
      others.push(h);
    }
  }

  nearby.sort((a, b) => (a.distance_km || 99999) - (b.distance_km || 99999));
  far.sort((a, b) => (a.distance_km || 99999) - (b.distance_km || 99999));
  return { nearby, online, far, others };
}
