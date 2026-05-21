<script>
  /**
   * @fileoverview Provides a tabbed navigation bar for switching between Search, Chat, Canvas, Manage, and Insights panels.
   *
   * Positioned at the top of the extension's side panel page wrapper. Mutates the activeTab prop bindable value on click.
   */

  let { activeTab = $bindable("search"), stats } = $props();

  const tabs = [
    { id: "search", label: "SEARCH" },
    { id: "chat", label: "CHAT" },
    { id: "canvas", label: "CANVAS" },
    { id: "manage", label: "MANAGE" },
    { id: "analytics", label: "INSIGHTS" }
  ];
</script>

<div class="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 overflow-x-auto scrollbar-none">
  <div class="flex gap-0.5 rounded-lg bg-zinc-800/60 p-0.5">
    {#each tabs as tab}
      <button
        onclick={() => (activeTab = tab.id)}
        class="
          px-3 py-1 rounded-md text-[10px] font-mono tracking-widest whitespace-nowrap
          transition-all duration-200
          {activeTab === tab.id
            ? 'bg-violet-600/90 text-white shadow-sm'
            : 'text-zinc-500 hover:text-zinc-300'}
        "
      >
        {tab.label}
      </button>
    {/each}
  </div>

  {#if stats && stats.total != null}

    <!-- We hide page statistics on extremely narrow viewport layouts to prevent label wrapping and layout clipping. -->
    <div class="text-[9px] font-mono text-zinc-700 tracking-wider shrink-0 ml-3 hidden sm:block">
      {stats.total.toLocaleString()} PAGES
    </div>
  {/if}
</div>

<style>
  .scrollbar-none::-webkit-scrollbar {
    display: none;
  }
  .scrollbar-none {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>