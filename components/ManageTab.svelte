<script>
  /**
   * @fileoverview Allows the user to browse, filter, delete, and configure automatic pruning of locally stored search pages.
   *
   * Renders the Manage Tab inside the extension side panel. Communicates with Chrome's history APIs, updates extension local storage parameters, and sends database deletion commands.
   */

  import { onMount } from "svelte";
  import { MSG } from "../lib/messages.js";
  import { urlToId } from "../lib/utils.js";

  let pages = $state([]);
  let total = $state(0);
  let loading = $state(true);
  let dbEmpty = $state(false);
  let showImportOptions = $state(false);
  let syncing = $state(false);
  let syncTotal = $state(0);
  let syncProgress = $state(0);
  let offset = $state(0);
  const LIMIT = 50;
  
  let autoPruneEnabled = $state(false);
  let autoPruneThreshold = $state(90);

  let startDate = $state("");
  let endDate = $state("");

  onMount(() => {
    console.log("[DeepSurf:ManageTab] Mounted ManageTab view.");
    chrome.storage.local.get(["autoPruneEnabled", "autoPruneThreshold"], (data) => {
      if (data.autoPruneEnabled !== undefined) autoPruneEnabled = data.autoPruneEnabled;
      if (data.autoPruneThreshold !== undefined) autoPruneThreshold = data.autoPruneThreshold;
    });
    fetchPages(true);
  });

  /**
   * Fetches page records from the database using search range filters and pagination offsets.
   * @param {boolean} [reset=false] - Whether to clear existing records and restart pagination.
   * @returns {Promise<void>}
   */
  async function fetchPages(reset = false) {
    if (reset) {
      offset = 0;
      pages = [];
    }
    loading = true;
    try {
      const startMs = startDate ? new Date(startDate).getTime() : undefined;
      let endMs = endDate ? new Date(endDate).getTime() : undefined;

      // We offset the end timestamp to 23:59:59 to include items visited on the final calendar day of the range.
      if (endMs) endMs += 24 * 60 * 60 * 1000 - 1;

      const res = await chrome.runtime.sendMessage({
        type: MSG.GET_PAGES,
        payload: { offset, limit: LIMIT, startDate: startMs, endDate: endMs }
      });
      
      console.log("[DeepSurf:ManageTab] Requested pages. Received:", res);

      if (res && res.pages) {
        const count = res.pages.length;
        console.log("[DeepSurf:ManageTab] Received " + count + " pages from DB.");
        dbEmpty = count === 0 && (offset === 0 || reset);
        if (dbEmpty) console.warn("[DeepSurf:ManageTab] Database appears empty — 0 pages returned on fresh fetch.");
        if (reset) pages = res.pages;
        else pages = [...pages, ...res.pages];
        total = res.total;
        offset += LIMIT;
      }
    } catch (e) {
      console.error("[DeepSurf:ManageTab] Failed to fetch pages:", e);
    } finally {
      loading = false;
    }
  }

  /**
   * Implements infinite scrolling by checking how close the scroll offset is to the bottom container threshold.
   * @param {UIEvent} e - The scroll event object.
   * @returns {void}
   */
  function handleScroll(e) {
    const { scrollTop, scrollHeight, clientHeight } = e.target;

    // We trigger the next page load when the user scrolls within 1.5 screen heights of the bottom to offer a smooth infinite scrolling feeling.
    if (scrollHeight - scrollTop <= clientHeight * 1.5 && !loading && pages.length < total) {
      fetchPages();
    }
  }

  /**
   * Persists auto-pruning enablement flag and day threshold settings to local storage.
   * @returns {void}
   */
  function savePruneSettings() {
    console.log(`[DeepSurf:ManageTab] Saving prune settings: enabled=${autoPruneEnabled}, threshold=${autoPruneThreshold} days.`);
    chrome.storage.local.set({ autoPruneEnabled, autoPruneThreshold });
  }

  /**
   * Deletes specific page URLs or all items from both extension database and optional browser history.
   * @param {Array<string>|string} urls - Array of URLs to remove, or the string "ALL" to clear everything.
   * @param {boolean} [removeBrowserHistory=false] - Whether to remove items from the Google Chrome browser history.
   * @returns {Promise<void>}
   */
  async function deleteItems(urls, removeBrowserHistory = false) {
    loading = true;
    try {
      await chrome.runtime.sendMessage({
        type: MSG.DELETE_HISTORY,
        payload: { urls }
      });
      
      if (removeBrowserHistory && urls !== "ALL") {
        for (const url of urls) {
          chrome.history.deleteUrl({ url }).catch((e) => console.error("[DeepSurf:ManageTab] Failed to delete browser history URL:", e));
        }
      } else if (removeBrowserHistory && urls === "ALL") {
        chrome.history.deleteAll().catch((e) => console.error("[DeepSurf:ManageTab] Failed to clear all browser history:", e));
      }
      
      await fetchPages(true);
      chrome.runtime.sendMessage({ type: MSG.GET_STATS }).catch((e) => console.error("[DeepSurf:ManageTab] Failed to refresh stats after delete:", e));
    } catch (e) {
      console.error("[DeepSurf:ManageTab] Failed to delete items:", e);
    } finally {
      loading = false;
    }
  }

  /**
   * Gathers and deletes history entries logged in the last 60 minutes.
   * @returns {void}
   */
  function clearLastHour() {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const toDelete = pages.filter(p => p.visitedAt >= hourAgo).map(p => p.url);
    if (toDelete.length) {
      if (confirm(`Delete ${toDelete.length} items from the last hour?`)) {
        deleteItems(toDelete, confirm("Also delete from Chrome browser history?"));
      }
    } else {
      alert("No items found in the last hour.");
    }
  }

  /**
   * Initiates a complete deletion of all records after user confirmation.
   * @returns {void}
   */
  function clearAll() {
    if (confirm("Are you sure you want to delete ALL DeepSurf history? This cannot be undone.")) {
      deleteItems("ALL", confirm("Also delete from Chrome browser history?"));
    }
  }

  /**
   * Filters and deletes pages falling within the specified start and end date bounds.
   * @returns {void}
   */
  function clearCustomRange() {
     const startMs = startDate ? new Date(startDate).getTime() : undefined;
     let endMs = endDate ? new Date(endDate).getTime() : undefined;
     if (endMs) endMs += 24 * 60 * 60 * 1000 - 1;

     if (!startMs && !endMs) return alert("Please select a date range first.");

     const toDelete = pages.filter(p => {
       if (startMs && p.visitedAt < startMs) return false;
       if (endMs && p.visitedAt > endMs) return false;
       return true;
     }).map(p => p.url);

     if (toDelete.length) {
       if (confirm(`Delete ${toDelete.length} items currently visible in this range?`)) {
         deleteItems(toDelete, confirm("Also delete from Chrome browser history?"));
       }
     } else {
       alert("No items found in this range.");
     }
  }

  /**
   * Triggers deletion of a single page item with optional browser history removal.
   * @param {string} url - The URL of the page item to delete.
   * @returns {void}
   */
  function deleteSingle(url) {
    if (confirm("Delete this page from history?")) {
      deleteItems([url], confirm("Also delete from Chrome browser history?"));
    }
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

      chrome.storage.local.set(updates).catch((e) => console.error("[DeepSurf:ManageTab] Failed to write retroactive analytics:", e));
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

    console.log(`[DeepSurf:ManageTab] Starting sync for last ${days} days.`);

    try {
      const results = await chrome.history.search({ text: "", startTime, maxResults: 10000 });
      console.log(`[DeepSurf:ManageTab] Raw history items fetched from Chrome: ${results.length}`);
      
      const validResults = results.filter(r => r.url && /^https?:\/\//i.test(r.url));
      console.log(`[DeepSurf:ManageTab] Valid HTTP/HTTPS items after filtering: ${validResults.length}`);
      
      if (validResults.length === 0) {
        alert(`No valid browser history found for the last ${days} days.`);
        syncing = false;
        showImportOptions = false;
        return;
      }

      buildRetroactiveAnalytics(validResults);

      syncTotal = validResults.length;
      syncProgress = 0;

      const BATCH_SIZE = 50;

      // We limit page content fetching to the last 30 days to avoid sending thousands of network requests during import.
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

        console.log(`[DeepSurf:ManageTab] Sending batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} items).`);

        const res = await chrome.runtime.sendMessage({
          type: MSG.SYNC_HISTORY,
          payload: { batch }
        });
        
        if (res?.type === MSG.ERROR) {
          console.error("[DeepSurf:ManageTab] Offscreen batch error:", res.error);
        }
        
        syncProgress += batch.length;
      }
    } catch (error) {
      console.error("[DeepSurf:ManageTab] History sync failed:", error);
      alert("Error accessing Chrome History. Make sure the extension has permissions.");
    } finally {
      console.log("[DeepSurf:ManageTab] Sync sequence complete.");
      syncing = false;
      showImportOptions = false;
      await fetchPages(true);
    }
  }

  $effect(() => {
  });
