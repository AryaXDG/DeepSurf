<script>
  /**
   * @fileoverview Guides the user through onboarding, hardware WebGPU check, model download initialization, and browser history synchronization.
   *
   * Runs as the full-screen setup overlay in the extension side panel when no active installation state is detected. Requests WebGPU adapters via the navigator.gpu API, queries browser history, fetches HTML content from visited URLs, and writes to chrome.storage.local.
   */

  import { onMount } from "svelte";
  import { MSG } from "../lib/messages.js";
  import { urlToId } from "../lib/utils.js";
  import { injectDemoData } from "../lib/demoSeeder.js";
  import Logo from "./Logo.svelte";

  let { onComplete } = $props();

  let step = $state(1);
  let hasGpu = $state(false);
  let hasRam = $state(true);
  let failReason = $state("");
  let llmStatus = $state("idle");
  let llmProgress = $state(0);
  let syncTotal = $state(0);
  let syncProgress = $state(0);
  let customDays = $state(7);
  let syncing = $state(false);
  let limitedMode = $state(false);

  let isInjectingDemo = $state(false);
  let demoSuccess = $state(false);

  onMount(() => {
    console.log("[DeepSurf:Setup] Mounted Setup view.");
    (async () => {
      let gpuAvailable = false;
      let hasF16 = false;
      let maxBufferMB = 0;

      // We check navigator.deviceMemory to determine if the system has sufficient physical RAM for hosting model tensors.
      const ram = navigator.deviceMemory || 4;

      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            gpuAvailable = true;

            // We query shader-f16 support since the high-performance model uses half-precision floating-point operations.
            hasF16 = adapter.features.has('shader-f16');
            maxBufferMB = adapter.limits.maxStorageBufferBindingSize / (1024 * 1024);
          }
        } catch (e) {
          console.warn("[DeepSurf:Setup] WebGPU adapter request failed:", e);
          gpuAvailable = false;
        }
      }

      hasGpu = gpuAvailable;
      console.log(`[DeepSurf:Setup] Hardware check: GPU=${gpuAvailable}, RAM=${navigator.deviceMemory || 4}GB.`);

      if (gpuAvailable && hasF16 && ram >= 8 && maxBufferMB >= 256) {
        hasRam = true;
        failReason = "";
      } 
      else if (gpuAvailable && !hasF16 && ram >= 8) {
        hasRam = true;
        failReason = "legacy_gpu";
      } 
      else {
        hasRam = false;
        llmStatus = "unsupported";
        if (!gpuAvailable) failReason = "No WebGPU compatible graphics adapter found.";
        else if (ram < 8) failReason = `System requires at least 8GB of RAM (detected ~${ram}GB).`;
        else failReason = "GPU limits are too low to hold AI tensor matrices.";
      }
    })();

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  });

  /**
   * Listens for status update messages from the background service worker during model downloading.
   * @param {Object} msg - The message object containing model loading statuses.
   * @returns {void}
   */
  function handleMessage(msg) {
    if (msg.type === MSG.MODEL_STATUS_UPDATE) {
      if (msg.payload.llm) {
        llmStatus = msg.payload.llm;
        if (msg.payload.progress !== undefined) {
          llmProgress = msg.payload.progress;
        }
        if (llmStatus === "ready") {
          setTimeout(() => step = 3, 500);
        }
      }
    }
  }

  /**
   * Sends a request to the background worker to start downloading and compiling AI models.
   * @returns {void}
   */
  function initAI() {
    llmStatus = "loading";
    chrome.runtime.sendMessage({ type: MSG.INIT_MODELS }).catch((err) => {
      console.error("[DeepSurf:Setup] initAI failed:", err);
      llmStatus = "error";
    });
  }

  /**
   * Bypasses local AI initialization, moving the user directly to the history sync page in limited mode.
   * @returns {void}
   */
  function enableLimitedMode() {
    limitedMode = true;
    step = 3;
  }

  /**
   * Processes chrome.history items retroactively to compute day-of-week and hourly analytics distributions.
   * @param {Array<Object>} historyItems - Array of Chrome history objects to calculate telemetry for.
   * @returns {void}
   */
  function buildRetroactiveAnalytics(historyItems) {
    chrome.storage.local.get(null, (existingStorage) => {
      const updates = {};
      const daysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

      for (const item of historyItems) {
        try {
          const url = new URL(item.url);
          if (!url.protocol.startsWith('http')) continue;
          
          const domain = url.hostname.replace(/^www\./, '');
          const key = `ad_${domain}`;

          if (!updates[key]) {
            updates[key] = existingStorage[key] || {
              totalVisits: 0,
              firstVisited: Date.now(),
              lastVisited: 0,
              hourlyDistribution: {}
            };
          }

          const data = updates[key];
          const itemTime = item.lastVisitTime || Date.now();
          const visits = item.visitCount || 1; 

          data.totalVisits += visits;
          
          if (itemTime > data.lastVisited) data.lastVisited = itemTime;
          if (itemTime < data.firstVisited) data.firstVisited = itemTime;

          const date = new Date(itemTime);
          const hourKey = `${daysOfWeek[date.getDay()]}_${date.getHours()}`;

          data.hourlyDistribution[hourKey] = (data.hourlyDistribution[hourKey] || 0) + 1;

        } catch(e) {
          continue;
        }
      }

      chrome.storage.local.set(updates).catch((e) => console.error("[DeepSurf:Setup] Failed to write retroactive analytics:", e));
    });
  }

  /**
   * Fetches, cleans, and indexes browser history URLs from the specified number of past days.
   * @param {number} days - The number of days of history to retrieve.
   * @returns {Promise<void>}
   */
  async function startSync(days) {
    if (syncing) return;
    syncing = true;
    const microseconds = days * 24 * 60 * 60 * 1000;
    const startTime = Date.now() - microseconds;

    console.log(`[DeepSurf:Setup] Starting sync for last ${days} days.`);

    try {
      const results = await chrome.history.search({ text: "", startTime, maxResults: 10000 });
      console.log(`[DeepSurf:Setup] Raw history items fetched from Chrome: ${results.length}`);
      
      const validResults = results.filter(r => r.url && /^https?:\/\//i.test(r.url));
      console.log(`[DeepSurf:Setup] Valid HTTP/HTTPS items after filtering: ${validResults.length}`);
      
      if (validResults.length === 0) {
        alert(`No valid browser history found for the last ${days} days. (If you have history, try removing and re-loading the extension in chrome://extensions to grant permissions).`);
        syncing = false;
        setTimeout(() => onComplete(), 500);
        return;
      }

      buildRetroactiveAnalytics(validResults);

      syncTotal = validResults.length;
      syncProgress = 0;

      const BATCH_SIZE = 50;

      // We limit page content fetching to the last 30 days to avoid sending thousands of network requests during initial sync.
      const CONTENT_FETCH_CUTOFF_DAYS = 30; 
      const contentCutoffTime = Date.now() - CONTENT_FETCH_CUTOFF_DAYS * 24 * 60 * 60 * 1000;

      for (let i = 0; i < validResults.length; i += BATCH_SIZE) {
        const batch = await Promise.all(
          validResults.slice(i, i + BATCH_SIZE).map(async (item) => {
            let text = item.title || "";

            // We only fetch page HTML content for recent history items; older items fall back to indexing their page titles to prevent network spam.
            if ((item.lastVisitTime || 0) >= contentCutoffTime) {
              try {
                const res = await fetch(item.url, {

                  // A 5-second network timeout prevents slow sites from blocking the overall history synchronization process.
                  signal: AbortSignal.timeout(5000),
                  headers: { "Accept": "text/html" }
                });
                if (res.ok && res.headers.get("content-type")?.includes("text/html")) {
                  const html = await res.text();
  
                  text = html
                    .replace(/<script[\s\S]*?<\/script>/gi, "")
                    .replace(/<style[\s\S]*?<\/style>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s{2,}/g, " ")
                    .trim()
                    .slice(0, 4000);
                }
              } catch {
                text = item.title || "";
              }
            }

            return {
              id: urlToId(item.url),
              url: item.url,
              title: item.title || item.url,
              text: text || item.title || "No content available",
              visitedAt: item.lastVisitTime || Date.now(),
            };
          })
        );

        console.log(`[DeepSurf:Setup] Sending batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} items).`);

        const res = await chrome.runtime.sendMessage({
          type: MSG.SYNC_HISTORY,
          payload: { batch }
        });
        
        if (res?.type === MSG.ERROR) {
          console.error("[DeepSurf:Setup] Offscreen batch error:", res.error);
        }
        
        syncProgress += batch.length;
      }
    } catch (error) {
      console.error("[DeepSurf:Setup] History sync failed:", error);
      alert("Error accessing Chrome History. Make sure the extension has permissions.");
    } finally {
      console.log("[DeepSurf:Setup] Sync sequence complete.");
      syncing = false;
      setTimeout(() => onComplete(), 500);
    }
  }

  /**
   * Injects 90 days of synthetic behavioral logs and canvas items to demo the extension features.
   * @returns {Promise<void>}
   */
  async function handleDemoInject() {
    isInjectingDemo = true;
    try {
      const success = await injectDemoData();
      if (!success) {
        throw new Error("injectDemoData returned false");
      }
      demoSuccess = true;

      setTimeout(() => onComplete(), 1500); 
      
    } catch (e) {
      console.error("[DeepSurf:Setup] Failed to inject demo data:", e);
      alert("Demo injection failed. Check console.");
    } finally {
      isInjectingDemo = false;
    }
  }
</script>

<div class="h-screen flex flex-col bg-zinc-950 text-zinc-100 items-center justify-center p-6 select-none overflow-y-auto">
  {#if step === 1}
    <div class="max-w-sm w-full text-center space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div class="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 flex items-center justify-center shadow-2xl shadow-violet-900/40">
        <Logo class="w-20 h-20 text-white" />
      </div>
      
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-white mb-2">Welcome to DeepSurf</h1>
        <p class="text-sm text-zinc-400">Your AI-powered history manager.</p>
      </div>

      <div class="space-y-4 text-left">
        <div class="flex items-center gap-4 bg-zinc-900/50 p-3 rounded-xl border border-zinc-800/50">
          <div class="w-10 h-10 rounded-full bg-violet-500/20 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-zinc-200">Hybrid Search & AI Chat</h3>
            <p class="text-xs text-zinc-500">Find concepts instantly and talk to your history offline.</p>
          </div>
        </div>

        <div class="flex items-center gap-4 bg-zinc-900/50 p-3 rounded-xl border border-zinc-800/50">
          <div class="w-10 h-10 rounded-full bg-fuchsia-500/20 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-fuchsia-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-zinc-200">Visual Research Canvas</h3>
            <p class="text-xs text-zinc-500">Highlight the web and map your ideas on a spatial board.</p>
          </div>
        </div>

        <div class="flex items-center gap-4 bg-zinc-900/50 p-3 rounded-xl border border-zinc-800/50">
          <div class="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-zinc-200">Private Habit Analytics</h3>
            <p class="text-xs text-zinc-500">Track your browsing behavior with zero cloud telemetry.</p>
          </div>
        </div>
      </div>

      <button
        onclick={() => step = 2}
        class="w-full py-3 px-4 bg-violet-600 hover:bg-violet-500 text-white rounded-xl font-medium transition-colors"
      >
        Get Started
      </button>
    </div>
  {/if}

  {#if step === 2}
    <div class="max-w-sm w-full text-center space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
      <div class="w-16 h-16 mx-auto rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
        <svg class="w-8 h-8 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
      </div>

      <div>
        <h2 class="text-xl font-bold text-white mb-2">Hardware Check</h2>
        <p class="text-sm text-zinc-400">DeepSurf uses WebGPU to run AI models locally.</p>
      </div>

      {#if llmStatus === "unsupported"}
        <div class="p-4 bg-red-950/30 border border-red-900/50 rounded-xl text-left">
          <h3 class="text-sm font-semibold text-red-400 mb-2">Hardware Incompatible</h3>
          <p class="text-xs text-zinc-400 mb-3">
            {failReason} <br><br>
            To enable full AI chat capabilities, you need a compatible device and to enable 
            <span class="font-mono text-zinc-300">chrome://flags/#enable-unsafe-webgpu</span>.
          </p>
          <button
            onclick={enableLimitedMode}
            class="w-full py-2.5 px-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm font-medium transition-colors"
          >
            Continue in Limited Mode
          </button>
        </div>
      {:else}
        <div class="p-4 bg-zinc-900/50 border border-zinc-800/50 rounded-xl text-left">
          <h3 class="text-sm font-semibold text-emerald-400 mb-2">
            {#if failReason === "legacy_gpu"}
              Compatibility GPU Detected
            {:else}
              Modern GPU Detected
            {/if}
          </h3>
          <p class="text-xs text-zinc-400 mb-4">
            {#if failReason === "legacy_gpu"}
              Your device uses an older graphics architecture. We will download the 32-bit Compatibility AI Model (approx 800MB).
            {:else}
              Ready to download the high-performance 16-bit AI model (approx 800MB). This happens only once.
            {/if}
          </p>
          
          {#if llmStatus === "loading"}
            <div class="space-y-2">
              <div class="flex justify-between text-xs text-zinc-400">
                <span>Downloading...</span>
                <span>{llmProgress}%</span>
              </div>
              <div class="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div 
                  class="h-full bg-violet-500 transition-all duration-300"
                  style="width: {llmProgress}%"
                ></div>
              </div>
            </div>
          {:else}
            <button
              onclick={initAI}
              class="w-full py-2.5 px-4 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-sm font-medium transition-colors"
            >
              Initialize AI
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if step === 3}
    <div class="max-w-sm w-full text-center space-y-6 animate-in fade-in slide-in-from-right-4 duration-500 py-6">
      <div class="w-16 h-16 mx-auto rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
        <svg class="w-8 h-8 text-fuchsia-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </div>

      <div>
        <h2 class="text-xl font-bold text-white mb-2">Sync History</h2>
        <p class="text-sm text-zinc-400">Import your existing history to make it searchable.</p>
      </div>

      {#if syncing}
        <div class="p-4 bg-zinc-900/50 border border-zinc-800/50 rounded-xl text-left space-y-3">
          <p class="text-xs text-zinc-400 text-center">
            Syncing {syncProgress} / {syncTotal} items...
          </p>
          <div class="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div 
              class="h-full bg-fuchsia-500 transition-all duration-300"
              style="width: {syncTotal ? Math.round((syncProgress/syncTotal)*100) : 0}%"
            ></div>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          <button
            onclick={() => startSync(7)}
            class="w-full py-3 px-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-white rounded-xl text-sm font-medium transition-colors"
          >
            Last 7 Days
          </button>
          <button
            onclick={() => startSync(30)}
            class="w-full py-3 px-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-white rounded-xl text-sm font-medium transition-colors"
          >
            Last 30 Days
          </button>
          
          <div class="flex gap-2">
            <input 
              type="number" 
              bind:value={customDays} 
              min="1" 
              max="365"
              class="w-24 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
            />
            <button
              onclick={() => startSync(customDays)}
              class="flex-1 py-2 px-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-white rounded-xl text-sm font-medium transition-colors"
            >
              Custom Days
            </button>
          </div>

          <button
            onclick={() => onComplete()}
            class="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mt-2"
          >
            Skip for now
          </button>
        </div>

        <div class="mt-8 border-t border-zinc-800/60 pt-6">
          <p class="text-[10px] text-zinc-500 font-mono tracking-widest uppercase mb-3 text-center">Developer & Showcase Tools</p>
          
          <button 
            onclick={handleDemoInject} 
            disabled={isInjectingDemo || demoSuccess}
            class="w-full py-2.5 bg-emerald-950/30 hover:bg-emerald-900/40 text-emerald-400 border border-emerald-800/50 rounded-xl font-mono text-[10px] uppercase tracking-wider transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            
            {#if isInjectingDemo}
              <div class="w-3 h-3 border border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin"></div>
              Synthesizing Data...
            {:else if demoSuccess}
              <svg class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              Calibration Complete
            {:else}
              <svg class="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
              Inject 90-Day Demo State
            {/if}
          </button>
          <p class="text-[9px] text-zinc-600 mt-2 text-center leading-relaxed">
            Instantly bypasses the 21-day engine calibration lock. <br/> Populates synthetic temporal, spatial, and dopamine telemetry.
          </p>
        </div>
      {/if}
    </div>
  {/if}
</div>