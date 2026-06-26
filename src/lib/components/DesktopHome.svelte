<script lang="ts">
    import { onMount } from "svelte";
    import { formatDuration, type Track, type Album, type Playlist, getPlaylistTracks, getTracksByAlbum } from "$lib/api/tauri";
    import {
        playTracks,
        currentAlbumId,
        currentTrackId,
        currentPlaylistId,
        isPlaying,
        togglePlay,
    } from "$lib/stores/player";
    import { contextMenu } from "$lib/stores/ui";
    import {
        albums as libraryAlbums,
        playlists as libraryPlaylists,
        getAlbumCoverFromTracks,
        getTrackAlbumCover,
    } from "$lib/stores/library";
    import {
        topTracks,
        topAlbums,
        recentlyPlayed,
        continueListening,
        recentlyAddedAlbums,
        statsSummary,
        loadActivityData,
    } from "$lib/stores/activity";
    import { goToAlbumDetail, goToArtistDetail, goToPlaylistDetail } from "$lib/stores/view";
    import { isStatsWrappedOpen } from "$lib/stores/ui";
    import MediaCard from "./MediaCard.svelte";
    import { onDestroy } from "svelte";
    import { saveScroll, getScroll } from "$lib/stores/scrollMemory";
    import { fetchAllLatestCharts, type ChartData, type AudionApiTrack } from "$lib/api/audion-api";
    import { _, locale } from "svelte-i18n";
    import { pinnedItems, isPinned } from "$lib/stores/pinned";
    import { playlistCovers } from "$lib/stores/playlistCovers";
    import { homeLayout, toggleSection, reorderSection } from "$lib/stores/homeLayout";
    import { buildAlbumContextMenu, buildTrackContextMenu, isTrackUnavailable } from "$lib/menus/contextMenus";

    let homeEl: HTMLDivElement;
    let scrollRestored = false;
    let currentScrollTop = 0;

    onDestroy(() => {
        saveScroll("home", currentScrollTop);
    });

    $: currentMonthName = new Intl.DateTimeFormat($locale || 'en', { month: 'long' }).format(new Date());

    let greetingKey = "goodEvening";
    const hour = new Date().getHours();
    if (hour < 12) greetingKey = "goodMorning";
    else if (hour < 18) greetingKey = "goodAfternoon";

    let showCustomizeMenu = false;
    let dragItemIndex: number | null = null;
    let dragTargetIndex: number | null = null;
    let dragStartY = 0;
    let itemRects: { top: number; bottom: number }[] = [];
    let sectionsListEl: HTMLElement;

    function startDrag(index: number, e: PointerEvent) {
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        dragItemIndex = index;
        dragTargetIndex = index;
        dragStartY = e.clientY;

        // Capture all item positions
        if (sectionsListEl) {
            const children = sectionsListEl.children;
            itemRects = [];
            for (let i = 0; i < children.length; i++) {
                const r = children[i].getBoundingClientRect();
                itemRects.push({ top: r.top, bottom: r.bottom });
            }
        }

        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragEnd);
    }

    function onDragMove(e: PointerEvent) {
        if (dragItemIndex === null) return;
        e.preventDefault();

        let target = dragItemIndex;
        for (let i = 0; i < itemRects.length; i++) {
            if (e.clientY < (itemRects[i].top + itemRects[i].bottom) / 2) {
                target = i;
                break;
            }
            target = i;
        }

        if (target !== dragTargetIndex) {
            // Shift other items aside in the data model temporarily for visual reflow
            if (dragTargetIndex !== null) {
                const items = [...$homeLayout];
                const [moved] = items.splice(dragItemIndex, 1);
                items.splice(target, 0, moved);
                homeLayout.set(items);
                dragItemIndex = target;
                // Rebuild rects after reflow
                if (sectionsListEl) {
                    const children = sectionsListEl.children;
                    itemRects = [];
                    for (let i = 0; i < children.length; i++) {
                        const r = children[i].getBoundingClientRect();
                        itemRects.push({ top: r.top, bottom: r.bottom });
                    }
                }
            }
            dragTargetIndex = target;
        }
    }

    function onDragEnd() {
        document.removeEventListener('pointermove', onDragMove);
        document.removeEventListener('pointerup', onDragEnd);
        dragItemIndex = null;
        dragTargetIndex = null;
        itemRects = [];
    }

    function getSectionDisplayName(id: string): string {
        switch (id) {
            case 'stats': return 'Listening Stats';
            case 'pinned': return 'Pinned Items';
            case 'quickplay': return 'Quick Play Grid';
            case 'recent': return 'Jump Back In (Recent)';
            case 'continue': return 'Continue Listening';
            case 'added': return 'Recently Added';
            case 'topTracks': return 'Your Top Songs';
            case 'topAlbums': return 'Most Played Albums';
            case 'charts': return 'Charts & Trends';
            default: return id;
        }
    }

    let charts: ChartData[] = [];
    let loadingCharts = true;

    onMount(async () => {
        loadActivityData();
        const saved = getScroll("home");
        if (saved > 0 && homeEl) {
            homeEl.scrollTop = saved;
        }
        scrollRestored = true;

        // Fetch charts
        try {
            charts = await fetchAllLatestCharts();
        } finally {
            loadingCharts = false;
        }
    });

    // Playback state
    $: playingAlbumId = $currentAlbumId;
    $: playingTrackId = $currentTrackId;
    $: playing = $isPlaying;
    $: pausedAlbumId = !playing ? playingAlbumId : null;
    $: pausedTrackId = !playing ? playingTrackId : null;

    // Derived lists
    $: quickPlayAlbums =
        $topAlbums.length > 0
            ? $topAlbums.slice(0, 6).map((ta) => ta.album)
            : $libraryAlbums.slice(0, 6);

    $: topTrackList = $topTracks.map((t) => t.track);

    // Pinned Items
    $: pinnedAlbums = $pinnedItems.albums
        .map(id => $libraryAlbums.find(a => a.id === id))
        .filter((a): a is Album => !!a);

    $: pinnedPlaylists = $pinnedItems.playlists
        .map(id => $libraryPlaylists.find(p => p.id === id))
        .filter((p): p is Playlist => !!p);

    $: pinnedItemsList = [
        ...pinnedAlbums.map(album => ({ type: 'album' as const, id: album.id, data: album })),
        ...pinnedPlaylists.map(playlist => ({ type: 'playlist' as const, id: playlist.id, data: playlist }))
    ];

    async function playPlaylist(playlist: Playlist) {
        if ($currentPlaylistId === playlist.id && $isPlaying) {
            togglePlay();
            return;
        }
        try {
            const tracks = await getPlaylistTracks(playlist.id);
            if (tracks.length > 0) {
                playTracks(tracks, 0, {
                    type: "playlist",
                    playlistId: playlist.id,
                    displayName: playlist.name,
                });
            }
        } catch (err) {
            console.error("Failed to play playlist:", err);
        }
    }

    function initialsFromName(name: string): string {
        if (!name) return "PL";
        const parts = name.trim().split(/\s+/);
        return (
            parts
                .slice(0, 2)
                .map((p) => p[0]?.toUpperCase() ?? "")
                .join("") || name.slice(0, 2).toUpperCase()
        );
    }

    function hashToColor(str: string): string {
        let h = 0;
        for (let i = 0; i < str.length; i++)
            h = (h << 5) - h + str.charCodeAt(i);
        return `hsl(${Math.abs(h) % 360} 30% 30%)`;
    }

    function generateSvgCover(name: string, size = 512): string {
        const initials = initialsFromName(name);
        const bg = hashToColor(name || "playlist");
        const svg =
            `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>` +
            `<rect width='100%' height='100%' fill='${bg}'/>` +
            `<text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='Inter, system-ui, sans-serif' font-size='${Math.floor(size / 3)}' fill='white' font-weight='700'>${initials}</text>` +
            `</svg>`;
        return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    }

    function getPlaylistCover(playlist: Playlist): string {
        return (
            $playlistCovers?.[playlist.id] ??
            playlist.cover_url ??
            generateSvgCover(playlist.name || "Playlist", 512)
        );
    }

    // Quick-play card: play button clicks play the album,
    // clicks anywhere else on the card navigate to album detail.
    async function playAlbum(album: Album) {
        if (playingAlbumId === album.id) {
            togglePlay();
            return;
        }
        try {
            const tracks = await getTracksByAlbum(album.id);
            if (tracks.length > 0) {
                playTracks(tracks, 0, {
                    type: "album",
                    albumId: album.id,
                    displayName: album.name,
                });
            }
        } catch (err) {
            console.error("Failed to play album:", err);
        }
    }

    function handleQuickPlayCardClick(album: Album, e: MouseEvent) {
        // Play button is handled via stopPropagation — anything else navigates
        goToAlbumDetail(album.id);
    }

    function playRecentTrack(track: Track, index: number) {
        playTracks($recentlyPlayed, index);
    }

    function playContinueListeningTrack(track: Track, index: number) {
        playTracks($continueListening, index);
    }

    function playTopTrack(track: Track, index: number) {
        playTracks(topTrackList, index);
    }

    function playApiTrack(apiTrack: AudionApiTrack, chartItems: AudionApiTrack[]) {
        // Convert AudionApiTrack to Track
        const tracks = chartItems.map(t => ({
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album || '',
            album_id: null,
            duration: (t.durationMs || 0) / 1000,
            path: t.tidalId ? `tidal://${t.tidalId}` : '', // Use scheme for stream resolver
            cover_url: t.coverUrl,
            source_type: 'tidal',
            external_id: t.tidalId
        } as unknown as Track));

        const index = chartItems.findIndex(t => t.id === apiTrack.id);
        playTracks(tracks, index);
    }

    // Interaction helpers
    function handleContainerClick(e: MouseEvent, callback: () => void) {
        if (
            (e.target as HTMLElement).closest(".link") ||
            (e.target as HTMLElement).closest("button")
        )
            return;
        callback();
    }

    function handleKeyActivate(e: KeyboardEvent, action: () => void) {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            action();
        }
    }

    // Context menus
    function albumContextMenu(album: Album, e: MouseEvent) {
        e.preventDefault();
        contextMenu.set({
            visible: true,
            x: e.clientX,
            y: e.clientY,
            items: buildAlbumContextMenu({
                album,
                showPlay: true,
                showGoToArtist: true,
                showPin: false,
                onPlay: playAlbum,
                t: $_,
            }),
        });
    }

    // ── Marquee
    const MARQUEE_GAP = 64;

    let marqueeActive: Record<number, boolean> = {};
    let marqueeOverflows: Record<number, { name: boolean; artist: boolean }> =
        {};
    let marqueeDurations: Record<number, { name: string; artist: string }> = {};

    let nameEls = new Map<number, HTMLSpanElement>();
    let artistEls = new Map<number, HTMLButtonElement>();

    function measureQPOverflow(albumId: number) {
        if (marqueeOverflows[albumId]) return; // already measured — use cache
        requestAnimationFrame(() => {
            const nameEl = nameEls.get(albumId);
            const artistEl = artistEls.get(albumId);
            const nameOverflows = nameEl
                ? nameEl.scrollWidth > nameEl.clientWidth
                : false;
            const artistOverflows = artistEl
                ? artistEl.scrollWidth > artistEl.clientWidth
                : false;
            marqueeDurations = {
                ...marqueeDurations,
                [albumId]: {
                    name:
                        nameEl && nameOverflows
                            ? `${Math.max(4, (nameEl.scrollWidth + MARQUEE_GAP) / 60).toFixed(1)}s`
                            : "0s",
                    artist:
                        artistEl && artistOverflows
                            ? `${Math.max(4, (artistEl.scrollWidth + MARQUEE_GAP) / 60).toFixed(1)}s`
                            : "0s",
                },
            };
            marqueeOverflows = {
                ...marqueeOverflows,
                [albumId]: { name: nameOverflows, artist: artistOverflows },
            };
        });
    }

    function handleQPMouseEnter(albumId: number) {
        marqueeActive = { ...marqueeActive, [albumId]: true };
        measureQPOverflow(albumId);
    }

    function handleQPMouseLeave(albumId: number) {
        marqueeActive = { ...marqueeActive, [albumId]: false };
        // Clear cached overflow on leave so layout changes
        const { [albumId]: _o, ...restO } = marqueeOverflows;
        marqueeOverflows = restO;
        const { [albumId]: _d, ...restD } = marqueeDurations;
        marqueeDurations = restD;
    }

    function registerNameEl(node: HTMLSpanElement, albumId: number) {
        nameEls.set(albumId, node);
        return {
            destroy() {
                nameEls.delete(albumId);
            },
        };
    }

    function registerArtistEl(node: HTMLButtonElement, albumId: number) {
        artistEls.set(albumId, node);
        return {
            destroy() {
                artistEls.delete(albumId);
            },
        };
    }

    function trackContextMenu(
        track: Track,
        index: number,
        trackList: Track[],
        e: MouseEvent,
    ) {
        e.preventDefault();
        contextMenu.set({
            visible: true,
            x: e.clientX,
            y: e.clientY,
            items: buildTrackContextMenu({
                track,
                trackIndex: index,
                sortedTracks: trackList,
                isUnavailable: isTrackUnavailable(track),
                variant: "home",
                t: $_,
            }),
        });
    }
