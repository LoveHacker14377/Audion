<script lang="ts">
  import { onMount, tick } from "svelte";
  import "../app.css";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import MainView from "$lib/components/MainView.svelte";
  import PlayerBar from "$lib/components/PlayerBar.svelte";
  import LyricsPanel from "$lib/components/LyricsPanel.svelte";
  import FullScreenPlayer from "$lib/components/FullScreenPlayer.svelte";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import QueuePanel from "$lib/components/QueuePanel.svelte";
  import MiniPlayer from "$lib/components/MiniPlayer.svelte";
  import KeyboardShortcuts from "$lib/components/KeyboardShortcuts.svelte";
  import KeyboardShortcutsHelp from "$lib/components/KeyboardShortcutsHelp.svelte";

  import { loadLibrary, loadPlaylists } from "$lib/stores/library";
  import ToastContainer from "$lib/components/ToastContainer.svelte";
  import { isTauri } from "$lib/api/tauri";
  import {
    initializeFromPersistedState,
    setupAutoSave,
  } from "$lib/stores/persist";
  import { theme } from "$lib/stores/theme";
  import { isMiniPlayer } from "$lib/stores/ui";
  import { pluginStore } from "$lib/stores/plugin-store";
  import { appSettings } from "$lib/stores/settings";
  import { isMobile, mobileSearchOpen } from "$lib/stores/mobile";
  import MobileBottomNav from "$lib/components/MobileBottomNav.svelte";
  import { searchQuery, clearSearch } from "$lib/stores/search";
  import { currentView, goToHome } from "$lib/stores/view";
  import PluginUpdateDialog from "$lib/components/PluginUpdateDialog.svelte";

  let isLoading = true;
  let notInTauri = false;
  let audioElement: HTMLAudioElement | null = null;

  function handleContextMenu(e: MouseEvent) {
    if (!$appSettings.developerMode) {
      e.preventDefault();
    }
  }

  // Mobile search handling
  let mobileSearchInput = '';
  let mobileSearchInputEl: HTMLInputElement;
  let mobileSearchTimer: ReturnType<typeof setTimeout>;

  function handleMobileSearchInput(e: Event) {
    const target = e.target as HTMLInputElement;
    mobileSearchInput = target.value;
    clearTimeout(mobileSearchTimer);
    mobileSearchTimer = setTimeout(() => {
      searchQuery.set(mobileSearchInput);
    }, 200);
  }

  function closeMobileSearch() {
    mobileSearchOpen.set(false);
    mobileSearchInput = '';
    clearSearch();
  }

  // Auto-focus mobile search input when opened
  $: if ($mobileSearchOpen && mobileSearchInputEl) {
    tick().then(() => mobileSearchInputEl?.focus());
  }

  // On mobile, default to home view on first load
  let mobileInitialized = false;
  $: if ($isMobile && !mobileInitialized && !isLoading) {
    mobileInitialized = true;
    goToHome();
  }

  onMount(async () => {
    // Initialize persisted state (volume, lyrics visibility, etc.)
    initializeFromPersistedState();
    setupAutoSave();

    // Check if we're in Tauri environment
    if (!isTauri()) {
      notInTauri = true;
      isLoading = false;
      return;
    }

    try {
      const dataLoadStart = performance.now();
      await Promise.all([loadLibrary(), loadPlaylists()]);
    } catch (error) {
      console.error("Failed to load library:", error);
    } finally {
      isLoading = false;

      // Lazy load plugins- reduce startup time
      requestIdleCallback(() => {
        const pluginLoadStart = performance.now();
        console.log("  [PLUGINS] Starting lazy load...");

        pluginStore
          .init()
          .then(() => {
            console.log(
              `  [PLUGINS] Loaded in background: ${(performance.now() - pluginLoadStart).toFixed(2)}ms`,
            );
          })
          .catch((error) => {
            console.error("[PLUGINS] Failed to load:", error);
          });
      });
    }
  });
</script>

<svelte:window on:contextmenu={handleContextMenu} />

