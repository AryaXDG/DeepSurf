<script>
  /**
   * @fileoverview Renders a single history search result item, showing title, metadata, snippet text, and similarity score.
   *
   * Instantiated dynamically within the search result list container on the Search tab. Requests favicon assets from Google's static favicon server dynamically based on the domain URL.
   */

  import { relativeTime, extractDomain } from "../lib/utils.js";

  /** @type {import("../lib/messages.js").SearchResult} */
  let { result, onUseInChat } = $props();

  const domain = $derived(extractDomain(result.url));
  const when = $derived(relativeTime(result.visitedAt));
  const scorePercent = $derived(Math.round(result.score * 100));
</script>

<article class="
  group relative rounded-xl border border-zinc-800/60 bg-zinc-900/50
  hover:border-violet-700/40 hover:bg-zinc-800/60
  transition-all duration-200 overflow-hidden
">
  <div
    class="absolute top-0 left-0 h-0.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
    style="width:{scorePercent}%"
  ></div>

  <div class="p-3 pt-3.5">
    <div class="flex items-start gap-2 mb-1.5">

      <!-- We request favicons through Google's service to avoid keeping local copies or running into site-specific CORS blocks. -->
      <!-- If a favicon fails to load, the error listener hides the img element to prevent showing broken browser icon placeholders. -->
      <img
        src="https://www.google.com/s2/favicons?sz=16&domain={domain}"
        alt=""
        class="w-4 h-4 mt-0.5 rounded shrink-0"
        onerror={(e) => e.target.style.display = 'none'}
      />
      <div class="min-w-0 flex-1">
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-sm font-medium text-zinc-100 leading-tight hover:text-violet-300
                 transition-colors line-clamp-1 block"
        >
          {result.title || domain}
        </a>
        <div class="flex items-center gap-1.5 mt-0.5">
          <span class="text-[10px] text-zinc-600 font-mono truncate">{domain}</span>
          <span class="text-zinc-700">·</span>
          <span class="text-[10px] text-zinc-600 shrink-0">{when}</span>
        </div>
      </div>
      <span class="text-[9px] font-mono text-zinc-700 shrink-0 pt-0.5">
        {scorePercent}%
      </span>
    </div>

    <p class="text-xs text-zinc-500 leading-relaxed line-clamp-2 mb-2">
      {result.snippet}
    </p>

    <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
      <button
        onclick={() => onUseInChat(result)}
        class="text-[10px] font-mono text-violet-400 hover:text-violet-300
               border border-violet-800/60 hover:border-violet-600/60
               px-2 py-0.5 rounded-md transition-all duration-150"
      >
        + CHAT
      </button>
      <a
        href={result.url}
        target="_blank"
        rel="noopener noreferrer"
        class="text-[10px] font-mono text-zinc-600 hover:text-zinc-400
               border border-zinc-800 hover:border-zinc-700
               px-2 py-0.5 rounded-md transition-all duration-150"
      >
        VISIT →
      </a>
    </div>
  </div>
</article>