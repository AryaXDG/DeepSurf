/**
 * @fileoverview Manages the background service worker lifecycle, orchestrating communication between content scripts, the side panel UI, and the offscreen document.
 *
 * Acts as the primary message router and controller in the extension's architecture, handling extension lifecycle events, side panel connections, and alarms. Starts and stops the offscreen document which loads the WebGPU environment and database, and handles extension-wide alarms that clean up storage.
 */

import { MSG } from "../lib/messages.js";
import "./analyticsTracker.js";

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen/index.html");

let offscreenReady = false;
let offscreenCreating = false;
const pendingQueue = [];
const pendingHighlightQueue = [];

// Defer closing the offscreen document by 30s after the last message completes.
// This prevents rapid open/close cycles when messages arrive with short idle gaps
// between them (e.g. sequential async flows, test phases, retry loops).
const IDLE_CLOSE_DELAY_MS = 30_000;
let idleCloseTimer = null;

function scheduleIdleClose() {
  clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(() => maybeCloseOffscreen(), IDLE_CLOSE_DELAY_MS);
}

function cancelIdleClose() {
  clearTimeout(idleCloseTimer);
  idleCloseTimer = null;
}

/**
 * Verifies that the offscreen document exists and starts it if it does not.
 * @returns {Promise<void>} Resolves when the offscreen document is ready or verified as running.
 */
async function ensureOffscreen() {
  console.log("[DeepSurf] Ensuring offscreen document is ready...");
  if (offscreenReady) return;

  const existing = await chrome.offscreen.hasDocument();
  if (existing) {
    offscreenReady = true;
    return;
  }

  // If the document is already in the process of being created, wait and retry to avoid duplicate creation calls.
  if (offscreenCreating) {
    await new Promise((r) => setTimeout(r, 200));
    return ensureOffscreen();
  }

  offscreenCreating = true;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification: "Run WebGPU models and PGlite without blocking the SW",
    });
    console.log("[DeepSurf] Offscreen document created successfully.");
  } catch (e) {

    // If chrome.offscreen.createDocument throws because of a race condition where the document was created by another call, we verify its existence to proceed safely.
    const alreadyExists = await chrome.offscreen.hasDocument().catch(() => false);
    if (alreadyExists) {
      console.warn("[DeepSurf] Offscreen already existed on create (race), continuing.");
      offscreenReady = true;
    } else {
      console.error("[DeepSurf] Failed to create offscreen document:", e);
    }
  } finally {
    offscreenCreating = false;
  }
}

/**
 * Empties the queue of messages that were waiting for the offscreen document to load.
 * @returns {Promise<void>} Resolves when all queued messages are processed.
 */
async function drainQueue() {
  for (const item of pendingQueue.splice(0)) {
    try {
      const result = await chrome.runtime.sendMessage(item.msg);
      console.log(`[DeepSurf] Drained queued message: ${item.msg.type}`);
      item.resolve(result);
    } catch (e) {
      console.error(`[DeepSurf] Error draining queued message: ${item.msg.type}`, e);
      item.reject(e);
    }
  }

  // Schedule a deferred close rather than closing immediately.
  // This prevents the offscreen document from being torn down during
  // brief idle gaps between sequential message bursts.
  scheduleIdleClose();
}

/**
 * Closes the offscreen document if there are no pending messages and no active connections to the side panel.
 * @returns {void}
 */
function maybeCloseOffscreen() {

  // We keep the offscreen document alive if there is pending work or an active sidepanel port to prevent frequent startup/shutdown cycles.
  if (pendingQueue.length > 0 || sidepanelPorts.size > 0) return;
  if (!offscreenReady) return;

  console.log("[DeepSurf] No pending work or connections — closing offscreen document.");
  offscreenReady = false;
  chrome.offscreen.closeDocument().catch((e) => {
    console.warn("[DeepSurf] closeDocument failed (may already be closed):", e);
  });
}

/**
 * Routes a message to the offscreen document, starting the document first if necessary.
 * @param {Object} msg - The message object to route.
 * @param {number} [retries=1] - The number of remaining attempts to send the message if a routing error occurs.
 * @returns {Promise<any>} The response returned from the offscreen document.
 * @throws {Error} If routing fails after all retries are exhausted.
 */
