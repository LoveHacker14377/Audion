<script lang="ts">
    import { currentView, goToTracks, goToAlbums, goToArtists, goToPlaylists } from "$lib/stores/view";
    import { tracks, albums, artists } from "$lib/stores/library";
    import { isScanning } from "$lib/stores/progressiveScan";  // we Only need isScanning flag
    import { searchQuery, searchResults, clearSearch } from "$lib/stores/search";
    import { isMobile } from "$lib/stores/mobile";
    import MobileHome from "./MobileHome.svelte";

    import TrackList from "./TrackList.svelte";
    import AlbumGrid from "./AlbumGrid.svelte";
    import AlbumDetail from "./AlbumDetail.svelte";
    import ArtistGrid from "./ArtistGrid.svelte";
    import ArtistDetail from "./ArtistDetail.svelte";
    import PlaylistView from "./PlaylistView.svelte";
    import PlaylistDetail from "./PlaylistDetail.svelte";
    import MultiSelectTrackView from "./MultiSelectTrackView.svelte";
    import SearchResults from "./SearchResults.svelte";

    import PluginManager from "./PluginManager.svelte";
    import Settings from "./Settings.svelte";

    $: isSearching = $searchQuery.length > 0;
    $: isLibraryView = ['tracks', 'albums', 'artists', 'playlists'].includes($currentView.type);
    import GlobalShortcuts from "./GlobalShortcuts.svelte";
</script>

<main class="main-view">
    <GlobalShortcuts />

    <!-- Mobile: Horizontal library sub-tabs (Spotify pill style) -->
    {#if $isMobile && isLibraryView && !isSearching}
        <div class="mobile-library-tabs-wrapper">
            <div class="mobile-library-tabs">
                <button class="lib-tab" class:active={$currentView.type === 'tracks'} on:click={goToTracks}>
                    Songs
                </button>
                <button class="lib-tab" class:active={$currentView.type === 'albums'} on:click={goToAlbums}>
                    Albums
                </button>
                <button class="lib-tab" class:active={$currentView.type === 'artists'} on:click={goToArtists}>
                    Artists
                </button>
                <button class="lib-tab" class:active={$currentView.type === 'playlists'} on:click={goToPlaylists}>
                    Playlists
                </button>
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
                {#if $isScanning}
                    <div class="scan-status">
                        Scanning... {$tracks.length} tracks found
                    </div>
                {/if}
            </header>

        <div class="view-content">
            <TrackList tracks={$tracks} showAlbum={true} />
        </div>
    </div>
    {:else if $currentView.type === "tracks-multiselect" && $currentView.id}
        <div class="view-container no-padding">
            <MultiSelectTrackView playlistId={$currentView.id} />
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
    {:else if $currentView.type === "home"}
        <div class="view-container no-padding">
            <MobileHome />
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
        -webkit-overflow-scrolling: touch;
    }

    @media (max-width: 768px) {
        .view-content {
            padding-bottom: calc(var(--mobile-bottom-inset, 130px) + var(--spacing-md));
        }
    }

    .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-subdued);
    }

    .scan-status {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin-top: var(--spacing-xs);
    }

    /* ===== Mobile Library Tabs (Spotify pill style) ===== */
    .mobile-library-tabs-wrapper {
        flex-shrink: 0;
        padding: var(--spacing-md) var(--spacing-md) 0;
        background-color: var(--bg-base);
    }

    .mobile-library-tabs {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
        -webkit-tap-highlight-color: transparent;
        user-select: none;
    }

    .mobile-library-tabs::-webkit-scrollbar {
        display: none;
    }

    .lib-tab {
        flex-shrink: 0;
        padding: 8px 16px;
        border-radius: var(--radius-full);
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-primary);
        background-color: rgba(255, 255, 255, 0.07);
        border: none;
        cursor: pointer;
        transition: all var(--transition-fast);
        -webkit-tap-highlight-color: transparent;
        white-space: nowrap;
    }

    .lib-tab.active {
        background-color: var(--accent-primary);
        color: var(--bg-base);
    }

    .lib-tab:active:not(.active) {
        background-color: rgba(255, 255, 255, 0.12);
    }

    /* Mobile view header adjustments */
    @media (max-width: 768px) {
        .view-header h1 {
            font-size: 1.25rem;
        }

        .view-header {
            padding: var(--spacing-md);
        }
    }
</style>
