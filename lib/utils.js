/**
 * @fileoverview Provides utility functions for HTML sanitization, text parsing, search snippet generation, URL cleaning, and Chrome text fragment URL construction.
 *
 * Shared utility module used across background script services, DOM content scripts, and Svelte front-end components.
 */

/**
 * Strips formatting code, styling markup, and noise elements from raw HTML, returning a sanitized string capped to a maximum character length.
 * @param {string} html - The raw HTML string to clean.
 * @param {number} [maxLen=4000] - The maximum characters allowed in the resulting clean string.
 * @returns {string} The stripped text string with collapsed whitespace.
 */
export function cleanHtml(html, maxLen = 4000) {
  if (!html) return "";
  
  const tmp = new DOMParser().parseFromString(html, "text/html");

  // We remove non-content tags, ads, and navigation links to isolate the primary text body for more accurate vector embeddings.
  const noise = tmp.querySelectorAll(
    "script,style,noscript,nav,header,footer,aside,form," +
    "[role=navigation],[role=banner],[role=complementary]," +
    ".ad,.ads,.advertisement,.sidebar,.cookie-banner"
  );
  noise.forEach((n) => n.remove());

  const main =
    tmp.querySelector("main,[role=main],article,.content,.post-content") ||
    tmp.body;

  let raw = (main?.textContent ?? tmp.body?.textContent ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (raw.length <= maxLen) return raw;

  // We seek a sentence termination marker near the boundary limit to avoid splitting sentences in the middle of words.
  let boundary = raw.lastIndexOf(". ", maxLen);
  if (boundary <= maxLen * 0.5) {
    boundary = raw.lastIndexOf(" ", maxLen);
  }

  return boundary > maxLen * 0.5
    ? raw.slice(0, boundary + 1).trim() + "…"
    : raw.slice(0, maxLen).trim() + "…";
}

/**
 * Extracts a contextual text snippet surrounding the first match of any query word.
 * @param {string} text - The raw text body to search.
 * @param {string} query - The search query term or terms.
 * @param {number} [radius=120] - Number of characters to preserve before and after the matched text block.
 * @returns {string} The bounded snippet with surrounding ellipsis markers.
 */
export function buildSnippet(text, query, radius = 120) {
  if (!text || !query) return "";
  
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  let idx = -1;
  let matchLength = 0;

  for (const term of terms) {
    idx = text.toLowerCase().indexOf(term);
    if (idx !== -1) {
      matchLength = term.length;
      break;
    }
  }

  if (idx === -1) {
    const endFallback = text.lastIndexOf(" ", radius * 2) || (radius * 2);
    return text.slice(0, endFallback).trim() + "…";
  }

  let start = Math.max(0, idx - radius);
  let end = Math.min(text.length, idx + matchLength + radius);

  // We align the snippet boundaries to space characters to prevent clipping words in half at the margins.
  if (start > 0) {
    const nextSpace = text.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < idx) start = nextSpace + 1;
  }
  if (end < text.length) {
    const prevSpace = text.lastIndexOf(" ", end);
    if (prevSpace !== -1 && prevSpace > idx + matchLength) end = prevSpace;
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  
  return prefix + text.slice(start, end).trim() + suffix;
}

/**
 * Formats a Unix epoch millisecond timestamp into a human-readable relative time representation.
 * @param {number} ms - The source timestamp in milliseconds.
 * @returns {string} A localized relative time string (e.g. "5 minutes ago") or absolute date format.
 */
export function relativeTime(ms) {
  const diffInSeconds = Math.floor((ms - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (Math.abs(diffInSeconds) < 60) return "just now";
  
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (Math.abs(diffInMinutes) < 60) return rtf.format(diffInMinutes, "minute");
  
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (Math.abs(diffInHours) < 24) return rtf.format(diffInHours, "hour");
  
  const diffInDays = Math.floor(diffInHours / 24);
  if (Math.abs(diffInDays) < 30) return rtf.format(diffInDays, "day");

  return new Date(ms).toLocaleDateString();
}

/**
 * Parses and extracts the core hostname domain from a standard URL string.
 * @param {string} url - The raw URL string.
 * @returns {string} The stripped domain name (e.g. "example.com").
 */
export function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Wraps a target callback function in a debouncer that delays invocation until a quiet period of inactivity has elapsed.
 * @template {(...args: any[]) => any} T
 * @param {T} fn - The target callback function.
 * @param {number} delay - Inactivity threshold in milliseconds.
 * @returns {T} The debounced wrapper function.
 */
export function debounce(fn, delay) {
  let timer;
  return (/** @type {any[]} */ ...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Generates a globally unique identifier to represent a page record.
 * @param {string} _url - Deprecated url string parameter (preserved for call-site backward compatibility).
 * @returns {string} A random UUID v4 string.
 */
export function urlToId(_url) {

  // We use standard UUIDs to avoid key conflicts on long search or shopping URLs that share initial character limits.
  return crypto.randomUUID(); 
}

/**
 * Strips Chrome-specific text-fragment query structures from a URL string to prepare it for database index operations.
 * @param {string} url - The source URL string.
 * @returns {string} The cleaned URL with text fragment suffixes removed.
 */
export function cleanUrlForDb(url) {
  if (!url) return "";
  return url.split('#:~:text=')[0].split(':~:text=')[0];
}

/**
 * Generates a browser-native Chrome Text Fragment scroll link to highlight and navigate directly to matching text.
 * Uses Chrome's standard [start],[end] range formatting.
 * @param {string} url - The destination target URL.
 * @param {string} text - The search match string to highlight on arrival.
 * @returns {string} The compiled URL containing the scroll-to-text fragment hash.
 */
export function createHighlightUrl(url, text) {
  if (!text || !url) return url;
  
  const base = cleanUrlForDb(url);

  const words = text.trim().split(/\s+/);
  let snippet = "";
  
  // We use Chrome's multi-word range syntax (start,end) for longer passages to decrease URL size while maintaining highlight robustness.
  if (words.length > 8) {
    const start = encodeURIComponent(words.slice(0, 4).join(" "));
    const end = encodeURIComponent(words.slice(-4).join(" "));
    snippet = `${start},${end}`;
  } else {
    snippet = encodeURIComponent(text.trim());
  }

  if (base.includes('#')) {
      return `${base}:~:text=${snippet}`;
  }
  return `${base}#:~:text=${snippet}`;
}