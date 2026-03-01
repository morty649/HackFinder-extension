import { fetchHackathons, resolveUserCoordinates, categorizeHackathons } from "./scraper.js";

let userLat = null;
let userLon = null;
let hackathonData = { nearby: [], online: [], far: [], others: [] };
let activeCategory = "nearby";

const cityInput = document.getElementById("cityInput");
const geoBtn = document.getElementById("geoBtn");
const submitBtn = document.getElementById("submitBtn");
const SEARCH_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const SEARCH_CACHE_PREFIX = "hf_search_cache_v2:";
const REVERSE_GEO_CACHE_PREFIX = "hf_reverse_geo_v1:";

async function reverseGeocode(lat, lon) {
  const roundedLat = Number(lat).toFixed(3);
  const roundedLon = Number(lon).toFixed(3);
  const cacheKey = `${REVERSE_GEO_CACHE_PREFIX}${roundedLat},${roundedLon}`;

  const cached = await storageGet(cacheKey);
  if (typeof cached === "string" && cached.trim()) return cached;

  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "jsonv2"
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
        headers: { Accept: "application/json" }
      });
      if (!res.ok) {
        if (attempt === 0) continue;
        return "";
      }
      const data = await res.json();
      const addr = data?.address || {};
      const city = addr.city || addr.town || addr.village || addr.county || "";
      const state = addr.state || "";
      const country = addr.country || "";
      const place = [city, state, country].filter(Boolean).join(", ");
      if (place) {
        await storageSet(cacheKey, place);
      }
      return place;
    } catch {
      if (attempt === 0) continue;
      return "";
    }
  }
  return "";
}

function setStatus(msg, active) {
  document.getElementById("statusText").textContent = msg;
  document.getElementById("statusDot").className = `status-dot${active ? " active" : ""}`;
}

function normalizeCacheText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9,\s.-]/g, " ")
    .replace(/\s+/g, " ");
}

function buildSearchCacheKey(city, domains, lat, lon) {
  const normCity = normalizeCacheText(city);
  const normDomains = [...domains].map((d) => String(d).trim().toLowerCase()).sort().join("|");
  const latPart = Number.isFinite(lat) ? Number(lat).toFixed(2) : "";
  const lonPart = Number.isFinite(lon) ? Number(lon).toFixed(2) : "";
  return `${SEARCH_CACHE_PREFIX}${normCity}::${latPart},${lonPart}::${normDomains}`;
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

async function readSearchCache(cacheKey) {
  const payload = await storageGet(cacheKey);
  if (!payload || typeof payload !== "object") return null;
  const ts = Number(payload.timestamp);
  if (!Number.isFinite(ts)) return null;
  if (Date.now() - ts > SEARCH_CACHE_TTL_MS) return null;
  const data = payload.data;
  if (!data || typeof data !== "object") return null;
  return data;
}

async function writeSearchCache(cacheKey, data) {
  await storageSet(cacheKey, { timestamp: Date.now(), data });
}

function escHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openLink(url) {
  if (!url || url === "#") return;
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url });
    return;
  }
  window.open(url, "_blank", "noopener");
}

function updateCounts() {
  for (const cat of ["nearby", "online", "far", "others"]) {
    const count = hackathonData[cat]?.length || 0;
    document.getElementById(`count-${cat}`).textContent = `${count} result${count === 1 ? "" : "s"}`;
  }
}

function sourceAttribution(item) {
  const src = String(item?.source || "").toLowerCase();
  if (src === "aggregated_source" || src === "devpost") return "Public Source";
  if (src === "mlh") return "MLH";
  if (!src) return "Source: public source";
  return `Source: ${src}`;
}

