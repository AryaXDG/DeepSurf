<script>
  /**
   * @fileoverview Displays the initialization status and loading progress of local AI models.
   *
   * Displayed as a status bar sub-header in the extension's side panel template. Does not produce any side effects.
   */

  /** @type {{ embedder: string, llm: string, llmProgress?: number }} */
  let { status } = $props();

  /**
   * Translates model state strings into Tailwind text color class utility names.
   * @param {string} s - The current model status key.
   * @returns {string} The text color utility class name.
   */
  const statusColor = (s) =>
    s === "ready" ? "text-emerald-400" :
    s === "loading" ? "text-amber-400" :
    s === "unsupported" ? "text-zinc-500" :
    s === "error" ? "text-red-400" :
    "text-zinc-500";

  /**
   * Translates model state strings into Tailwind background color class names for status indicators.
   * @param {string} s - The current model status key.
   * @returns {string} The background color utility class name.
   */
  const statusDot = (s) =>
    s === "ready" ? "bg-emerald-400" :
    s === "loading" ? "bg-amber-400 animate-pulse" :
    s === "unsupported" ? "bg-zinc-600" :
    s === "error" ? "bg-red-400" :
    "bg-zinc-600";
</script>

<div class="flex items-center gap-3 px-3 py-1.5 text-[10px] font-mono tracking-wide border-b border-zinc-800/60">
  <div class="flex items-center gap-1.5">
    <span class="w-1.5 h-1.5 rounded-full {statusDot(status.embedder)}"></span>
    <span class="{statusColor(status.embedder)}">
      EMBED
      {#if status.embedder === "loading"}…{/if}
    </span>
  </div>

  <span class="text-zinc-700">|</span>

  <div class="flex items-center gap-1.5 flex-1">
    <span class="w-1.5 h-1.5 rounded-full {statusDot(status.llm)}"></span>
    <span class="{statusColor(status.llm)} flex-1 flex items-center justify-between">
      <span>LLM</span>
      {#if status.llm === "unsupported"}
        <div class="flex items-center gap-2">
          <span class="text-[9px]">(NO GPU)</span>
          <button 
            class="text-[9px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded cursor-pointer transition-colors"
            onclick={() => { chrome.runtime.sendMessage({ type: "INIT_MODELS" }).catch(console.error); }}
          >
            RECHECK
          </button>
        </div>
      {:else if status.llm === "loading" && status.llmProgress != null}
        <span class="ml-1 text-zinc-500">{status.llmProgress}%</span>
        <div class="mt-0.5 w-full h-0.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            class="h-full bg-amber-400 transition-all duration-300 rounded-full"
            style="width:{status.llmProgress}%"
          ></div>
        </div>
      {:else if status.llm === "loading"}
        …
      {/if}
    </span>
  </div>
</div>