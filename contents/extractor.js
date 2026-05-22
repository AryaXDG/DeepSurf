/**
 * @fileoverview Extracts webpage article text, identifies user highlights, and manages a floating toolbar for saving selections.
 *
 * Runs isolated inside the user's active webpage (host DOM) as a content script, and must minimize memory overhead to respect host page performance. Reads DOM nodes, queries selection ranges, injects temporary shadow DOM elements into the host document, and transmits messages to the background service worker.
 */

import { MSG } from "../lib/messages.js";
import { cleanHtml, urlToId, cleanUrlForDb } from "../lib/utils.js";

export const config = {
  matches: ["http://*/*", "https://*/*"],
  run_at: "document_idle",
  all_frames: false,
};

const SKIP_PATTERNS = [
  /^chrome(-extension)?:\/\//,
  /^about:/,
  /^moz-extension:\/\//,
  /^file:\/\//,
  /\.(pdf|zip|png|jpg|jpeg|gif|svg|mp4|mp3|webm)(\?.*)?$/i,
];


// We exclude extension system urls, file paths, and common binary extensions to avoid unnecessary memory overhead on non-content tabs.
if (!SKIP_PATTERNS.some((p) => p.test(location.href))) {

  /**
   * Orchestrates the extraction of cleaned body text from the active webpage and passes it to the ingest pipeline.
   * @returns {Promise<void>}
   */
  const run = async () => {
    const text = cleanHtml(document.documentElement.innerHTML, 4000);
    if (text.trim().length < 80) return;

    console.log(`[DeepSurf:Extractor] Extracting page: ${location.href} (${text.length} chars)`);


    // We yield the execution thread briefly to avoid blocking the main rendering cycle during heavy text ingestion.
    await new Promise((r) => setTimeout(r, 0));

    const cleanUrl = cleanUrlForDb(location.href);
    
    const payload = {
      id: urlToId(cleanUrl),
      url: cleanUrl,
      title: document.title || cleanUrl,
      text,
      visitedAt: Date.now(),
    };
    chrome.runtime.sendMessage({ type: MSG.INGEST_PAGE, payload })
      .then((res) => { if (res && res.match) showSimilarityToast(res.match); })
      .catch((e) => { console.error("[DeepSurf:Extractor] Failed to send INGEST_PAGE:", e); });
  };

  /**
   * Displays a temporary notification on the page when similar previously read content is identified in history.
   * @param {Object} match - The matching historical page result.
   * @param {string} match.url - The URL of the matching page.
   * @param {number} match.visitedAt - The visit timestamp of the matching page.
   * @returns {void}
   */
  function showSimilarityToast(match) {
    const domain = new URL(match.url).hostname;
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    const daysAgo = Math.round((match.visitedAt - Date.now()) / (1000 * 60 * 60 * 24));
    const timeAgo = rtf.format(daysAgo, "day");
    const toast = document.createElement("div");
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:rgba(9,9,11,0.95);backdrop-filter:blur(8px);border:1px solid rgba(139,92,246,0.3);border-radius:12px;padding:12px 16px;color:#e4e4e7;font-family:system-ui,-apple-system,sans-serif;font-size:13px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.5),0 0 15px -3px rgba(139,92,246,0.3);z-index:2147483647;display:flex;align-items:center;gap:12px;transform:translateY(100px);opacity:0;transition:all 0.4s cubic-bezier(0.16,1,0.3,1);cursor:pointer;`;
    toast.innerHTML = `<div style="width:28px;height:28px;border-radius:8px;background:rgba(139,92,246,0.2);display:flex;align-items:center;justify-content:center;color:#c084fc;"><svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div><div><div style="font-weight:600;margin-bottom:2px;">DeepSurf Memory</div><div style="color:#a1a1aa;font-size:11px;">You read something similar on <span style="color:#c084fc;">${domain}</span> ${timeAgo}.</div></div>`;
    toast.onclick = () => { window.open(match.url,"_blank"); toast.style.opacity="0"; setTimeout(()=>toast.remove(),400); };
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.transform="translateY(0)"; toast.style.opacity="1"; });
    setTimeout(() => { 
        if(toast) {
            toast.style.opacity="0"; 
            toast.style.transform="translateY(20px)"; 
            setTimeout(()=>toast.remove(),400); 
        }
    }, 5000);
  }

  /**
   * Computes a canonical XPath string identifier for a given DOM node.
   * @param {Node} node - The DOM node to evaluate.
   * @returns {string} The computed XPath string prefix query.
   */
  function getXPath(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return "";
    
    if (node === document.body || node === document.documentElement || !node.parentNode) {
      return "/" + (node.tagName?.toLowerCase() || "");
    }
    
    const siblings = Array.from(node.parentNode?.children ?? []).filter(c => c.tagName === node.tagName);
    const idx = siblings.indexOf(node) + 1;
    return getXPath(node.parentNode) + "/" + node.tagName.toLowerCase() + "[" + idx + "]";
  }

  /**
   * Captures context text before and after a highlighted selection range.
   * @param {Range} range - The browser selection range object.
   * @param {number} [radius=150] - The character distance to capture on either side.
   * @returns {Object} An object containing 'before' and 'after' text snippets.
   */
  function getSurroundingContext(range, radius = 150) {
    const container = range.commonAncestorContainer;
    const block = (container.nodeType === Node.TEXT_NODE ? container.parentElement : container)
      ?.closest("p,section,article,div,li,blockquote,h1,h2,h3") ?? document.body;
    
    const fullText = block.textContent ?? "";
    const highlightText = range.toString();
    const idx = fullText.indexOf(highlightText);
    
    if (idx === -1) return { before: "", after: "" };
    
    return {
      before: fullText.slice(Math.max(0, idx - radius), idx).trim(),
      after: fullText.slice(idx + highlightText.length, idx + highlightText.length + radius).trim(),
    };
  }

  let menuHost = null;
  let microMenu = null;
  let pendingHighlight = null;

  /**
   * Removes the floating quick-save menu from the host page body.
   * @returns {void}
   */
  function removeMicroMenu() {
    if (menuHost) {
      const shadow = menuHost.shadowRoot ?? menuHost._shadow;
      const menu = shadow?.querySelector(".ds-menu");

      // We fade the menu out using CSS transitions before removing the host element to keep interactions visually smooth.
      if (menu) {
        menu.style.opacity = "0";
        menu.style.transform = "translateY(4px) scale(0.97)";
      }
      const host = menuHost;
      setTimeout(() => { host?.remove(); }, 180);
      menuHost = null;
      microMenu = null;
      pendingHighlight = null;
    }
  }

  /**
   * Instantiates and displays the quick-save floating menu above a selection range.
   * @param {number} screenX - Horizontal viewport position.
   * @param {number} screenY - Vertical viewport position.
   * @param {Object} selectionData - Metadata representing the highlighted content.
   * @returns {void}
   */
  function showMicroMenu(screenX, screenY, selectionData) {
    removeMicroMenu();
    pendingHighlight = selectionData;

    menuHost = document.createElement("div");
    menuHost.id = "deepsurf-menu-host";
    menuHost.style.cssText = `position:fixed;left:${screenX}px;top:${screenY}px;z-index:2147483647;`;


    // We wrap the selection menu in a closed shadow root to protect it from host site CSS bleed-in and querySelector scans.
    const shadow = menuHost.attachShadow({ mode: "closed" });
    menuHost._shadow = shadow; 

    const style = document.createElement("style");
    style.textContent = `
      .ds-menu {
        background: rgba(9,9,11,0.97);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(139,92,246,0.4);
        border-radius: 10px;
        padding: 4px;
        display: flex;
        align-items: center;
        gap: 2px;
        box-shadow: 0 8px 24px -4px rgba(0,0,0,0.6), 0 0 12px -2px rgba(139,92,246,0.25);
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 12px;
        opacity: 0;
        transform: translateY(4px) scale(0.97);
        transition: all 0.18s cubic-bezier(0.16,1,0.3,1);
        pointer-events: auto;
        user-select: none;
      }
      .ds-btn {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 10px;
        border-radius: 7px;
        border: none;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        transition: background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .ds-btn-save {
        background: transparent;
        color: #a1a1aa;
      }
      .ds-btn-save:hover {
        background: rgba(255,255,255,0.06);
      }
      .ds-btn-thread {
        background: linear-gradient(135deg, rgba(124,58,237,0.85), rgba(168,85,247,0.85));
        color: #fff;
      }
      .ds-btn-thread:hover {
        background: linear-gradient(135deg, rgba(124,58,237,1), rgba(168,85,247,1));
      }
      .ds-feedback {
        color: #c084fc;
        padding: 5px 12px;
        font-size: 11px;
        font-weight: 600;
      }
    `;
    shadow.appendChild(style);

    microMenu = document.createElement("div");
    microMenu.className = "ds-menu";

    const quickSaveBtn = document.createElement("button");
    quickSaveBtn.className = "ds-btn ds-btn-save";
    quickSaveBtn.innerHTML = `<svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg> Quick Save`;
    quickSaveBtn.addEventListener("click", (e) => { e.preventDefault(); doQuickSave(); });

    const addThreadBtn = document.createElement("button");
    addThreadBtn.className = "ds-btn ds-btn-thread";
    addThreadBtn.innerHTML = `<svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg> Add to Thread`;
    addThreadBtn.addEventListener("click", (e) => { e.preventDefault(); doOpenPicker(); });

    microMenu.appendChild(quickSaveBtn);
    microMenu.appendChild(addThreadBtn);
    shadow.appendChild(microMenu);
    document.body.appendChild(menuHost);
    requestAnimationFrame(() => { microMenu.style.opacity = "1"; microMenu.style.transform = "translateY(0) scale(1)"; });
  }

  /**
   * Replaces the quick-save menu actions with a confirmation status message.
   * @param {string} text - The status feedback message to display.
   * @returns {void}
   */
  function showMicroFeedback(text) {
    if (!menuHost) return;
    const shadow = menuHost._shadow;
    const menu = shadow?.querySelector(".ds-menu");
    if (menu) menu.innerHTML = `<span class="ds-feedback">${text}</span>`;
    setTimeout(removeMicroMenu, 1400);
  }

  /**
   * Transmits the current highlight data to the background worker to add to the Inbox database.
   * @returns {void}
   */
  function doQuickSave() {
    if (!pendingHighlight) return;
    console.log("[DeepSurf:Extractor] Dispatching quick-save highlight to background.");
    chrome.runtime.sendMessage({ 
        type: MSG.CANVAS_OPEN_PICKER, 
        payload: { ...pendingHighlight, mode: "quick", threadId: null } 
    }).catch((e) => { console.error("[DeepSurf:Extractor] Failed to send CANVAS_OPEN_PICKER:", e); });
    showMicroFeedback("Added to Inbox ✓");
  }

  /**
   * Transmits the current highlight data to trigger the visual thread selector panel.
   * @returns {void}
   */
  function doOpenPicker() {
    if (!pendingHighlight) return;
    console.log("[DeepSurf:Extractor] Opening thread picker for highlight.");
    chrome.runtime.sendMessage({ 
        type: MSG.CANVAS_OPEN_PICKER, 
        payload: { ...pendingHighlight, mode: "pick" } 
    }).catch((e) => { console.error("[DeepSurf:Extractor] Failed to send CANVAS_OPEN_PICKER:", e); });
    showMicroFeedback("Opening canvas…");
  }

  document.addEventListener("mouseup", (e) => {
    if (menuHost && menuHost.contains(e.target)) return;

    // We defer selection reading inside a short timeout to let the browser resolve target focus states and clear old selection ranges.
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 4) {
        if (!menuHost?.contains(document.activeElement)) removeMicroMenu();
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const menuX = Math.min(Math.max(rect.left + rect.width / 2 - 100, 8), window.innerWidth - 228);
      const menuY = Math.max(rect.top - 52, 8);

      const anchorEl = range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement : range.startContainer;
      
      const ctx = getSurroundingContext(range);

      const cleanUrl = cleanUrlForDb(location.href);

      showMicroMenu(menuX, menuY, {
        text: sel.toString().trim(),
        url: cleanUrl, 
        title: document.title,
        xpath: getXPath(anchorEl),
        contextBefore: ctx.before,
        contextAfter: ctx.after,
        timestamp: Date.now(),
      });
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (menuHost && !menuHost.contains(e.target)) removeMicroMenu();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === MSG.SPA_NAVIGATION) {
      console.log("[DeepSurf:Extractor] Received SPA_NAVIGATION — scheduling re-extraction.");
      let ran = false;
      const safeRun = () => { if (!ran) { ran = true; run(); } };

      // We use a MutationObserver with a debounce delay to identify client-side navigations on single-page apps (SPAs) where standard window load events do not fire.
      let spaDebounceTimer = null;

      const observer = new MutationObserver(() => {
        clearTimeout(spaDebounceTimer);
        spaDebounceTimer = setTimeout(() => {
          observer.disconnect();
          safeRun();
        }, 1000);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        clearTimeout(spaDebounceTimer);
        safeRun();
      }, 4000);
    }
  });

  if (document.readyState === "complete") {
    run();
  } else {
    window.addEventListener("load", run);
  }

  console.log("[DeepSurf:Extractor] Content extractor initialized.");
}