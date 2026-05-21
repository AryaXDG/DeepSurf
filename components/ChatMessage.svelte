<script>
  /**
   * @fileoverview Displays a single chat message formatted differently depending on whether the sender is the user or the assistant.
   *
   * Instantiated dynamically in a scrollable message list inside the AI Chat tab. Does not produce any side effects.
   */

  import Logo from "./Logo.svelte";
  /** @type {{ role: "user"|"assistant", content: string, streaming?: boolean }} */
  let { message } = $props();

  const isUser = $derived(message.role === "user");
</script>

<div class="flex {isUser ? 'justify-end' : 'justify-start'} mb-3">
  {#if !isUser}
    <div class="w-5 h-5 rounded-full bg-gradient-to-br from-violet-600 to-fuchsia-600
                flex items-center justify-center shrink-0 mt-0.5 mr-2">
      <Logo class="w-2.5 h-2.5 text-white" />
    </div>
  {/if}

  <div class="
    max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed
    {isUser
      ? 'bg-violet-600/80 text-white rounded-br-sm'
      : 'bg-zinc-800/80 text-zinc-200 rounded-bl-sm border border-zinc-700/40'}
  ">
    {#if message.streaming && message.content === ""}

      <!-- Show bouncing dots to indicate system activity when the assistant stream has started but no text has arrived yet. -->
      <span class="inline-flex gap-1 items-center">
        <span class="w-1 h-1 rounded-full bg-zinc-500 animate-bounce" style="animation-delay:0ms"></span>
        <span class="w-1 h-1 rounded-full bg-zinc-500 animate-bounce" style="animation-delay:150ms"></span>
        <span class="w-1 h-1 rounded-full bg-zinc-500 animate-bounce" style="animation-delay:300ms"></span>
      </span>
    {:else}
      {message.content}{#if message.streaming}<span class="inline-block w-0.5 h-3.5 bg-violet-400 ml-0.5 animate-pulse align-middle"></span>{/if}
    {/if}
  </div>
</div>
