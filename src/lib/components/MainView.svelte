<script lang="ts">
    import { currentView } from "$lib/stores/view";
    import { tracks, albums, artists } from "$lib/stores/library";
    import {
        searchQuery,
        searchResults,
        clearSearch,
    } from "$lib/stores/search";

    import TrackList from "./TrackList.svelte";
    import AlbumGrid from "./AlbumGrid.svelte";
    import AlbumDetail from "./AlbumDetail.svelte";
    import ArtistGrid from "./ArtistGrid.svelte";
    import ArtistDetail from "./ArtistDetail.svelte";
    import PlaylistView from "./PlaylistView.svelte";
    import PlaylistDetail from "./PlaylistDetail.svelte";
    import SearchResults from "./SearchResults.svelte";

    import PluginManager from "./PluginManager.svelte";
    import Settings from "./Settings.svelte";

    let searchInput = "";
    let searchDebounceTimer: ReturnType<typeof setTimeout>;

    function handleSearchInput(e: Event) {
        const target = e.target as HTMLInputElement;
        searchInput = target.value;

        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            searchQuery.set(searchInput);
        }, 200);
    }

    function handleClearSearch() {
        searchInput = "";
        clearSearch();
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            handleClearSearch();
        }
    }

    $: isSearching = $searchQuery.length > 0;
    $: hideSearchBar = $currentView.type === 'settings' || $currentView.type === 'plugins';
    import GlobalShortcuts from "./GlobalShortcuts.svelte";
</script>

<main class="main-view">
    <GlobalShortcuts />
    <!-- Search Bar -->
    {#if !hideSearchBar}
    <div class="search-bar">
        <div class="search-input-wrapper">
            <svg
                class="search-icon"
                viewBox="0 0 24 24"
                fill="currentColor"
                width="20"
                height="20"
            >
                <path
                    d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
                />
            </svg>
            <input
                type="text"
                class="search-input"
                placeholder="Search tracks, albums, artists..."
                bind:value={searchInput}
                on:input={handleSearchInput}
                on:keydown={handleKeydown}
            />
            {#if searchInput}
                <button
                    class="clear-search"
                    on:click={handleClearSearch}
                    title="Clear search"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        width="18"
                        height="18"
                    >
                        <path
                            d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                        />
                    </svg>
                </button>
            {/if}
        </div>
    </div>
    {/if}

    {#if isSearching}
        <div class="view-container">
            <header class="view-header">
                <h1>Search Results</h1>
            </header>
            <div class="view-content">
                <SearchResults />
            </div>
        </div>
    {:else if $currentView.type === "tracks"}
        <div class="view-container">
            <header class="view-header">
                <h1>All Tracks</h1>
            </header>
            <div class="view-content">
                <TrackList tracks={$tracks} showAlbum={true} />
            </div>
        </div>
    {:else if $currentView.type === "albums"}
        <div class="view-container">
            <header class="view-header">
                <h1>Albums</h1>
            </header>
            <div class="view-content">
                <AlbumGrid albums={$albums} />
            </div>
        </div>
    {:else if $currentView.type === "album-detail" && $currentView.id}
        <div class="view-container no-padding">
            <AlbumDetail albumId={$currentView.id} />
        </div>
    {:else if $currentView.type === "artists"}
        <div class="view-container">
            <header class="view-header">
                <h1>Artists</h1>
            </header>
            <div class="view-content">
                <ArtistGrid artists={$artists} />
            </div>
        </div>
    {:else if $currentView.type === "artist-detail" && $currentView.name}
        <div class="view-container no-padding">
            <ArtistDetail artistName={$currentView.name} />
        </div>
    {:else if $currentView.type === "playlists"}
        <div class="view-container no-padding">
            <PlaylistView />
        </div>
    {:else if $currentView.type === "playlist-detail" && $currentView.id}
        <div class="view-container no-padding">
            <PlaylistDetail playlistId={$currentView.id} />
        </div>
    {:else if $currentView.type === "plugins"}
        <div class="view-container no-padding">
            <PluginManager />
        </div>
    {:else if $currentView.type === "settings"}
        <div class="view-container no-padding">
            <Settings />
        </div>
    {:else}
        <div class="view-container">
            <div class="empty-state">
                <h2>Select a view from the sidebar</h2>
            </div>
        </div>
    {/if}
</main>

<style>
    .main-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background-color: var(--bg-base);
    }

    .view-container {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .view-container.no-padding .view-content {
        padding: 0;
    }

    .view-header {
        padding: var(--spacing-lg) var(--spacing-md);
        flex-shrink: 0;
    }

    .view-header h1 {
        font-size: 2rem;
        font-weight: 700;
    }

    .view-content {
        flex: 1;
        overflow-y: auto;
    }

    .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-subdued);
    }

    /* Search Bar */
    .search-bar {
        padding: var(--spacing-md);
        padding-bottom: 0;
        flex-shrink: 0;
    }

    .search-input-wrapper {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        background-color: var(--bg-elevated);
        border-radius: var(--radius-full);
        padding: var(--spacing-sm) var(--spacing-md);
        max-width: 400px;
        transition: background-color var(--transition-fast);
    }

    .search-input-wrapper:focus-within {
        background-color: var(--bg-surface);
    }

    .search-icon {
        color: var(--text-subdued);
        flex-shrink: 0;
    }

    .search-input {
        flex: 1;
        background: none;
        border: none;
        outline: none;
        color: var(--text-primary);
        font-size: 0.875rem;
        min-width: 0;
    }

    .search-input::placeholder {
        color: var(--text-subdued);
    }

    .clear-search {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-subdued);
        transition: color var(--transition-fast);
        flex-shrink: 0;
    }

    .clear-search:hover {
        color: var(--text-primary);
    }
</style>
