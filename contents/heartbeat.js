/**
 * @fileoverview Track high-frequency user engagement signals, including active seconds, scroll metrics, clicks, and media play states.
 *
 * Runs isolated inside the user's active webpage (host DOM) as a content script, requiring throttled/passive event handling to avoid introducing layout thrashing or lag. Instantiates window-level event listeners, schedules requestAnimationFrame coordinate processing loops, runs a background setInterval timer, and posts batched telemetry events to the extension background.
 */

import { MSG } from "../lib/messages.js";


// We check the user settings before setting up listeners to respect global opt-out settings immediately.
chrome.storage.local.get(["telemetryEnabled"], ({ telemetryEnabled }) => {
  if (telemetryEnabled === false) return; 

  if (document.URL.startsWith("chrome://") || document.URL.startsWith("about:")) return;

  let sessionId = crypto.randomUUID();
  let lastPulseTime = Date.now();

  let activeSeconds = 0;
  let scrollPixelsTotal = 0;
  let scrollDirectionChanges = 0;
  let interactionCount = 0;
  let mouseDistancePx = 0;

  let lastY = window.scrollY;
  let lastScrollDir = null; 
  let lastMouseX = null;
  let lastMouseY = null;

  let isVisible = document.visibilityState === 'visible' && document.hasFocus();
  let visibilityStartTime = isVisible ? Date.now() : null;

  /**
   * Computes the incremental elapsed active session time since the last update and resets the baseline marker.
   * @returns {void}
   */
  function updateActiveTime() {
    if (isVisible && visibilityStartTime) {
      activeSeconds += (Date.now() - visibilityStartTime) / 1000;
      visibilityStartTime = Date.now();
    }
  }

  document.addEventListener('visibilitychange', () => {
    updateActiveTime();
    isVisible = document.visibilityState === 'visible' && document.hasFocus();
    if (isVisible) {
      visibilityStartTime = Date.now();
    } else {
      visibilityStartTime = null;
    }
  });

  window.addEventListener('focus', () => {
    if (!isVisible) {
      isVisible = true;
      visibilityStartTime = Date.now();
    }
  });

  window.addEventListener('blur', () => {
    updateActiveTime();
    isVisible = false;
    visibilityStartTime = null;
  });

  let pendingScrollY = window.scrollY;
  let pendingMouseX = null;
  let pendingMouseY = null;
  let lastMetricTime = 0;
  let rafScheduled = false;

  /**
   * Processes mouse movements and scroll offsets inside a requestAnimationFrame context to compute total drag and scroll distance metrics.
   * @returns {void}
   */
  function processMetrics() {
    rafScheduled = false;
    const now = performance.now();

    // We limit processing to once per 100ms inside the requestAnimationFrame loop to prevent mouse movement handlers from flooding CPU resource queues.
    if (now - lastMetricTime < 100) {
      rafScheduled = true;
      requestAnimationFrame(processMetrics);
      return;
    }
    lastMetricTime = now;

    const currentY = pendingScrollY;
    const diff = currentY - lastY;
    if (diff !== 0) {
      scrollPixelsTotal += Math.abs(diff);
      const currentDir = diff > 0 ? 'down' : 'up';
      if (lastScrollDir !== null && lastScrollDir !== currentDir) {
        scrollDirectionChanges++;
      }
      lastScrollDir = currentDir;
      interactionCount++;
    }
    lastY = currentY;

    if (pendingMouseX !== null && pendingMouseY !== null) {
      if (lastMouseX !== null && lastMouseY !== null) {
        const dx = pendingMouseX - lastMouseX;
        const dy = pendingMouseY - lastMouseY;
        mouseDistancePx += Math.sqrt(dx * dx + dy * dy);
      }
      lastMouseX = pendingMouseX;
      lastMouseY = pendingMouseY;
    }
  }

  /**
   * Schedules a processing loop callback on the browser's animation frame queue if one is not already pending.
   * @returns {void}
   */
  function scheduleMetrics() {
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(processMetrics);
    }
  }


  // We use passive event listeners to tell the browser's main compositor thread that we will not block page scrolling.
  window.addEventListener('scroll', () => {
    pendingScrollY = window.scrollY;
    scheduleMetrics();
  }, { passive: true });

  window.addEventListener('click', () => {
    interactionCount++;
  }, { passive: true });

  window.addEventListener('keydown', () => {
    interactionCount++;
  }, { passive: true });

  window.addEventListener('mousemove', (e) => {
    pendingMouseX = e.clientX;
    pendingMouseY = e.clientY;
    scheduleMetrics();
  }, { passive: true });

  /**
   * Scans the host page for audio or video HTML elements currently in an active playback state.
   * @returns {boolean} True if at least one audio/video element is currently playing media.
   */
  function checkMediaPlaying() {
    const mediaElements = document.querySelectorAll('video, audio');
    for (const media of mediaElements) {
      if (!media.paused && !media.ended && media.readyState > 2) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if the user currently has a non-empty text selection range active in the document window.
   * @returns {boolean} True if text is selected.
   */
  function checkTextSelection() {
    const selection = window.getSelection();
    return selection && selection.toString().trim().length > 0;
  }

  let pulseBatch = [];

  /**
   * Transmits the current batch of behavioral engagement pulses to the background tracker.
   * @returns {void}
   */
  function flushAnalytics() {
    if (pulseBatch.length === 0) return;
    try {
      chrome.runtime.sendMessage({ 
        type: MSG.ANALYTICS_BATCH,
        payload: pulseBatch 
      });
      pulseBatch = [];
    } catch (e) {
      console.error("[DeepSurf:Heartbeat] Failed to flush analytics batch:", e);
    }
  }


  // We immediately flush all accumulated pulses when the tab is hidden or closed to prevent telemetry loss during service worker cleanup.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAnalytics();
  });
  window.addEventListener("beforeunload", flushAnalytics);

  setInterval(() => {
    updateActiveTime();

    if (activeSeconds > 0 || interactionCount > 0 || scrollPixelsTotal > 0 || mouseDistancePx > 0) {
      const currentPulse = {
        id: crypto.randomUUID(),
        sessionId: sessionId,
        domain: window.location.hostname.replace(/^www\./, ''),
        url: window.location.href,
        timestamp: Date.now(),
        activeSeconds: Math.round(activeSeconds),
        scrollPixelsTotal: Math.round(scrollPixelsTotal),
        scrollDirectionChanges: scrollDirectionChanges,
        interactionCount: interactionCount,
        mouseDistancePx: Math.round(mouseDistancePx),
        isMediaPlaying: checkMediaPlaying(),
        hasTextSelection: checkTextSelection()
      };

      pulseBatch.push(currentPulse);

      if (pulseBatch.length >= 20) flushAnalytics();
    }

    activeSeconds = 0;
    scrollPixelsTotal = 0;
    scrollDirectionChanges = 0;
    interactionCount = 0;
    mouseDistancePx = 0;
    lastPulseTime = Date.now();
    if (isVisible) visibilityStartTime = Date.now();
  }, 10000);

  console.log("[DeepSurf:Heartbeat] High-frequency heartbeat monitor engaged.");
});