async function toOffscreen(msg, retries = 1) {
  console.log(`[DeepSurf] Routing message to offscreen: ${msg.type}`);
  const stamped = { ...msg, target: "offscreen" };

  // Cancel any pending idle-close so we don't tear down the document
  // mid-flight when a new message arrives after a quiet gap.
  cancelIdleClose();

  await ensureOffscreen();

  // If the document is not ready yet, queue the message and set a timeout to fail if initialization hangs.
  if (!offscreenReady) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = pendingQueue.findIndex((item) => item.resolve === resolve);
        if (idx !== -1) pendingQueue.splice(idx, 1);
        reject(new Error("Offscreen initialization timeout"));
      }, 15000);
      pendingQueue.push({
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        msg: stamped,
      });
    });
  }

  try {
    const result = await chrome.runtime.sendMessage(stamped);
    // Restart the idle-close countdown after each successful message completes.
    scheduleIdleClose();
    return result;
  } catch (error) {

    // Retry once because service workers can occasionally fail to deliver messages right after offscreen creation.
    if (retries > 0) {
      offscreenReady = false;
      return toOffscreen(msg, retries - 1);
    }
    console.error(`[DeepSurf] Failed to route message to offscreen: ${msg.type}`, error);
    throw error;
  }
}

const sidepanelPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel-chat") return;
  sidepanelPorts.add(port);

  port.onDisconnect.addListener(() => {
    sidepanelPorts.delete(port);

    // Unload the large WebGPU LLM from memory when the user closes the panel to free up GPU resources.
    if (sidepanelPorts.size === 0) {
      console.log("[DeepSurf] Side panel closed. Freeing VRAM...");
      toOffscreen({ type: MSG.UNLOAD_LLM })
        .catch((e) => { console.warn("[DeepSurf] Failed to unload LLM on disconnect", e); })
        .finally(() => scheduleIdleClose());
    }
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === MSG.CHAT_STREAM_START || msg.type === MSG.CHAT_STREAM_ABORT) {
      toOffscreen(msg).catch((e) => { console.error("[DeepSurf] Failed toOffscreen for chat stream:", e); });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.OFFSCREEN_READY_PING) {
    console.log("[DeepSurf] Offscreen ready ping received.");
    offscreenReady = true;
    drainQueue();
    return false;
  }

  if (
    msg.type === MSG.CHAT_TOKEN ||
    msg.type === MSG.CHAT_DONE ||
    msg.type === MSG.CHAT_ERROR ||
    msg.type === MSG.MODEL_STATUS_UPDATE
  ) {
    for (const port of sidepanelPorts) {
      try { port.postMessage(msg); } catch (e) { console.error("[DeepSurf] Dead sidepanel port:", e); sidepanelPorts.delete(port); }
    }
    return false;
  }

  if (msg.type === MSG.GET_PENDING_HIGHLIGHT) {
    sendResponse({ payload: pendingHighlightQueue.shift() ?? null });
    return true;
  }

  if (msg.type === MSG.CANVAS_OPEN_PICKER) {

    // Quick mode bypasses the side panel and adds the node directly to avoid disrupting the user's flow.
    if (msg.payload.mode === "quick") {
      toOffscreen({
        type: MSG.CANVAS_ADD_NODE,
        payload: {
          ...msg.payload,
          threadId: null,
          posX: -9999,
          posY: -9999
        }
      })
      .then(sendResponse)
      .catch((e) => sendResponse({ type: MSG.ERROR, error: e.message }));
      return true;
    }

    pendingHighlightQueue.push(msg.payload); 
    
    // We open the side panel programmatically since Chrome requires a user gesture context which this message listener inherits from the content script context menu click.
    if (sender?.tab) {
      chrome.sidePanel.open({ windowId: sender.tab.windowId })
        .catch(() => chrome.sidePanel.open({ tabId: sender.tab.id }))
        .catch((err) => console.error("[DeepSurf] Side panel open failed:", err));
    }
    
    for (const port of sidepanelPorts) {
      try { port.postMessage(msg); } catch (e) { console.error("[DeepSurf] Dead sidepanel port:", e); sidepanelPorts.delete(port); }
    }
    return false;
  }

  if (msg.type === MSG.INGEST_PAGE) {
    console.log(`[DeepSurf] Ingesting page: ${msg.payload.url ?? sender.tab?.url}`);
    toOffscreen({
      type: MSG.INGEST_PAGE,
      payload: {
        ...msg.payload,
        url: msg.payload.url ?? sender.tab?.url,
        title: msg.payload.title ?? sender.tab?.title,
      },
    })
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ type: MSG.ERROR, error: e.message }));
    return true;
  }

  const CANVAS_MSGS = new Set([
    MSG.CANVAS_GET_THREADS, MSG.CANVAS_CREATE_THREAD,
    MSG.CANVAS_DELETE_THREAD, MSG.CANVAS_RENAME_THREAD,
    MSG.CANVAS_GET_NODES, MSG.CANVAS_ADD_NODE,
    MSG.CANVAS_DELETE_NODE, MSG.CANVAS_UPDATE_NODE,
    MSG.CANVAS_GET_EDGES, MSG.CANVAS_ADD_EDGE,
    MSG.CANVAS_DELETE_EDGE, MSG.CANVAS_LABEL_EDGE,
    MSG.GET_NODES_BY_URL,
    MSG.CANVAS_GET_INBOX
  ]);

  if (CANVAS_MSGS.has(msg.type)) {
    console.log(`[DeepSurf] Routing canvas message: ${msg.type}`);
    toOffscreen(msg)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ type: MSG.ERROR, error: e.message }));
    return true;
  }

  if (msg.type === MSG.GET_BEHAVIORAL_STATS) {
    chrome.storage.local.get(null, (data) => {
      const enhancedMsg = {
        ...msg,
        payload: { ...(msg.payload || {}), isDemoMode: data && data.isDemoMode === true }
      };
      toOffscreen(enhancedMsg)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ type: MSG.ERROR, error: e.message }));
    });
    return true;
  }

  const GENERIC_MSGS = new Set([
    MSG.SEARCH_HYBRID, MSG.GET_STATS, MSG.GET_MODEL_STATUS, MSG.INIT_MODELS,
    MSG.SYNC_HISTORY, MSG.DELETE_HISTORY, MSG.GET_PAGES, MSG.PRUNE_HISTORY,
    MSG.UNLOAD_LLM, MSG.ANALYTICS_PULSE, MSG.ANALYTICS_BATCH, MSG.INJECT_DEMO_PULSES, MSG.RESET_DEMO_DB
  ]);

  if (GENERIC_MSGS.has(msg.type)) {
    console.log(`[DeepSurf] Routing analytics/stats message: ${msg.type}`);
    toOffscreen(msg)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ type: MSG.ERROR, error: e.message }));
    return true;
  }

  return false;
});

