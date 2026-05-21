<script>
  /**
   * @fileoverview Handles user chat inputs, manages auto-expanding textareas, and dispatches message send and abort actions.
   *
   * Displayed at the bottom of the AI Chat panel interface. Modifies DOM style properties directly during input events to dynamically resize the textarea.
   */

  let { onSend, onAbort, streaming = false, disabled = false } = $props();

  let text = $state("");

  /**
   * Listens for the Enter key without the Shift key to trigger a form submission.
   * @param {KeyboardEvent} e - The keydown event object.
   * @returns {void}
   */
  function handleKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  /**
   * Triggers the message dispatch callback with the current input string after trimming whitespace.
   * @returns {void}
   */
  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    text = "";
    onSend(t);
  }
</script>

<div class="border-t border-zinc-800/60 p-3">
  <div class="flex items-end gap-2 rounded-xl bg-zinc-800/60 border border-zinc-700/40
              focus-within:border-violet-500/50 transition-colors duration-200 px-3 py-2">
    <textarea
      bind:value={text}
      onkeydown={handleKeydown}
      placeholder={streaming ? "Generating…" : "Ask about your history…"}
      disabled={streaming}
      rows="1"
      class="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600
             resize-none outline-none leading-relaxed max-h-24 disabled:opacity-50
             caret-violet-400"
      oninput={(e) => {
        const el = /** @type {HTMLTextAreaElement} */ (e.target);

        // We temporarily reset the height to auto before reading scrollHeight to ensure the text box shrinks correctly when lines are deleted.
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 96) + "px";
      }}
    ></textarea>

    {#if streaming}
      <button
        onclick={onAbort}
        class="shrink-0 w-7 h-7 rounded-lg bg-red-600/80 hover:bg-red-500
               flex items-center justify-center transition-colors duration-150"
        aria-label="Stop generation"
      >
        <svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
      </button>
    {:else}
      <button
        onclick={submit}
        disabled={!text.trim() || disabled}
        class="shrink-0 w-7 h-7 rounded-lg bg-violet-600 hover:bg-violet-500
               disabled:opacity-30 disabled:cursor-not-allowed
               flex items-center justify-center transition-all duration-150"
        aria-label="Send"
      >
        <svg class="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"
            d="M12 19V5m-7 7l7-7 7 7" />
        </svg>
      </button>
    {/if}
  </div>

  <p class="text-[9px] font-mono text-zinc-700 text-center mt-1.5 tracking-wider">
    RUNS LOCALLY · NO CLOUD · WEBGPU
  </p>
</div>
