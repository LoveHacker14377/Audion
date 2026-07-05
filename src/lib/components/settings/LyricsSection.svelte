<script lang="ts">
    import { _ } from "svelte-i18n";
    import { sourcePriorityRaw, setSourcePriority, lyricsStore } from "$lib/stores/lyrics";
    import { addToast } from "$lib/stores/toast";
    import { confirm } from "$lib/stores/dialogs";
    import { slide } from "svelte/transition";
    import { createEventDispatcher } from "svelte";
  
    export let open: boolean = false;
    const dispatch = createEventDispatcher();
  
    // ---------------------------------------------------------------------
    // lyrics: source priority
    // ---------------------------------------------------------------------
  
    let priorityInput = $sourcePriorityRaw;
    let priorityChanged = false;
    let priorityError = "";
  
    // Keep the local field in sync with the store when it changes elsewhere
    // (e.g. reset from another tab), but never clobber an in-progress edit
    $: if (!priorityChanged && priorityInput !== $sourcePriorityRaw) {
      priorityInput = $sourcePriorityRaw;
    }
  
    function handlePriorityInput() {
      priorityChanged = priorityInput.trim() !== $sourcePriorityRaw.trim();
      priorityError = "";
    }
  
    function handlePrioritySave() {
      const ok = setSourcePriority(priorityInput.trim());
      if (ok) {
        priorityChanged = false;
        priorityError = "";
        addToast("Lyrics source priority saved", "success");
      } else {
        priorityError =
          'Invalid format — lowercase letters and single "/" separators only, e.g. apple/imported/genius. Unknown tokens are also rejected.';
        addToast("Invalid lyrics priority format", "error");
      }
    }
  
    function handlePriorityReset() {
      priorityInput = "";
      priorityChanged = priorityInput.trim() !== $sourcePriorityRaw.trim();
      priorityError = "";
    }
  
    // ---------------------------------------------------------------------
    // lyrics: bulk delete by token
    // ---------------------------------------------------------------------
  
    let deleteToken = "";
    let isBulkDeletingLyrics = false;
  
    function tokenDisplayLabel(token: string): string {
      const t = token.trim().toLowerCase();
      if (!t) return "";
      if (t === "all") return "All";
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
  
    async function handleBulkDeleteLyrics() {
      const token = deleteToken.trim().toLowerCase();
      if (!token) {
        addToast("Type a source token first", "error");
        return;
      }
  
      const label = tokenDisplayLabel(token);
      const message =
        token === "all"
          ? "Delete ALL cached lyrics — every source, including imported files — for every track in your library? This cannot be undone."
          : `Delete all "${label}" lyrics for every track in your library? This cannot be undone.`;
  
      const ok = await confirm(message, {
        title: token === "all" ? "Delete All Lyrics" : `Delete ${label} Lyrics`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
  
      isBulkDeletingLyrics = true;
      try {
        const count = await lyricsStore.deleteLyricsByToken(token);
        addToast(
          count > 0
            ? `Deleted ${count} ${label} lyrics file${count === 1 ? "" : "s"}`
            : `No cached ${label} lyrics found to delete`,
          count > 0 ? "success" : "error",
        );
        if (count > 0) deleteToken = "";
      } catch (err) {
        console.error("[Settings] Bulk lyrics delete failed:", err);
        addToast(`Failed to delete ${label} lyrics`, "error");
      } finally {
        isBulkDeletingLyrics = false;
      }
    }
  </script>
  
  <section class="settings-section" aria-labelledby="lyrics-heading">
    <button class="accordion-trigger" on:click={() => dispatch('toggle')} aria-expanded={open}>
      <svg class="accordion-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
      <div class="accordion-header-info">
        <span class="accordion-title">{$_('settings.lyrics', { default: 'Lyrics' })}</span>
        <span class="accordion-subtitle">{$_('settings.lyricsSubtitle', { default: 'Manage automatic source priority and cached lyrics' })}</span>
      </div>
      <svg class="accordion-chevron" class:rotated={open} viewBox="0 0 24 24" width="16" height="16">
        <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none"/>
      </svg>
    </button>
    {#if open}
      <div class="section-body" transition:slide|local>
        <div class="settings-card">
  
          <!-- source priority -->
          <div class="inner-section">
            <span class="setting-title">Auto-fetch source priority</span>
            <span class="setting-description">
              Controls the order sources are tried automatically, e.g. <code>apple/imported/genius</code>.
              Lowercase letters and single "/" separators only. Leave blank to use the default order.
              Manual source selection in the lyrics panel is unaffected.
            </span>
            <div class="lyrics-priority-row">
              <input
                type="text"
                class="lyrics-text-input"
                bind:value={priorityInput}
                on:input={handlePriorityInput}
                on:keydown={(e) => e.key === 'Enter' && priorityChanged && handlePrioritySave()}
                placeholder="apple/imported/genius"
                aria-label="Lyrics source priority"
              />
              {#if priorityChanged}
                <button class="btn-outline-compact" on:click={handlePrioritySave}>Save</button>
              {/if}
            </div>
            {#if priorityInput.trim() !== '' && priorityChanged}
              <button class="lyrics-priority-clear" on:click={handlePriorityReset}>Reset to default</button>
            {/if}
            {#if priorityError}
              <p class="error-message" role="alert">{priorityError}</p>
            {/if}
          </div>
  
          <div class="divider"></div>
  
          <!-- bulk delete by token -->
          <div class="inner-section">
            <span class="setting-title">Delete cached lyrics</span>
            <span class="setting-description">
              Permanently delete every cached lyrics file for a given source, across your whole library.
              Type a source token (e.g. <code>apple</code>, <code>imported</code>, or <code>all</code> for everything).
            </span>
            <div class="lyrics-delete-row">
              <span class="lyrics-delete-label">Delete all</span>
              <input
                type="text"
                class="lyrics-text-input lyrics-token-input"
                bind:value={deleteToken}
                placeholder="token"
                aria-label="Lyrics source token to delete"
                disabled={isBulkDeletingLyrics}
              />
              <span class="lyrics-delete-label">lyrics</span>
              <button
                class="lyrics-delete-btn"
                on:click={handleBulkDeleteLyrics}
                disabled={isBulkDeletingLyrics || !deleteToken.trim()}
                aria-label="Delete lyrics for this source"
                title="Delete all cached lyrics for this source"
              >
                {#if isBulkDeletingLyrics}
                  <div class="lyrics-delete-spinner"></div>
                {:else}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M6 7h12v2H6zm2 3h2v9H8zm6 0h2v9h-2zM9 4h6l1 2H8z"/>
                  </svg>
                {/if}
              </button>
            </div>
          </div>
  
        </div>
      </div>
    {/if}
  </section>