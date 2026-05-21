<script>
  /**
   * @fileoverview Provides a responsive search input bar that filters history items using debounced inputs.
   *
   * Positioned at the top of the search tab in the side panel interface, invoking search callbacks. Triggers debounced state updates that propagate through Svelte effects, initiating database query routing.
   */

  import { debounce } from "../lib/utils.js";

  let { onSearch, placeholder = "Search your history…" } = $props();

  let query = $state("");
  let focused = $state(false);

  /**
   * Debounces search query updates to avoid firing database requests on every keystroke.
   * @param {string} q - The search query string.
   * @returns {void}
   */
  const debouncedSearch = debounce((q) => {
    if (q.trim()) onSearch(q.trim());
    else onSearch("");
  }, 300);

  $effect(() => {
    debouncedSearch(query);
  });

  /**
   * Clears the query and blurs the input element when the Escape key is pressed.
   * @param {KeyboardEvent} e - The keydown event.
   * @returns {void}
   */
  function handleKeydown(e) {

    // Pressing escape is handled here to allow users to quickly exit the search context and clear results.
    if (e.key === "Escape") {
      query = "";
      e.currentTarget.blur();
    }
  }
</script>

<div class="relative">
  <div class="
    flex items-center gap-2.5 px-3 py-2.5 rounded-xl
    bg-zinc-800/70 border transition-all duration-200
    {focused ? 'border-violet-500/60 shadow-lg shadow-violet-900/20' : 'border-zinc-700/50'}
  ">
    <svg class="w-4 h-4 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>

    <input
      type="text"
      bind:value={query}
      {placeholder}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      onkeydown={handleKeydown}
      class="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600
             outline-none caret-violet-400"
    />

    {#if query.length > 0}
      <button
        onclick={() => (query = "")}
        class="text-zinc-600 hover:text-zinc-400 transition-colors"
        aria-label="Clear search"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    {/if}
  </div>

  {#if query.length > 0}
    <div class="absolute right-3 -bottom-4 text-[9px] text-zinc-700 font-mono tracking-widest">
      HYBRID · VEC+LEX
    </div>
  {/if}
</div>