function renderCategory(cat) {
  const labels = {
    nearby: "Nearby and Relevant",
    online: "Online and Relevant",
    far: "Far Away and Relevant",
    others: "Others"
  };

  document.getElementById("resultsTitle").textContent = labels[cat] || "Results";
  const grid = document.getElementById("resultsGrid");
  const items = hackathonData[cat] || [];

  if (!items.length) {
    grid.className = "";
    grid.innerHTML = `<div class="empty-state"><p>No ${escHtml(cat)} hackathons found for your query.</p></div>`;
    return;
  }

  grid.className = "cards-grid";
  grid.innerHTML = items
    .map(
      (h) => `
      <div class="hack-card" data-link="${escHtml(h.link)}">
        <div class="card-body">
          <div class="card-source">${escHtml(sourceAttribution(h))}</div>
          <div class="card-title">${escHtml(h.title)}</div>
          ${h.prize ? `<span class="card-prize">Prize ${escHtml(h.prize)}</span>` : ""}
          ${h.distance_km !== undefined ? `<span class="card-distance">${escHtml(h.distance_km)} km away</span>` : ""}
          <div class="card-meta">
            ${
              h.location
                ? `<div class="card-meta-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>${escHtml(h.location)}</div>`
                : ""
            }
            ${
              h.date
                ? `<div class="card-meta-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>${escHtml(h.date)}</div>`
                : ""
            }
            ${
              h.participants
                ? `<div class="card-meta-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"></path></svg>${escHtml(h.participants)}</div>`
                : ""
            }
          </div>
          <a class="card-link" href="${escHtml(h.link)}" target="_blank" rel="noopener">View Hackathon</a>
        </div>
      </div>
    `
    )
    .join("");

  grid.querySelectorAll(".hack-card").forEach((card) => {
    card.addEventListener("click", () => openLink(card.dataset.link || ""));
  });

  grid.querySelectorAll(".card-link").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openLink(link.getAttribute("href") || "");
    });
  });
}

function showLoadingSkeletons() {
  document.getElementById("categoryNav").style.display = "grid";
  document.getElementById("resultsSection").style.display = "block";
  const grid = document.getElementById("resultsGrid");
  grid.className = "";
  grid.innerHTML = `
    <div class="skeleton-grid">
      ${Array(4)
        .fill(
          `
          <div class="skeleton-card">
            <div class="skeleton-img"></div>
            <div class="skeleton-body">
              <div class="skeleton-line short"></div>
              <div class="skeleton-line medium"></div>
              <div class="skeleton-line"></div>
              <div class="skeleton-line short"></div>
            </div>
          </div>
        `
        )
        .join("")}
    </div>
  `;
}

document.querySelectorAll(".tag-btn").forEach((btn) => {
  btn.addEventListener("click", () => btn.classList.toggle("active"));
});

document.querySelectorAll(".cat-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".cat-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeCategory = btn.dataset.cat || "nearby";
    renderCategory(activeCategory);
  });
});

geoBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("Geolocation unavailable", false);
    return;
  }

  geoBtn.classList.add("loading");
  setStatus("Acquiring location...", true);

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;
      const place = await reverseGeocode(userLat, userLon);
      if (place) {
        cityInput.value = place;
      } else if (!cleanCityInput(cityInput.value)) {
        cityInput.value = `${userLat.toFixed(3)}, ${userLon.toFixed(3)}`;
      }
      geoBtn.classList.remove("loading");
      setStatus(place ? "Location detected" : "Location captured; city lookup failed", true);
    },
    (err) => {
      geoBtn.classList.remove("loading");
      setStatus(`Location denied: ${err.message}`, false);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

submitBtn.addEventListener("click", async () => {
  const city = cleanCityInput(cityInput.value);
  const domains = [...document.querySelectorAll(".tag-btn.active")].map((b) => b.dataset.domain).filter(Boolean);

  submitBtn.classList.add("loading");
  submitBtn.textContent = "Searching...";
  setStatus("Fetching hackathons...", true);
  showLoadingSkeletons();

  try {
    const user = await resolveUserCoordinates(city, userLat, userLon);
    const cacheKey = buildSearchCacheKey(city, domains, user.lat, user.lon);
    const cached = await readSearchCache(cacheKey);
    if (cached) {
      hackathonData = cached;
      setStatus("Loaded from cache", true);
    } else {
      const allHackathons = await fetchHackathons(domains);
      const categorized = await categorizeHackathons(allHackathons, user.lat, user.lon, city);
      hackathonData = categorized;
      await writeSearchCache(cacheKey, categorized);
    }

    updateCounts();
    document.getElementById("categoryNav").style.display = "grid";
    document.getElementById("resultsSection").style.display = "block";
    renderCategory(activeCategory);

    const total =
      hackathonData.nearby.length +
      hackathonData.online.length +
      hackathonData.far.length +
      hackathonData.others.length;
    setStatus(`Found ${total} hackathons`, true);
  } catch (err) {
    setStatus(`Error: ${err?.message || "Request failed"}`, false);
    const grid = document.getElementById("resultsGrid");
    grid.className = "";
    grid.innerHTML = '<div class="empty-state"><p>Failed to fetch hackathons. Check permissions and network.</p></div>';
  } finally {
    submitBtn.classList.remove("loading");
    submitBtn.textContent = "Search Hackathons";
  }
});

function cleanCityInput(value) {
  return String(value || "").trim();
}