<div class="app-container">
  {#if notInTauri}
    <div class="loading-screen">
      <div class="logo">
        <img src="/logo.png" alt="Audion Logo" width="48" height="48" />
        <span>Audion</span>
      </div>
      <p
        style="color: var(--text-primary); font-size: 1.1rem; margin-top: 1rem;"
      >
        🖥️ Please open the Tauri desktop app
      </p>
      <p>This app requires the Tauri desktop window to function.</p>
      <p style="opacity: 0.7; font-size: 0.8rem;">
        The Tauri window should open automatically when running <code
          >npm run tauri dev</code
        >
      </p>
    </div>
  {:else if isLoading}
    <div class="loading-screen">
      <div class="logo">
        <img src="/logo.png" alt="Audion Logo" width="48" height="48" />
        <span>Audion</span>
      </div>
      <div class="loading-spinner"></div>
      <p>Loading your music library...</p>
    </div>
  {:else}
    {#if $isMobile}
      <!-- ========= MOBILE LAYOUT (Spotify-like) ========= -->
      <div class="mobile-layout">
        {#if $mobileSearchOpen}
          <div class="mobile-search-header">
            <div class="mobile-search-bar">
              <svg class="search-icon" viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
              </svg>
              <input
                type="text"
                class="mobile-search-input"
                placeholder="What do you want to listen to?"
                bind:value={mobileSearchInput}
                bind:this={mobileSearchInputEl}
                on:input={handleMobileSearchInput}
                on:keydown={(e) => e.key === 'Escape' && closeMobileSearch()}
                spellcheck="false"
              />
              <button class="mobile-search-cancel" on:click={closeMobileSearch}>
                Cancel
              </button>
            </div>
          </div>
        {/if}

        <div class="mobile-content">
          <MainView />
        </div>
      </div>

      <!-- PlayerBar always rendered for audio element -->
      <PlayerBar bind:audioElementRef={audioElement} hidden={$isMiniPlayer} />
      <MobileBottomNav />

      <FullScreenPlayer />
      <ContextMenu />
      <QueuePanel />
      <LyricsPanel />
    {:else}
      <!-- ========= DESKTOP LAYOUT ========= -->
      <div class="app-layout">
        <Sidebar />
        <MainView />
        <LyricsPanel />
        <QueuePanel />
        <FullScreenPlayer />
        <ContextMenu />
      </div>
      <PlayerBar bind:audioElementRef={audioElement} hidden={$isMiniPlayer} />
      <MiniPlayer />
      <KeyboardShortcuts />
      <KeyboardShortcutsHelp />
    {/if}

    <ToastContainer />
    {#if $pluginStore.pendingUpdates.length > 0}
      <PluginUpdateDialog on:close={() => pluginStore.clearPendingUpdates()} />
    {/if}
  {/if}
</div>

<style>
  .app-container {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: var(--bg-base);
  }

  .loading-screen {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-lg);
  }

  .logo {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    color: var(--accent-primary);
    font-size: 2rem;
    font-weight: 700;
  }

  .loading-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--bg-highlight);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading-screen p {
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .app-layout {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  /* ========= MOBILE LAYOUT ========= */
  .mobile-layout {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: var(--bg-base);
  }

  .mobile-search-header {
    padding: var(--spacing-md);
    padding-top: var(--spacing-lg);
    background-color: var(--bg-base);
    flex-shrink: 0;
  }

  .mobile-search-bar {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    background-color: var(--bg-elevated);
    border-radius: var(--radius-md);
    padding: 0 var(--spacing-md);
    height: 48px;
  }

  .mobile-search-bar .search-icon {
    color: var(--text-subdued);
    flex-shrink: 0;
  }

  .mobile-search-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 1rem;
    min-width: 0;
    height: 100%;
    user-select: text;
    -webkit-user-select: text;
  }

  .mobile-search-input::placeholder {
    color: var(--text-subdued);
  }

  .mobile-search-cancel {
    color: var(--text-primary);
    font-size: 0.875rem;
    font-weight: 500;
    padding: 8px;
    flex-shrink: 0;
  }

  .mobile-content {
    flex: 1;
    overflow: hidden;
  }
</style>
