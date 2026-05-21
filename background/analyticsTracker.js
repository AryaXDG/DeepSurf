/**
 * @fileoverview Tracks and aggregates user browsing habits over time, grouping visit counts and hourly distributions by domain.
 *
 * Runs inside the background service worker, listening to navigation events and caching writes before periodically flushing to local storage. Reads and writes to chrome.storage.local, which can trigger storage quota constraints if not pruned.
 */

// We prefix keys to prevent collisions with other extension settings in the local storage bucket.
const STORAGE_PREFIX = "ad_";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A 60-second delay is used to batch writes and avoid hit limits on chrome.storage write operations.
const FLUSH_INTERVAL_MS = 60000;

/**
 * Generates a temporal key representing the current day and hour.
 * @returns {string} The formatted temporal key (e.g., "Mon_14" for Monday at 2:00 PM).
 */
function getHourlyKey() {
  const now = new Date();
  const day = DAYS[now.getDay()];
  const hour = now.getHours();
  return `${day}_${hour}`;
}

/**
 * Extracts a clean domain name from a URL string, ignoring protocols, subdomains (like www), and paths.
 * @param {string} urlStr - The full URL string to parse.
 * @returns {string|null} The parsed domain name, or null if the URL is invalid or is not an HTTP/HTTPS page.
 */
function extractDomain(urlStr) {
  try {
    const url = new URL(urlStr);
    
    if (!url.protocol.startsWith('http')) return null;

    return url.hostname.replace(/^www\./, '');
  } catch (e) {
    console.warn("[DeepSurf:Analytics] Failed to parse domain from URL:", urlStr);
    return null;
  }
}

let analyticsLock = Promise.resolve();
let pendingOps = 0;

/** @type {Map<string, {totalVisits:number, firstVisited:number, lastVisited:number, hourlyDistribution:Record<string,number>}>} */
const pendingWrites = new Map();

/**
 * Flushes all pending in-memory analytics data to chrome.storage.local.
 * @returns {void}
 */
function flushAnalytics() {
  if (pendingWrites.size === 0) return;

  const batch = {};
  for (const [key, data] of pendingWrites) {
    batch[key] = data;
  }
  pendingWrites.clear();

  const keys = Object.keys(batch);
  chrome.storage.local.get(keys, (existing) => {
    const merged = {};
    for (const key of keys) {
      const incoming = batch[key];
      const stored = existing[key];

      if (!stored) {
        merged[key] = incoming;
        continue;
      }

      merged[key] = {
        totalVisits: stored.totalVisits + incoming.totalVisits,
        firstVisited: Math.min(stored.firstVisited, incoming.firstVisited),
        lastVisited: Math.max(stored.lastVisited ?? 0, incoming.lastVisited),
        hourlyDistribution: { ...stored.hourlyDistribution },
      };
      for (const [hKey, count] of Object.entries(incoming.hourlyDistribution)) {
        merged[key].hourlyDistribution[hKey] = (merged[key].hourlyDistribution[hKey] || 0) + count;
      }
    }

    chrome.storage.local.set(merged).catch((e) => {
      console.error("[DeepSurf:Analytics] Analytics batch write failed:", e);
    });
  });
}

setInterval(flushAnalytics, FLUSH_INTERVAL_MS);

chrome.runtime.onSuspend?.addListener(flushAnalytics);

// We listen to the onCompleted event to ensure we only log pages that have successfully finished loading.
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  const domain = extractDomain(details.url);
  if (!domain) return;

  chrome.storage.local.get(["telemetryEnabled"], ({ telemetryEnabled }) => {
    if (telemetryEnabled === false) return;

    pendingOps++;

    // We use a sequential promise chain (mutex lock) to avoid race conditions when writing to the in-memory write buffer concurrently.
    analyticsLock = analyticsLock.then(() => {
      const now = Date.now();
      const storageKey = `${STORAGE_PREFIX}${domain}`;
      const hourKey = getHourlyKey();

      if (!pendingWrites.has(storageKey)) {
        pendingWrites.set(storageKey, {
          totalVisits: 0,
          firstVisited: now,
          lastVisited: 0,
          hourlyDistribution: {},
        });
      }

      const data = pendingWrites.get(storageKey);
      data.totalVisits += 1;
      if (now > data.lastVisited) data.lastVisited = now;
      if (now < data.firstVisited) data.firstVisited = now;
      data.hourlyDistribution[hourKey] = (data.hourlyDistribution[hourKey] || 0) + 1;
    }).finally(() => {
      pendingOps--;
      if (pendingOps === 0) {
        analyticsLock = Promise.resolve();
      }
    });
  });
});

console.log("[DeepSurf:Analytics] Tracker initialized (debounced writes, bounded chain).");