// We listen to history state updates to detect client-side navigation in Single Page Applications (SPAs) and notify content scripts.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {
    chrome.tabs.sendMessage(details.tabId, { type: MSG.SPA_NAVIGATION }).catch((e) => {
      console.error("[DeepSurf] Failed to send SPA_NAVIGATION to tab:", e);
    });
  }
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => { console.error("[DeepSurf] setPanelBehavior failed:", e); });

chrome.runtime.onInstalled.addListener(() => {
  console.log("[DeepSurf] Extension installed/updated.");
  ensureOffscreen();
  chrome.alarms.create("auto-prune-alarm", { periodInMinutes: 24 * 60 });
});
chrome.runtime.onStartup.addListener(() => ensureOffscreen());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto-prune-alarm") {
    console.log("[DeepSurf] Auto-prune alarm triggered.");
    chrome.storage.local.get(["autoPruneEnabled", "autoPruneThreshold"], (data) => {
      if (data.autoPruneEnabled && data.autoPruneThreshold) {
        const thresholdMs = data.autoPruneThreshold * 24 * 60 * 60 * 1000;
        console.log(`[DeepSurf] Pruning history older than ${data.autoPruneThreshold} days.`);
        toOffscreen({ type: MSG.PRUNE_HISTORY, payload: { thresholdMs } }).catch((e) => { console.error("[DeepSurf] Auto-prune failed:", e); });
      }
    });
  }
});