</script>

<div
    class="desktop-home"
    bind:this={homeEl}
    style="visibility: {scrollRestored || getScroll('home') === 0
        ? 'visible'
        : 'hidden'};"
    on:scroll={(e) => {
        currentScrollTop = (e.target as HTMLElement).scrollTop;
    }}
>
    <!-- Greeting -->
    <header class="home-header">
        <h1 class="greeting">{$_(`home.${greetingKey}`)}</h1>
        <div class="home-header-actions">
            <button
                class="recap-launch-btn"
                on:click={() => isStatsWrappedOpen.set(true)}
                aria-label="{currentMonthName} Recap"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="18"
                    height="18"
                    aria-hidden="true"
                >
                    <path
                        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                    ></path>
                </svg>
                <span>{currentMonthName} {$_('home.recap')}</span>
            </button>
            <button
                class="customize-home-btn"
                on:click={() => showCustomizeMenu = !showCustomizeMenu}
                aria-label="Customize Home Layout"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="18"
                    height="18"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
                <span>Customize</span>
            </button>
        </div>
    </header>

    {#if showCustomizeMenu}
        <div class="customize-overlay" on:click={() => showCustomizeMenu = false}></div>
        <div class="customize-menu" role="dialog" aria-modal="true" aria-label="Customize Home Layout">
            <div class="customize-header">
                <h3>Customize Layout</h3>
                <button class="close-btn" on:click={() => showCustomizeMenu = false}>&times;</button>
            </div>
            <div class="customize-body">
                <p class="customize-instructions">Drag handles to reorder sections, or toggle switches to show/hide them.</p>
                <div class="sections-list" bind:this={sectionsListEl}>
                    {#each $homeLayout as section, i (section.id)}
                        <div 
                            class="section-item"
                            class:dragging={dragItemIndex === i}
                        >
                            <span
                                class="drag-handle"
                                role="button"
                                tabindex="0"
                                on:pointerdown={(e) => startDrag(i, e)}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
                                    <circle cx="9" cy="5" r="1" fill="currentColor"></circle>
                                    <circle cx="9" cy="12" r="1" fill="currentColor"></circle>
                                    <circle cx="9" cy="19" r="1" fill="currentColor"></circle>
                                    <circle cx="15" cy="5" r="1" fill="currentColor"></circle>
                                    <circle cx="15" cy="12" r="1" fill="currentColor"></circle>
                                    <circle cx="15" cy="19" r="1" fill="currentColor"></circle>
                                </svg>
                            </span>
                            <span class="section-name">{getSectionDisplayName(section.id)}</span>
                            <label class="switch-container">
                                <input 
                                    type="checkbox" 
                                    checked={section.visible}
                                    on:change={() => toggleSection(section.id)}
                                />
                                <span class="slider"></span>
                            </label>
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    {/if}

    {#each $homeLayout as section (section.id)}
        {#if section.visible}
            {#if section.id === 'stats'}
                <!-- Stats Widget -->
                {#if $statsSummary && $statsSummary.total_plays > 0}
                    <section class="stats-widget-section">
                        <div class="stats-grid">
                            <div class="stat-card">
                                <div class="stat-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true">
                                        <line x1="18" y1="20" x2="18" y2="10"></line>
                                        <line x1="12" y1="20" x2="12" y2="4"></line>
                                        <line x1="6" y1="20" x2="6" y2="14"></line>
                                    </svg>
                                </div>
                                <div class="stat-info">
                                    <span class="stat-value">{$statsSummary.total_plays}</span>
                                    <span class="stat-label">{$_('home.stats.plays', { default: 'Plays' })}</span>
                                </div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true">
                                        <circle cx="12" cy="12" r="10"></circle>
                                        <polyline points="12 6 12 12 16 14"></polyline>
                                    </svg>
                                </div>
                                <div class="stat-info">
                                    <span class="stat-value">{Math.round($statsSummary.total_duration_seconds / 60)} min</span>
                                    <span class="stat-label">{$_('home.stats.timePlayed', { default: 'Time Played' })}</span>
                                </div>
                            </div>
                            {#if $statsSummary.top_artist}
                                <div class="stat-card link-card" on:click={() => $statsSummary.top_artist && goToArtistDetail($statsSummary.top_artist)} role="button" tabindex="0" on:keydown={(e) => e.key === 'Enter' && $statsSummary.top_artist && goToArtistDetail($statsSummary.top_artist)}>
                                    <div class="stat-icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true">
                                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                                        </svg>
                                    </div>
                                    <div class="stat-info">
                                        <span class="stat-value">{$statsSummary.top_artist}</span>
                                        <span class="stat-label">{$_('home.stats.topArtist', { default: 'Top Artist' })}</span>
                                    </div>
                                </div>
                            {/if}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'pinned'}
                <!-- Pinned Items -->
                {#if pinnedItemsList.length > 0}
                    <section class="home-section">
                        <h2 class="section-title">{$_('home.pinned')}</h2>
                        <div class="carousel-row">
                            {#each pinnedItemsList as item}
                                {@const isAlbum = item.type === 'album'}
                                {@const isNowPlaying = isAlbum
                                    ? playingAlbumId === item.id && playing
                                    : $currentPlaylistId === item.id && playing}
                                {@const isPaused = isAlbum
                                    ? pausedAlbumId === item.id
                                    : $currentPlaylistId === item.id && !playing}
                                <div class="carousel-card-wrapper" role="listitem">
                                    <MediaCard
                                        {isNowPlaying}
                                        {isPaused}
                                        isPinned={true}
                                        playTooltip={isAlbum ? "Play album" : "Play playlist"}
                                        resumeTooltip={isAlbum ? "Resume album" : "Resume playlist"}
                                        pauseTooltip="Pause"
                                        primaryText={item.data.name}
                                        secondaryText={isAlbum ? (item.data.artist || "Unknown Artist") : "Playlist"}
                                        secondaryAction={isAlbum && item.data.artist
                                            ? () => goToArtistDetail(item.data.artist!)
                                            : null}
                                        ariaLabel={item.data.name}
                                        on:play={() => isAlbum ? playAlbum(item.data) : playPlaylist(item.data)}
                                        on:pause={togglePlay}
                                        on:click={() => isAlbum ? goToAlbumDetail(item.id) : goToPlaylistDetail(item.id, item.data.name)}
                                    >
                                        <svelte:fragment slot="cover">
                                            {#if isAlbum}
                                                {#if getAlbumCoverFromTracks(item.id)}
                                                    <img
                                                        src={getAlbumCoverFromTracks(item.id)}
                                                        alt={item.data.name}
                                                        loading="lazy"
                                                        decoding="async"
                                                    />
                                                {:else}
                                                    <div class="cover-placeholder">
                                                        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                                                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
                                                        </svg>
                                                    </div>
                                                {/if}
                                            {:else}
                                                <img
                                                    src={getPlaylistCover(item.data)}
                                                    alt={item.data.name}
                                                    loading="lazy"
                                                    decoding="async"
                                                />
                                            {/if}
                                        </svelte:fragment>
                                    </MediaCard>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'quickplay'}
                <!-- Quick Play Grid -->
                {#if quickPlayAlbums.length > 0}
                    <section class="quick-play-section">
                        <div class="quick-play-grid">
                            {#each quickPlayAlbums as album}
                                {@const isNowPlaying =
                                    playingAlbumId === album.id && playing}
                                {@const isPaused = pausedAlbumId === album.id}
                                {@const active = marqueeActive[album.id]}
                                {@const overflows = marqueeOverflows[album.id] ?? {
                                    name: false,
                                    artist: false,
                                }}
                                {@const durations = marqueeDurations[album.id] ?? {
                                    name: "0s",
                                    artist: "0s",
                                }}
                                <div
                                    class="quick-play-card"
                                    class:now-playing={isNowPlaying}
                                    class:paused={isPaused}
                                    role="button"
                                    tabindex="0"
                                    on:click={(e) => handleQuickPlayCardClick(album, e)}
                                    on:keydown={(e) =>
                                        handleKeyActivate(e, () =>
                                            goToAlbumDetail(album.id),
                                        )}
                                    on:contextmenu={(e) => albumContextMenu(album, e)}
                                >
                                    <div
                                        class="quick-play-art"
                                        role="button"
                                        tabindex="-1"
                                        aria-label={isNowPlaying
                                            ? "Pause"
                                            : isPaused
                                              ? "Resume"
                                              : "Play"}
                                        on:click|stopPropagation={() => playAlbum(album)}
                                        on:keydown|stopPropagation={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                playAlbum(album);
                                            }
                                        }}
                                    >
                                        {#if getAlbumCoverFromTracks(album.id)}
                                            <img
                                                src={getAlbumCoverFromTracks(album.id)}
                                                alt={album.name}
                                                loading="lazy"
                                                decoding="async"
                                            />
                                        {:else}
                                            <div class="quick-play-placeholder">
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="currentColor"
                                                    width="20"
                                                    height="20"
                                                    aria-hidden="true"
                                                >
                                                    <path
                                                        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"
                                                    />
                                                </svg>
                                            </div>
                                        {/if}
                                        <div
                                            class="quick-play-hover-overlay"
                                            aria-hidden="true"
                                        >
                                            {#if isNowPlaying}
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="currentColor"
                                                    width="18"
                                                    height="18"
                                                >
                                                    <path
                                                        d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"
                                                    />
                                                </svg>
                                            {:else}
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="currentColor"
                                                    width="18"
                                                    height="18"
                                                >
                                                    <path d="M8 5v14l11-7z" />
                                                </svg>
                                            {/if}
                                        </div>
                                    </div>
                                    <div
                                        class="quick-play-text"
                                        role="presentation"
                                        on:mouseenter={() => handleQPMouseEnter(album.id)}
                                        on:mouseleave={() => handleQPMouseLeave(album.id)}
                                    >
                                        <div
                                            class="qp-text-track"
                                            class:animate={active && overflows.name}
                                        >
                                            <span
                                                class="quick-play-name"
                                                class:accent={isNowPlaying || isPaused}
                                                class:qp-marquee={active && overflows.name}
                                                style="--marquee-duration: {durations.name};"
                                                use:registerNameEl={album.id}
                                                >{album.name}</span
                                            >
                                            {#if active && overflows.name}
                                                <span
                                                    class="quick-play-name qp-marquee"
                                                    class:accent={isNowPlaying || isPaused}
                                                    aria-hidden="true"
                                                    style="--marquee-duration: {durations.name};"
                                                    >{album.name}</span
                                                >
                                            {/if}
                                        </div>
                                        {#if album.artist}
                                            <div
                                                class="qp-text-track"
                                                class:animate={active && overflows.artist}
                                            >
                                                <button
                                                    class="quick-play-artist"
                                                    class:qp-marquee={active &&
                                                        overflows.artist}
                                                    style="--marquee-duration: {durations.artist};"
                                                    on:click|stopPropagation={() =>
                                                        goToArtistDetail(album.artist!)}
                                                    title="Go to artist"
                                                    use:registerArtistEl={album.id}
                                                    >{album.artist}</button
                                                >
                                                {#if active && overflows.artist}
                                                    <button
                                                        class="quick-play-artist qp-marquee"
                                                        aria-hidden="true"
                                                        style="--marquee-duration: {durations.artist};"
                                                        on:click|stopPropagation={() =>
                                                            goToArtistDetail(album.artist!)}
                                                        >{album.artist}</button
                                                    >
                                                {/if}
                                            </div>
                                        {/if}
                                    </div>
                                    {#if isNowPlaying || isPaused}
                                        <div class="quick-play-eq" aria-hidden="true">
                                            <span class="eq-bar" class:paused={isPaused}
                                            ></span>
                                            <span class="eq-bar" class:paused={isPaused}
                                            ></span>
                                            <span class="eq-bar" class:paused={isPaused}
                                            ></span>
                                        </div>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'recent'}
                <!-- Recently Played -->
                {#if $recentlyPlayed.length > 0}
                    <section class="home-section">
                        <h2 class="section-title">{$_('home.jumpBackIn')}</h2>
                        <div class="carousel-row">
                            {#each $recentlyPlayed.slice(0, 10) as track, i}
                                {@const isNowPlaying =
                                    playingTrackId === track.id && playing}
                                {@const isPaused = pausedTrackId === track.id}
                                <div
                                    class="carousel-card-wrapper"
                                    role="listitem"
                                    on:contextmenu={(e) =>
                                        trackContextMenu(
                                            track,
                                            i,
                                            $recentlyPlayed.slice(0, 10),
                                            e,
                                        )}
                                >
                                    <MediaCard
                                        {isNowPlaying}
                                        {isPaused}
                                        playTooltip="Play"
                                        resumeTooltip="Resume"
                                        pauseTooltip="Pause"
                                        primaryText={track.title || "Unknown"}
                                        secondaryText={track.artist || "Unknown"}
                                        secondaryAction={track.artist
                                            ? () => goToArtistDetail(track.artist!)
                                            : null}
                                        ariaLabel={track.title || "Unknown"}
                                        on:play={() => playRecentTrack(track, i)}
                                        on:pause={togglePlay}
                                    >
                                        <svelte:fragment slot="cover">
                                            {#if getTrackAlbumCover(track.id)}
                                                <img
                                                    src={getTrackAlbumCover(track.id)}
                                                    alt={track.title}
                                                    loading="lazy"
                                                    decoding="async"
                                                />
                                            {:else}
                                                <div class="cover-placeholder">
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="currentColor"
                                                        width="24"
                                                        height="24"
                                                        aria-hidden="true"
                                                    >
                                                        <path
                                                            d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"
                                                        />
                                                    </svg>
                                                </div>
                                            {/if}
                                        </svelte:fragment>
                                    </MediaCard>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'continue'}
                <!-- Continue Listening -->
                {#if $continueListening.length > 0}
                    <section class="home-section">
                        <h2 class="section-title">{$_('home.continueListening')}</h2>
                        <div class="carousel-row">
                            {#each $continueListening.slice(0, 10) as track, i}
                                {@const isNowPlaying = playingTrackId === track.id && playing}
                                {@const isPaused = pausedTrackId === track.id}
                                <div
                                    class="carousel-card-wrapper"
                                    role="listitem"
                                    on:contextmenu={(e) =>
                                        trackContextMenu(
                                            track,
                                            i,
                                            $continueListening.slice(0, 10),
                                            e,
                                        )}
                                >
                                    <MediaCard
                                        {isNowPlaying}
                                        {isPaused}
                                        playTooltip="Play"
                                        resumeTooltip="Resume"
                                        pauseTooltip="Pause"
                                        primaryText={track.album || "Unknown Album"}
                                        secondaryText={track.title || "Unknown Track"}
                                        ariaLabel={track.album || "Unknown Album"}
                                        on:play={() => playContinueListeningTrack(track, i)}
                                        on:pause={togglePlay}
                                        on:click={() => track.album_id && goToAlbumDetail(track.album_id)}
                                    >
                                        <svelte:fragment slot="cover">
                                            {#if getTrackAlbumCover(track.id)}
                                                <img
                                                    src={getTrackAlbumCover(track.id)}
                                                    alt={track.album}
                                                    loading="lazy"
                                                    decoding="async"
                                                />
                                            {:else}
                                                <div class="cover-placeholder">
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="currentColor"
                                                        width="24"
                                                        height="24"
                                                        aria-hidden="true"
                                                    >
                                                        <path
                                                            d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"
                                                        />
                                                    </svg>
                                                </div>
                                            {/if}
                                        </svelte:fragment>
                                    </MediaCard>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'added'}
                <!-- Recently Added Albums -->
                {#if $recentlyAddedAlbums.length > 0}
                    <section class="home-section">
                        <h2 class="section-title">{$_('home.recentlyAdded')}</h2>
                        <div class="carousel-row">
                            {#each $recentlyAddedAlbums.slice(0, 10) as album}
                                {@const isNowPlaying = playingAlbumId === album.id && playing}
                                {@const isPaused = pausedAlbumId === album.id}
                                <div class="carousel-card-wrapper" role="listitem">
                                    <MediaCard
                                        {isNowPlaying}
                                        {isPaused}
                                        playTooltip="Play"
                                        resumeTooltip="Resume"
                                        pauseTooltip="Pause"
                                        primaryText={album.name}
                                        secondaryText={album.artist || "Unknown Artist"}
                                        secondaryAction={album.artist
                                            ? () => goToArtistDetail(album.artist!)
                                            : null}
                                        ariaLabel={album.name}
                                        on:play={() => playAlbum(album)}
                                        on:pause={togglePlay}
                                        on:click={() => goToAlbumDetail(album.id)}
                                    >
                                        <svelte:fragment slot="cover">
                                            {#if getAlbumCoverFromTracks(album.id)}
                                                <img
                                                    src={getAlbumCoverFromTracks(album.id)}
                                                    alt={album.name}
                                                    loading="lazy"
                                                    decoding="async"
                                                />
                                            {:else}
                                                <div class="cover-placeholder">
                                                    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                                                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
                                                    </svg>
                                                </div>
                                            {/if}
                                        </svelte:fragment>
                                    </MediaCard>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'topTracks'}
                <!-- Top Tracks -->
                {#if $topTracks.length > 0}
                    <section class="home-section">
                        <h2 class="section-title">{$_('home.yourTopSongs')}</h2>
                        <div class="top-tracks-list">
                            {#each $topTracks.slice(0, 10) as { track, play_count }, i}
                                {@const isNowPlaying =
                                    playingTrackId === track.id && playing}
                                {@const isPaused = pausedTrackId === track.id}
                                <div
                                    class="top-track-row"
                                    class:now-playing={isNowPlaying}
                                    class:paused={isPaused}
                                    role="button"
                                    tabindex="0"
                                    on:click={(e) =>
                                        handleContainerClick(e, () =>
                                            playTopTrack(track, i),
                                        )}
                                    on:keydown={(e) =>
                                        handleKeyActivate(e, () => playTopTrack(track, i))}
                                    on:contextmenu={(e) =>
                                        trackContextMenu(track, i, topTrackList, e)}
                                >
                                    <span class="top-track-rank">
                                        {#if isNowPlaying}
                                            <span
                                                class="equalizer"
                                                aria-label="Now playing"
                                            >
                                                <span class="bar"></span>
                                                <span class="bar"></span>
                                                <span class="bar"></span>
                                            </span>
                                        {:else}
                                            {i + 1}
                                        {/if}
                                    </span>
                                    <div class="top-track-art">
                                        {#if getTrackAlbumCover(track.id)}
                                            <img
                                                src={getTrackAlbumCover(track.id)}
                                                alt={track.title}
                                                loading="lazy"
                                                decoding="async"
                                            />
                                        {:else}
                                            <div class="top-track-art-placeholder">
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="currentColor"
                                                    width="16"
                                                    height="16"
                                                    aria-hidden="true"
                                                >
                                                    <path
                                                        d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"
                                                    />
                                                </svg>
                                            </div>
                                        {/if}
                                    </div>
                                    <div class="top-track-info">
                                        <span
                                            class="top-track-title"
                                            class:accent={isNowPlaying || isPaused}
                                            >{track.title || "Unknown"}</span
                                        >
                                        <button
                                            class="top-track-artist link"
                                            on:click|stopPropagation={() =>
                                                goToArtistDetail(track.artist || "")}
                                            title="Go to artist"
                                        >
                                            {track.artist || "Unknown"}
                                        </button>
                                    </div>
                                    <span class="top-track-plays">{play_count} plays</span>
                                    <span class="top-track-duration"
                                        >{formatDuration(track.duration)}</span
                                    >
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'topAlbums'}
                <!-- Top Albums (List View) -->
                {#if $topAlbums.length > 0}
                    <section class="home-section">
                        <h2 class="section-title">{$_('home.mostPlayedAlbums')}</h2>
                        <div class="top-tracks-list">
                            {#each $topAlbums.slice(0, 10) as { album, play_count }, i}
                                {@const isNowPlaying =
                                    playingAlbumId === album.id && playing}
                                {@const isPaused = pausedAlbumId === album.id}
                                <div
                                    class="top-track-row"
                                    class:now-playing={isNowPlaying}
                                    class:paused={isPaused}
                                    role="button"
                                    tabindex="0"
                                    on:click={(e) =>
                                        handleContainerClick(e, () =>
                                            goToAlbumDetail(album.id),
                                        )}
                                    on:keydown={(e) =>
                                        handleKeyActivate(e, () =>
                                            goToAlbumDetail(album.id),
                                        )}
                                    on:contextmenu={(e) => albumContextMenu(album, e)}
                                >
                                    <span class="top-track-rank">
                                        {#if isNowPlaying}
                                            <span
                                                class="equalizer"
                                                aria-label="Now playing"
                                            >
                                                <span class="bar"></span>
                                                <span class="bar"></span>
                                                <span class="bar"></span>
                                            </span>
                                        {:else}
                                            {i + 1}
                                        {/if}
                                    </span>
                                    <div class="top-track-art">
                                        {#if getAlbumCoverFromTracks(album.id)}
                                            <img
                                                src={getAlbumCoverFromTracks(album.id)}
                                                alt={album.name}
                                                loading="lazy"
                                                decoding="async"
                                            />
                                        {:else}
                                            <div class="top-track-art-placeholder">
                                                <svg
                                                    viewBox="0 0 24 24"
                                                    fill="currentColor"
                                                    width="16"
                                                    height="16"
                                                    aria-hidden="true"
                                                >
                                                    <path
                                                        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"
                                                    />
                                                </svg>
                                            </div>
                                        {/if}
                                    </div>
                                    <div class="top-track-info">
                                        <span
                                            class="top-track-title"
                                            class:accent={isNowPlaying || isPaused}
                                            >{album.name}</span
                                        >
                                        <button
                                            class="top-track-artist link"
                                            on:click|stopPropagation={() =>
                                                goToArtistDetail(album.artist || "")}
                                            title="Go to artist"
                                        >
                                            {album.artist || "Unknown Artist"}
                                        </button>
                                    </div>
                                    <span class="top-track-plays">{play_count} plays</span>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {:else if section.id === 'charts'}
                <!-- Charts Section -->
                {#if !loadingCharts && charts.length > 0}
                    <div class="charts-container">
                        {#each charts as chart}
                            <section class="home-section chart-section">
                                <div class="section-header">
                                    <h2 class="section-title">{chart.displayName}</h2>
                                    <button class="view-all-link">{$_('home.viewAll')}</button>
                                </div>
                                <div class="chart-list">
                                    {#if chart.items}
                                        {#each chart.items.slice(0, 5) as item, i}
                                            {@const isNowPlaying = String(playingTrackId) === String(item.id) && playing}
                                            <div 
                                                class="chart-row"
                                                class:active={isNowPlaying}
                                                role="button"
                                                tabindex="0"
                                                on:click={(e) => handleContainerClick(e, () => playApiTrack(item, chart.items))}
                                                on:keydown={(e) => handleKeyActivate(e, () => playApiTrack(item, chart.items))}
                                            >
                                                <span class="chart-rank">{i + 1}</span>
                                                <div class="chart-art">
                                                    {#if item.coverUrl}
                                                        <img src={item.coverUrl} alt={item.title} loading="lazy" />
                                                    {:else}
                                                        <div class="art-placeholder">🎵</div>
                                                    {/if}
                                                </div>
                                                <div class="chart-info">
                                                    <span class="chart-title">{item.title}</span>
                                                    <span class="chart-artist">{item.artist}</span>
                                                </div>
                                                {#if isNowPlaying}
                                                    <div class="playing-indicator">
                                                        <div class="bar"></div>
                                                        <div class="bar"></div>
                                                        <div class="bar"></div>
                                                    </div>
                                                {/if}
                                            </div>
                                        {/each}
                                    {/if}
                                </div>
                            </section>
                        {/each}
                    </div>
                {/if}
            {/if}
        {/if}
    {/each}
</div>

<style>
    .desktop-home {
        padding: 24px 32px;
        overflow-y: auto;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: 24px;
    }

    /* Stats Widget */
    .stats-widget-section {
        margin-bottom: 8px;
    }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 16px;
    }

    .stat-card {
        display: flex;
        align-items: center;
        gap: 16px;
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 100%);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        padding: 16px 20px;
        transition: all 0.2s ease;
    }

    .stat-card:hover {
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.02) 100%);
        border-color: rgba(255, 255, 255, 0.1);
        transform: translateY(-2px);
    }

    .stat-card.link-card {
        cursor: pointer;
    }

    .stat-card.link-card:hover {
        border-color: var(--accent-primary, #1db954);
    }

    .stat-icon {
        font-size: 2rem;
        opacity: 0.8;
    }

    .stat-info {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }

    .stat-value {
        font-size: 1.25rem;
        font-weight: 800;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .stat-label {
        font-size: var(--font-size-xs);
        color: var(--text-secondary);
        font-weight: 500;
    }

    .home-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
    }

    .home-header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .greeting {
        font-size: 2rem;
        font-weight: 800;
        color: var(--text-primary);
        letter-spacing: -0.02em;
    }

    .recap-launch-btn, .customize-home-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 8px 16px;
        border-radius: 20px;
        color: var(--text-primary);
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-semibold);
        cursor: pointer;
        transition: all 0.2s ease;
    }

    .recap-launch-btn:hover, .customize-home-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        transform: translateY(-1px);
        border-color: var(--accent-primary);
    }

    .recap-launch-btn svg, .customize-home-btn svg {
        color: var(--accent-primary);
    }

    /* Customize Popup */
    .customize-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
        z-index: 999;
    }

    .customize-menu {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 420px;
        max-width: 90vw;
        background: #181818;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.5);
        z-index: 1000;
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    .customize-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 12px;
    }

    .customize-header h3 {
        font-size: 1.2rem;
        font-weight: 700;
        color: var(--text-primary);
        margin: 0;
    }

    .customize-header .close-btn {
        background: none;
        border: none;
        font-size: 1.5rem;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 0;
        line-height: 1;
    }

    .customize-header .close-btn:hover {
        color: var(--text-primary);
    }

    .customize-instructions {
        font-size: var(--font-size-sm);
        color: var(--text-secondary);
        margin: 0 0 8px 0;
        line-height: 1.4;
    }

    .sections-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 360px;
        overflow-y: auto;
        padding-right: 4px;
    }

    .section-item {
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 12px 16px;
        cursor: grab;
        transition: all 0.2s ease;
    }

    .section-item:active {
        cursor: grabbing;
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.1);
    }

    .section-item.dragging {
        opacity: 0.4;
        background: rgba(255, 255, 255, 0.1);
        border-color: var(--accent-primary, #1db954);
        transform: scale(0.97);
    }

    .drag-handle {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        user-select: none;
        touch-action: none;
        cursor: grab;
    }

    .drag-handle:active {
        cursor: grabbing;
    }

    .section-name {
        flex-grow: 1;
        font-weight: 500;
        color: var(--text-primary);
        font-size: var(--font-size-base);
        user-select: none;
    }

    /* Switch Container */
    .switch-container {
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
        flex-shrink: 0;
    }

    .switch-container input {
        opacity: 0;
        width: 0;
        height: 0;
    }

    .slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(255, 255, 255, 0.1);
        transition: .3s;
        border-radius: 24px;
        border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .slider:before {
        position: absolute;
        content: "";
        height: 18px;
        width: 18px;
        left: 2px;
        bottom: 2px;
        background-color: white;
        transition: .3s;
        border-radius: 50%;
    }

    input:checked + .slider {
        background-color: var(--accent-primary, #1db954);
    }

    input:checked + .slider:before {
        transform: translateX(20px);
    }

    .recap-launch-btn svg {
        color: var(--accent-primary);
    }

    /* ── Charts Section ── */
    .charts-container {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 24px;
        margin-top: 32px;
    }

    .chart-section {
        background: rgba(255, 255, 255, 0.03);
        padding: 20px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
    }

    .view-all-link {
        background: none;
        border: none;
        color: var(--text-subdued);
        font-size: 0.8rem;
        font-weight: var(--font-weight-semibold);
        cursor: pointer;
    }

    .view-all-link:hover {
        color: var(--text-primary);
        text-decoration: underline;
    }

    .chart-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .chart-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.2s;
    }

    .chart-row:hover {
        background: rgba(255, 255, 255, 0.07);
    }

    .chart-row.active {
        background: rgba(30, 215, 96, 0.1);
    }

    .chart-rank {
        width: 20px;
        font-size: 0.9rem;
        font-weight: var(--font-weight-bold);
        color: var(--text-subdued);
        text-align: center;
    }

    .chart-art {
        width: 40px;
        height: 40px;
        border-radius: 4px;
        overflow: hidden;
        background: #282828;
    }

    .chart-art img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .art-placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.2rem;
    }

    .chart-info {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
    }

    .chart-title {
        font-size: 0.9rem;
        font-weight: var(--font-weight-semibold);
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .chart-artist {
        font-size: var(--font-size-xs);
        color: var(--text-subdued);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .playing-indicator {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 12px;
    }

    .playing-indicator .bar {
        width: 2px;
        height: 100%;
        background: var(--accent-primary);
        animation: eq 0.8s infinite ease-in-out;
    }

    @keyframes eq {
        0%, 100% { height: 30%; }
        50% { height: 100%; }
    }

    /* ── Quick Play Grid ── */
    .quick-play-section {
        margin-bottom: 32px;
    }

    .quick-play-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
    }

    .quick-play-card {
        display: flex;
        align-items: center;
        gap: 12px;
        background: var(--surface-hover, rgba(255, 255, 255, 0.07));
        border: none;
        border-radius: 6px;
        padding: 0;
        cursor: pointer;
        overflow: hidden;
        transition: background 0.2s ease;
        text-align: left;
    }

    .quick-play-card:hover {
        background: var(--surface-active, rgba(255, 255, 255, 0.12));
    }

    .quick-play-card.now-playing,
    .quick-play-card.paused {
        background: var(--accent-subtle);
    }

    .quick-play-card.now-playing:hover,
    .quick-play-card.paused:hover {
        background: var(--accent-subtle);
        opacity: 0.95;
    }

    .quick-play-art {
        width: 56px;
        height: 56px;
        flex-shrink: 0;
        position: relative;
        cursor: pointer;
        border-radius: var(--radius-sm);
        overflow: hidden;
    }

    .quick-play-art img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }

    .quick-play-placeholder {
        width: 100%;
        height: 100%;
        background: var(--surface-elevated, rgba(255, 255, 255, 0.05));
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-subdued);
    }

    .quick-play-hover-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity var(--transition-fast);
        background: rgba(0, 0, 0, 0.35);
        color: white;
        pointer-events: none;
        filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
    }

    .quick-play-art:hover .quick-play-hover-overlay {
        opacity: 1;
    }

    .quick-play-text {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        gap: 2px;
        overflow: hidden;
    }

    .qp-text-track {
        display: flex;
        flex-direction: row;
        overflow: hidden;
        position: relative;
    }

    .qp-text-track.animate {
        -webkit-mask-image: linear-gradient(
            to right,
            transparent 0%,
            black 4%,
            black 92%,
            transparent 100%
        );
        mask-image: linear-gradient(
            to right,
            transparent 0%,
            black 4%,
            black 92%,
            transparent 100%
        );
    }

    .quick-play-name {
        font-size: 0.85rem;
        font-weight: var(--font-weight-semibold);
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 0;
        max-width: 100%;
    }

    .quick-play-name.accent {
        color: var(--accent-primary);
    }

    .quick-play-artist {
        font-size: var(--font-size-xs);
        color: var(--text-secondary);
        background: none;
        border: none;
        padding: 0;
        text-align: left;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 0;
        max-width: 100%;
        font-family: inherit;
    }

    .quick-play-artist:hover {
        text-decoration: underline;
        color: var(--text-primary);
    }

    .qp-marquee {
        overflow: visible;
        text-overflow: clip;
        max-width: none;
        padding-right: 64px;
        animation: qp-marquee-scroll var(--marquee-duration) linear infinite;
    }

    @keyframes qp-marquee-scroll {
        from {
            transform: translateX(0);
        }
        to {
            transform: translateX(-100%);
        }
    }

    .quick-play-eq {
        display: flex;
        align-items: flex-end;
        gap: 3px;
        flex-shrink: 0;
        height: 20px;
        padding-right: 12px;
    }

    .eq-bar {
        width: 4px;
        background-color: var(--accent-primary);
        border-radius: 2px;
        animation: qp-equalizer 0.8s ease-in-out infinite;
    }

    .eq-bar.paused {
        animation-play-state: paused;
        height: 8px;
        background-color: var(--text-secondary);
    }

    .eq-bar:nth-child(2) {
        animation-delay: 0.2s;
    }
    .eq-bar:nth-child(3) {
        animation-delay: 0.4s;
    }

    @keyframes qp-equalizer {
        0%,
        100% {
            height: 4px;
        }
        50% {
            height: 18px;
        }
    }

    /* Section */
    .home-section {
        margin-bottom: 32px;
    }

    .section-title {
        font-size: 1.4rem;
        font-weight: var(--font-weight-bold);
        color: var(--text-primary);
        margin: 0 0 16px 0;
    }

    /* Carousel Row */
    .carousel-row {
        display: flex;
        gap: 16px;
        overflow-x: auto;
        padding-bottom: 8px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }

    .carousel-row::-webkit-scrollbar {
        height: 6px;
    }
    .carousel-row::-webkit-scrollbar-track {
        background: transparent;
        border-radius: 3px;
    }
    .carousel-row::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
    }
    .carousel-row::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.35);
    }

    .carousel-card-wrapper {
        width: 160px;
        flex-shrink: 0;
    }

    .cover-placeholder {
        width: 100%;
        height: 100%;
        background: var(--surface-elevated, rgba(255, 255, 255, 0.06));
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-subdued);
    }

    /* Top Tracks List */
    .top-track-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        text-align: left;
        width: 100%;
    }

    .top-track-row:hover {
        background: var(--surface-hover, rgba(255, 255, 255, 0.1));
        transform: translateX(4px);
    }

    .top-track-row.now-playing,
    .top-track-row.paused {
        background: var(--accent-subtle);
    }

    .top-track-row.now-playing:hover,
    .top-track-row.paused:hover {
        background: var(--accent-subtle);
        opacity: 0.95;
        transform: translateX(4px);
    }

    .top-track-rank {
        width: 32px;
        font-size: var(--font-size-md);
        font-weight: var(--font-weight-bold);
        color: var(--text-subdued);
        text-align: center;
        flex-shrink: 0;
        font-family: "JetBrains Mono", monospace;
        opacity: 0.5;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .top-track-row:hover .top-track-rank {
        color: var(--accent-primary);
        opacity: 1;
    }

    .top-track-row.now-playing .top-track-rank,
    .top-track-row.paused .top-track-rank {
        opacity: 1;
    }

    .equalizer {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 16px;
    }

    .equalizer .bar {
        width: 3px;
        background-color: var(--accent-primary);
        border-radius: 2px;
        animation: equalizer 0.8s ease-in-out infinite;
    }

    .equalizer .bar:nth-child(2) {
        animation-delay: 0.2s;
    }
    .equalizer .bar:nth-child(3) {
        animation-delay: 0.4s;
    }

    .equalizer.paused .bar {
        animation-play-state: paused;
        height: 8px;
        background-color: var(--text-secondary);
    }

    @keyframes equalizer {
        0%,
        100% {
            height: 4px;
        }
        50% {
            height: 14px;
        }
    }

    .top-track-art {
        width: 40px;
        height: 40px;
        border-radius: 4px;
        overflow: hidden;
        flex-shrink: 0;
    }

    .top-track-art img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .top-track-art-placeholder {
        width: 100%;
        height: 100%;
        background: var(--surface-elevated, rgba(255, 255, 255, 0.06));
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-subdued);
    }

    .top-track-info {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
    }

    .top-track-title {
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-medium);
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .top-track-title.accent {
        color: var(--accent-primary);
    }

    .top-track-artist {
        font-size: var(--font-size-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        background: none;
        border: none;
        padding: 0;
        text-align: left;
        cursor: pointer;
    }

    .top-track-artist.link:hover {
        text-decoration: underline;
        color: var(--text-primary);
    }

    .top-track-plays {
        font-size: var(--font-size-xs);
        color: var(--text-subdued);
        flex-shrink: 0;
    }

    .top-track-duration {
        font-size: var(--font-size-xs);
        color: var(--text-subdued);
        width: 48px;
        text-align: right;
        flex-shrink: 0;
    }
</style>