</script>

<div class="flex-1 flex flex-col overflow-hidden bg-zinc-950 text-zinc-100">
  
  <div class="px-5 py-4 border-b border-zinc-800/60 shrink-0 bg-zinc-950/80 backdrop-blur-md z-10">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner">
        <svg class="w-4 h-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </div>
      <div>
        <h2 class="text-sm font-medium text-zinc-100">History Management</h2>
        <p class="text-[10px] text-zinc-500 font-mono tracking-wider mt-0.5 uppercase">Data & Privacy Control</p>
      </div>
    </div>
  </div>

  <div class="p-4 border-b border-zinc-800/60 space-y-4 shrink-0 bg-zinc-900/20">
    
    <div class="flex items-center justify-between bg-zinc-900/50 p-3 rounded-xl border border-zinc-800/50">
      <div>
        <h3 class="text-sm font-medium text-zinc-200">Auto-Pruning</h3>
        <p class="text-xs text-zinc-500 mt-0.5">Automatically delete old history</p>
      </div>
      <div class="flex items-center gap-3">
        {#if autoPruneEnabled}
          <div class="flex items-center gap-1.5">
             <input type="number" bind:value={autoPruneThreshold} onchange={savePruneSettings} min="1" class="w-14 bg-zinc-950 border border-zinc-800 rounded-xl px-1.5 py-1 text-xs text-center text-white focus:border-violet-500 focus:outline-none" />
             <span class="text-xs text-zinc-500">days</span>
          </div>
        {/if}
        <label class="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" bind:checked={autoPruneEnabled} onchange={savePruneSettings} class="sr-only peer">
          <div class="w-9 h-5 bg-zinc-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-600"></div>
        </label>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <input type="date" bind:value={startDate} onchange={() => fetchPages(true)} class="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-violet-500" />
        <span class="text-zinc-600 text-xs">to</span>
        <input type="date" bind:value={endDate} onchange={() => fetchPages(true)} class="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-2.5 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-violet-500" />
      </div>

      <div class="flex gap-2">
        <button onclick={clearLastHour} class="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-[10px] font-semibold tracking-wider transition-colors border border-zinc-800">
          CLR LAST HR
        </button>
        <button onclick={clearCustomRange} class="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-[10px] font-semibold tracking-wider transition-colors border border-zinc-800">
          CLR RANGE
        </button>
        <button onclick={clearAll} class="flex-1 py-2 bg-transparent hover:bg-red-400/10 text-red-400 rounded-xl text-[10px] font-semibold tracking-wider transition-colors border border-red-900/30">
          CLEAR ALL
        </button>
      </div>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto p-3 scrollbar-thin" onscroll={handleScroll}>
    <div class="text-xs text-zinc-500 font-mono tracking-widest mb-3 px-1">
      {total} PAGES INDEXED
    </div>

    <div class="space-y-1.5">
      {#each pages as page (page.id)}
        <div class="group flex items-center justify-between p-2.5 bg-zinc-900/40 hover:bg-zinc-800/60 border border-zinc-800/30 rounded-xl transition-colors">
          <div class="flex-1 min-w-0 pr-3">
            <h4 class="text-xs font-medium text-zinc-200 truncate" title={page.title}>{page.title || page.url}</h4>
            <div class="flex items-center gap-2 mt-1">
               <span class="text-[10px] text-zinc-500 truncate max-w-[200px]" title={page.url}>{page.url}</span>
               <span class="text-[9px] text-zinc-600 shrink-0 font-mono">{new Date(page.visitedAt).toLocaleDateString()}</span>
            </div>
          </div>
          <button 
            onclick={() => deleteSingle(page.url)}
            class="w-6 h-6 flex items-center justify-center rounded-xl text-zinc-600 hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all shrink-0"
            title="Delete from history"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      {/each}

      {#if loading}
        <div class="py-4 flex justify-center">
          <div class="w-4 h-4 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin"></div>
        </div>
      {/if}
      
      {#if !loading && pages.length === 0}
         <div class="py-20 flex flex-col items-center text-center px-6">
           <div class="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
             <svg class="w-5 h-5 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
             </svg>
           </div>
           {#if dbEmpty}
             <p class="text-sm font-medium text-amber-400">⚠ Database Empty</p>
             <p class="text-xs text-zinc-500 mt-2 leading-relaxed max-w-[250px]">0 pages found! Begin browsing the web and your indexed history data will automatically appear here.</p>

             <button
               onclick={() => showImportOptions = !showImportOptions}
               disabled={syncing}
               class="mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold tracking-wider transition-colors border border-violet-500/30 flex items-center gap-2 mx-auto"
             >
               <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
               </svg>
               IMPORT BROWSER HISTORY
             </button>

             {#if showImportOptions}
               {#if syncing}
                 <div class="mt-4 w-full max-w-[280px] p-4 bg-zinc-900/50 border border-zinc-800/50 rounded-xl space-y-3">
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
                 <div class="mt-3 grid grid-cols-3 gap-2 w-full max-w-[280px]">
                   <button
                     onclick={() => startSync(7)}
                     class="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-[10px] font-semibold tracking-wider transition-colors border border-zinc-800"
                   >
                     7 DAYS
                   </button>
                   <button
                     onclick={() => startSync(30)}
                     class="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-[10px] font-semibold tracking-wider transition-colors border border-zinc-800"
                   >
                     30 DAYS
                   </button>
                   <button
                     onclick={() => startSync(365)}
                     class="py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-xl text-[10px] font-semibold tracking-wider transition-colors border border-zinc-800"
                   >
                     ALL TIME
                   </button>
                 </div>
               {/if}
             {/if}
           {:else}
             <p class="text-sm font-medium text-zinc-300">No pages found</p>
             <p class="text-xs text-zinc-500 mt-2 leading-relaxed max-w-[250px]">Try adjusting your date range or browse more to build your history.</p>
           {/if}
         </div>
      {/if}
    </div>
  </div>
</div>
