<script>
  /**
   * @fileoverview Main Svelte container for the DeepSurf sidepanel interface.
   *
   * This file coordinates setup stages, manages active tabs, handles user history queries,
   * interfaces with the offscreen document via persistent message ports for streaming RAG chat,
   * and tracks local telemetry state updates.
   */
  import { onMount, tick } from "svelte";
  import Logo from "../components/Logo.svelte";
  import { MSG } from "../lib/messages.js";
  import ModelStatus from "../components/ModelStatus.svelte";
  import TabNav from "../components/TabNav.svelte";
  import SearchBar from "../components/SearchBar.svelte";
  import ResultCard from "../components/ResultCard.svelte";
  import ChatMessage from "../components/ChatMessage.svelte";
  import ChatInput from "../components/ChatInput.svelte";
  import Setup from "../components/Setup.svelte";
  import ManageTab from "../components/ManageTab.svelte";
  import ResearchCanvas from "../components/ResearchCanvas.svelte";
  import AnalyticsTab from '../components/AnalyticsTab.svelte';

  let setupComplete = $state(false); 
  let isCheckingStorage = $state(true); 
  let activeTab = $state("search");
  let isDemoMode = $state(false);

  let pendingHighlight = $state(null);

  /** @type {import("../lib/messages.js").SearchResult[]} */
  let results = $state([]);
  let searching = $state(false);
  let lastQuery = $state("");

  /** @type {Array<{role:string, content:string, streaming?:boolean}>} */
  let chatHistory = $state([]);
  let streaming = $state(false);

  /** @type {Set<number>} */
  let visibleMsgIndices = $state(new Set());
  const VIRTUAL_BUFFER = 2; 

  /** @type {import("../lib/messages.js").SearchResult[]} */
  let chatContext = $state([]);

  let modelStatus = $state({ embedder: "idle", llm: "idle", llmProgress: 0 });
  let stats = $state(null);

  /** @type {chrome.runtime.Port | null} */
  let chatPort = null;

  /**
   * Initializes or returns the persistent message port used for streaming local chat tokens.
   *
   * @returns {chrome.runtime.Port} The active messaging port.
   */
  function ensureChatPort() {
    if (chatPort) return chatPort;
    chatPort = chrome.runtime.connect({ name: "sidepanel-chat" });
    chatPort.onMessage.addListener(handlePortMessage);
    chatPort.onDisconnect.addListener(() => {
      chatPort = null;
      streaming = false;
    });
    return chatPort;
  }

  /**
   * Handles incoming message packets from the persistent chat port.
   *
   * @param {Object} msg - The message envelope containing the type and payload.
   * @param {string} msg.type - The IPC message identifier.
   * @param {Object} msg.payload - The data structure containing chat tokens or status updates.
   * @returns {void}
   */
  function handlePortMessage(msg) {
    if (msg.type === MSG.CHAT_TOKEN) {
      const last = chatHistory[chatHistory.length - 1];
      if (last?.role === "assistant") {
        chatHistory = [
          ...chatHistory.slice(0, -1),
          { ...last, content: last.content + msg.payload.token, streaming: true },
        ];
      }
      scrollChat();
    } else if (msg.type === MSG.CHAT_DONE) {
      const last = chatHistory[chatHistory.length - 1];
      if (last?.role === "assistant") {
        chatHistory = [
          ...chatHistory.slice(0, -1),
          { ...last, streaming: false },
        ];
      }
      streaming = false;
      chrome.runtime.sendMessage({ type: MSG.GET_STATS })
        .then((res) => { stats = res?.stats ?? stats; })
        .catch((e) => console.error("[DeepSurf:Sidepanel] Failed to refresh stats after chat:", e));
    } else if (msg.type === MSG.CHAT_ERROR) {
      streaming = false;
      const last = chatHistory[chatHistory.length - 1];
      if (last?.role === "assistant") {
        chatHistory = [
          ...chatHistory.slice(0, -1),
          { role: "assistant", content: `⚠ Error: ${msg.payload.error}`, streaming: false },
        ];
      }
    } else if (msg.type === MSG.MODEL_STATUS_UPDATE) {
      modelStatus = { ...modelStatus, ...msg.payload };
    } else if (msg.type === MSG.CANVAS_OPEN_PICKER) {
      pendingHighlight = msg.payload;
      activeTab = "canvas";
    }
  }

  /**
   * Triggers a semantic and lexical hybrid search across history pages in response to a user query.
   *
   * @param {string} query - The search string.
   * @returns {Promise<void>}
   */
  async function handleSearch(query) {
    if (!query) {
      results = [];
      lastQuery = "";
      return;
    }

    lastQuery = query;
    searching = true;

    try {
      const res = await chrome.runtime.sendMessage({
        type: MSG.SEARCH_HYBRID,
        payload: { query, limit: 12 },
      });
      results = res?.results ?? [];
    } catch (e) {
      console.error("[DeepSurf:Sidepanel] Search error:", e);
      results = [];
    } finally {
      searching = false;
    }
  }

  let chatEl = $state();

  /**
   * Schedules a scroll transition to keep the chat pane aligned with the latest tokens.
   *
   * @returns {void}
   */
  function scrollChat() {
    tick().then(() => {
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    });
  }

  /**
   * Appends a search result to the current chat context scope and navigates to the chat panel.
   *
   * @param {Object} result - The search result row to include.
   * @returns {void}
   */
  function useResultInChat(result) {
    if (!chatContext.find((c) => c.url === result.url)) {
      chatContext = [...chatContext, result];
    }
    activeTab = "chat";
  }

  /**
   * Compiles recent conversation records into a system prompt context window fitting size limits.
   *
   * @param {Array<Object>} history - The current message history stack.
   * @param {number} [maxChars=3000] - Limit to prevent context window overflow.
   * @returns {Array<Object>} The trimmed chronological subset of messages.
   */
  function buildContextWindow(history, maxChars = 3000) {
    const eligible = history.filter((m) => !m.streaming);
    const window = [];
    let totalLen = 0;

    for (let i = eligible.length - 1; i >= 0; i--) {
      const msg = eligible[i];
      if (totalLen + msg.content.length > maxChars) break;
      window.push({ role: msg.role, content: msg.content });
      totalLen += msg.content.length;
    }

    return window.reverse();
  }

  /**
   * Encodes a user message and posts it to the background RAG pipeline.
   *
   * @param {string} text - The user query to submit.
   * @returns {Promise<void>}
   */
  async function sendChatMessage(text) {
    if (streaming) return;

    // Implicit RAG retrieval: if the context box is empty, we perform
    // an implicit search using the prompt text to fetch top 5 snippets automatically.
    let ctx = chatContext;
    if (ctx.length === 0) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: MSG.SEARCH_HYBRID,
          payload: { query: text, limit: 5 },
        });
        ctx = res?.results ?? [];
      } catch {}
    }

    chatHistory = [
      ...chatHistory,
      { role: "user", content: text },
      { role: "assistant", content: "", streaming: true },
    ];
    streaming = true;
    scrollChat();

    const port = ensureChatPort();
    port.postMessage({
      type: MSG.CHAT_STREAM_START,
      payload: {
        query: text,
        context: ctx,
        history: buildContextWindow(chatHistory, 3000),
      },
    });
  }

  /**
   * Sends an abort command to interrupt the active chat generation.
   *
   * @returns {void}
   */
  function abortChat() {
    chatPort?.postMessage({ type: MSG.CHAT_STREAM_ABORT });
    streaming = false;
    const last = chatHistory[chatHistory.length - 1];
    if (last?.streaming) {
      chatHistory = [...chatHistory.slice(0, -1), { ...last, streaming: false }];
    }
  }

  /**
   * Empties the current selection of reference pages in the context workspace.
   *
   * @returns {void}
   */
  function clearChatContext() {
    chatContext = [];
  }

  /**
   * Resets the entire chat state, clears references, and terminates running streaming threads.
   *
   * @returns {void}
   */
  function clearChatHistory() {
    chatHistory = [];
    chatContext = [];
    if (streaming) abortChat();
  }

  /**
   * Resets the demo database, clears storage telemetry, and reloads the sidepanel.
   * @returns {Promise<void>}
   */
  async function exitDemoMode() {
    try {
      // Reset the primary database
      await chrome.runtime.sendMessage({ type: MSG.RESET_DEMO_DB });

      // Cleanup local storage
      const storage = await chrome.storage.local.get(null);
      const keysToRemove = Object.keys(storage).filter(key => 
        key === 'isDemoMode' || key.startsWith('ad_')
      );
      
      await chrome.storage.local.remove(keysToRemove);

      // Force reload
      window.location.reload();
    } catch (e) {
      console.error("[DeepSurf:Sidepanel] Failed to fully exit demo mode:", e);
    }
  }

  let statusPollInterval = 0;
  /** @type {IntersectionObserver | null} */
  let chatObserver = null;

  onMount(() => {
    // Verify setup and demo mode status on load
    chrome.storage.local.get(["setupComplete", "isDemoMode"], (data) => {
      console.log("[DeepSurf:Sidepanel] Initial storage check:", data);
      setupComplete = !!data.setupComplete;
      isDemoMode = !!data.isDemoMode;
      isCheckingStorage = false;
    });

    // Updates state instantly if demo mode changes
    const onStorageChange = (changes, area) => {
      if (area === "local" && changes.isDemoMode) {
        console.log("[DeepSurf:Sidepanel] Storage changed, updating isDemoMode:", changes.isDemoMode.newValue);
        isDemoMode = !!changes.isDemoMode.newValue;
      }
    };
    chrome.storage.onChanged.addListener(onStorageChange);

    // Initial statistics load
    chrome.runtime.sendMessage({ type: MSG.GET_STATS })
      .then((res) => { stats = res?.stats ?? null; })
      .catch((e) => console.error("[DeepSurf:Sidepanel] Failed to fetch initial stats:", e));

    // Active polling fallback for GPU/Model status
    const pollStatus = () => {
      chrome.runtime.sendMessage({ type: MSG.GET_MODEL_STATUS })
        .then((res) => { if (res?.status) modelStatus = { ...modelStatus, ...res.status }; })
        .catch((e) => console.error("[DeepSurf:Sidepanel] Failed to poll model status:", e));
    };

    pollStatus();
    statusPollInterval = setInterval(pollStatus, 3000);

    // Query for any highlighting context
    chrome.runtime.sendMessage({ type: MSG.GET_PENDING_HIGHLIGHT })
      .then((res) => {
        if (res?.payload) {
          pendingHighlight = res.payload;
          activeTab = "canvas";
        }
      }).catch((e) => console.error("[DeepSurf:Sidepanel] Failed to get pending highlight:", e));

    const onMsg = (msg) => {
      if (msg.type === MSG.CANVAS_OPEN_PICKER) {
        pendingHighlight = msg.payload;
        activeTab = "canvas";
        chrome.runtime.sendMessage({ type: MSG.GET_PENDING_HIGHLIGHT }).catch((e) => console.error("[DeepSurf:Sidepanel] Failed to get pending highlight:", e));
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    // Ensure all listeners and timers are cleared to prevent memory leaks
    return () => {
      clearInterval(statusPollInterval);
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorageChange); // Clean up the storage listener
      chatObserver?.disconnect();
    };
  });

  // Model status short-circuit: once models finish loading and report ready status,
  // we clear the interval timer to save CPU cycles.
  $effect(() => {
    if (modelStatus.embedder === "ready" && modelStatus.llm === "ready") {
      clearInterval(statusPollInterval);
    }
  });

  // Infinite scroll virtualizer setup: we monitor message node intersections
  // to avoid rendering large numbers of nodes in the layout engine simultaneously.
  $effect(() => {
    if (chatEl && chatHistory.length > 0) {
      chatObserver?.disconnect();
      chatObserver = new IntersectionObserver(
        (entries) => {
          const next = new Set(visibleMsgIndices);
          for (const entry of entries) {
            const idx = Number(entry.target.dataset.msgIdx);
            if (isNaN(idx)) continue;
            if (entry.isIntersecting) next.add(idx);
            else next.delete(idx);
          }
          visibleMsgIndices = next;
        },
        { root: chatEl, rootMargin: "200px 0px" }
      );

      tick().then(() => {
        if (!chatEl) return;
        const sentinels = chatEl.querySelectorAll("[data-msg-idx]");
        for (const el of sentinels) chatObserver.observe(el);
      });
    }
  });

  /**
   * Updates state flags and persists setup status to chrome.storage.
   *
   * @returns {void}
   */
  function handleSetupComplete() {
    chrome.storage.local.set({ setupComplete: true });
    setupComplete = true;

    chrome.runtime.sendMessage({ type: MSG.GET_STATS })
      .then((res) => { stats = res?.stats ?? null; })
      .catch((e) => console.error("[DeepSurf:Sidepanel] Failed to refresh stats after setup:", e));
  }
</script>

{#if isCheckingStorage}
  <div class="h-screen flex items-center justify-center bg-zinc-950">
    <div class="w-6 h-6 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin"></div>
  </div>
{:else if !setupComplete}
  <Setup onComplete={handleSetupComplete} />
{:else}
<div class="h-screen flex flex-col bg-zinc-950 text-zinc-100 overflow-hidden select-none">
  
  <header class="flex items-center gap-3 px-4 pt-4 pb-3 shrink-0">
    <div class="w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner">
      <Logo class="w-11 h-11 text-violet-500" />
    </div>
    <div>
      <h1 class="text-base font-semibold tracking-tight text-zinc-100 leading-none">DeepSurf</h1>
      <p class="text-[9px] font-mono text-zinc-500 tracking-widest leading-none mt-1 uppercase">History Manager</p>
    </div>
    {#if isDemoMode}
      <button 
        class="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 transition-colors text-xs font-semibold text-zinc-500 hover:text-zinc-300"
        onclick={exitDemoMode}
      >
        Exit Demo
      </button>
    {/if}
  </header>

  <ModelStatus status={modelStatus} />

  <TabNav bind:activeTab {stats} />

  <div class="flex-1 overflow-hidden flex flex-col">
    {#if activeTab === "search"}
      <div class="flex-1 flex flex-col overflow-hidden">
        <div class="px-5 py-4 border-b border-zinc-800/60 shrink-0 bg-zinc-950/80 backdrop-blur-md z-10">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner">
              <svg class="w-4 h-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <div>
              <h2 class="text-sm font-medium text-zinc-100">Semantic Search</h2>
              <p class="text-[10px] text-zinc-500 font-mono tracking-wider mt-0.5 uppercase">Vector & Lexical Hybrid</p>
            </div>
          </div>
        </div>
        <div class="px-3 pt-3 pb-5 shrink-0">
          <SearchBar onSearch={handleSearch} />
        </div>

        <div class="flex-1 overflow-y-auto px-3 pb-3 space-y-2 scrollbar-thin">
          {#if searching}
            {#each [1,2,3] as _}
              <div class="h-20 rounded-xl bg-zinc-800/40 border border-zinc-800/60 animate-pulse"></div>
            {/each}
          {:else if results.length > 0}
            {#each results as result (result.url)}
              <ResultCard {result} onUseInChat={useResultInChat} />
            {/each}
          {:else if lastQuery}
            <div class="text-center py-12">
              <div class="text-2xl mb-2">🔍</div>
              <p class="text-sm text-zinc-600">No results for "{lastQuery}"</p>
              <p class="text-xs text-zinc-700 mt-1">Try browsing more pages to build your history</p>
            </div>
          {:else}
            <div class="py-20 flex flex-col items-center text-center px-6">
              <div class="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
                <svg class="w-5 h-5 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
              </div>
              <p class="text-sm font-medium text-zinc-300">Search your browsing history</p>
              <p class="text-xs text-zinc-500 mt-2 leading-relaxed max-w-[250px]">Vector and lexical hybrid search across everything you've visited.</p>
            </div>
          {/if}
        </div>
      </div>

    {:else if activeTab === "canvas"}
      <div class="flex-1 overflow-hidden">
        <ResearchCanvas
          {pendingHighlight}
          onHighlightConsumed={() => { pendingHighlight = null; }}
        />
      </div>

    {:else if activeTab === "manage"}
      <ManageTab />

    {:else if activeTab === "analytics"}
      <div class="flex-1 overflow-hidden bg-zinc-950">
        <AnalyticsTab />
      </div>

    {:else}
      <div class="flex-1 flex flex-col overflow-hidden">
        
        <div class="px-5 py-4 border-b border-zinc-800/60 shrink-0 bg-zinc-950/80 backdrop-blur-md z-10">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner">
              <svg class="w-4 h-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
            </div>
            <div>
              <h2 class="text-sm font-medium text-zinc-100">History Chat</h2>
              <p class="text-[10px] text-zinc-500 font-mono tracking-wider mt-0.5 uppercase">RAG Assistant</p>
            </div>
          </div>
        </div>

        {#if chatContext.length > 0 || chatHistory.length > 0}
          <div class="px-3 pt-2 pb-1 flex items-center gap-1.5 flex-wrap border-b border-zinc-800/40">
            {#if chatContext.length > 0}
              <span class="text-[9px] font-mono text-zinc-600 tracking-wider">CTX:</span>
              {#each chatContext as ctx}
                <span class="flex items-center gap-1 bg-violet-900/30 border border-violet-800/40
                             rounded-md px-1.5 py-0.5 text-[10px] text-violet-300 max-w-[120px]">
                  <span class="truncate">{ctx.title || ctx.url}</span>
                  <button
                    onclick={() => { chatContext = chatContext.filter((c) => c.url !== ctx.url); }}
                    class="text-violet-600 hover:text-violet-400 shrink-0"
                    aria-label="Remove context"
                  >×</button>
                </span>
              {/each}
              <button
                onclick={clearChatContext}
                class="text-[9px] font-mono text-zinc-700 hover:text-zinc-500 {chatHistory.length === 0 ? 'ml-auto' : 'ml-2'}"
              >CLEAR CTX</button>
            {/if}

            {#if chatHistory.length > 0}
              <button
                onclick={clearChatHistory}
                class="text-[9px] font-mono text-red-500 hover:text-red-400 ml-auto flex items-center gap-1 transition-colors"
              >
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                CLEAR CHAT
              </button>
            {/if}
          </div>
        {/if}

        <div bind:this={chatEl} class="flex-1 overflow-y-auto p-3 scrollbar-thin">
          
          {#if modelStatus.llm === "unsupported"}
            <div class="h-full flex flex-col items-center justify-center text-center gap-3 py-8">
              <div class="w-12 h-12 rounded-2xl bg-zinc-800/40 border border-zinc-700/30 flex items-center justify-center">
                <svg class="w-6 h-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 5.636l-12.728 12.728M5.636 5.636l12.728 12.728" />
                </svg>
              </div>
              <div>
                <p class="text-sm font-medium text-zinc-400">Hardware Incompatible</p>
                <p class="text-xs text-zinc-600 mt-1 leading-relaxed max-w-[200px] mx-auto">
                  Local chat requires a WebGPU-compatible graphics card. 
                  <br><br>
                  <span class="text-violet-400">Hybrid Search is fully active on your CPU!</span>
                </p>
              </div>
            </div>

          {:else if chatHistory.length === 0}
            <div class="h-full flex flex-col items-center justify-center text-center gap-3 py-8 px-6">
              <div class="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-2">
                <svg class="w-5 h-5 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
              </div>
              <div>
                <p class="text-sm font-medium text-zinc-300">Chat with your history</p>
                <p class="text-xs text-zinc-500 mt-2 leading-relaxed max-w-[250px] mx-auto">
                  Ask anything. DeepSurf auto-retrieves relevant pages as context.
                </p>
              </div>
              <div class="grid grid-cols-1 gap-1.5 w-full max-w-[220px] mt-4">
                {#each [
                  "What did I read about AI last week?",
                  "Summarize the articles I visited about Python",
                  "What recipes have I browsed recently?"
                ] as suggestion}
                  <button
                    onclick={() => sendChatMessage(suggestion)}
                    class="text-left text-xs text-zinc-400 hover:text-zinc-200
                           bg-zinc-900 hover:bg-zinc-800
                           border border-zinc-800
                           rounded-xl px-3 py-2 transition-all duration-150"
                  >
                    {suggestion}
                  </button>
                {/each}
              </div>
            </div>
          {:else}
            {#each chatHistory as message, i (i)}
              {@const isNearVisible =
                visibleMsgIndices.has(i) ||
                visibleMsgIndices.has(i - 1) ||
                visibleMsgIndices.has(i - 2) ||
                visibleMsgIndices.has(i + 1) ||
                visibleMsgIndices.has(i + 2) ||
                i >= chatHistory.length - 3}
              <div data-msg-idx={i}>
                {#if isNearVisible}
                  <ChatMessage {message} />
                {:else}
                  <div class="mb-3" style="min-height:60px"></div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <ChatInput
          onSend={sendChatMessage}
          onAbort={abortChat}
          {streaming}
          disabled={modelStatus.embedder !== "ready" || modelStatus.llm === "unsupported"}
        />
      </div>
    {/if}
  </div>
</div>
{/if}