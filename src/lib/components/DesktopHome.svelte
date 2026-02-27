<script lang="ts">
    import { onMount } from "svelte";
    import {
      getAlbumCoverSrc,
      getTrackCoverSrc,
      formatDuration,
      type Track,
      type Album,
    } from "$lib/api/tauri";
    import {
      playTracks,
      addToQueue,
      currentAlbumId,
      currentTrackId,
      isPlaying,
      togglePlay,
    } from "$lib/stores/player";
    import { contextMenu } from "$lib/stores/ui";
    import { albums as libraryAlbums } from "$lib/stores/library";
    import {
        topTracks,
        topAlbums,
        recentlyPlayed,
        loadActivityData,
    } from "$lib/stores/activity";
    import { likedCount } from "$lib/stores/liked";
    import {
        goToAlbumDetail,
        goToArtistDetail,
        goToLikedSongs,
    } from "$lib/stores/view";
    import { isStatsWrappedOpen } from "$lib/stores/ui";
    import MediaCard from "./MediaCard.svelte";
  
    const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const currentMonthName = monthNames[new Date().getMonth()];
  
    let greeting = "Good evening";
    const hour = new Date().getHours();
    if (hour < 12) greeting = "Good morning";
    else if (hour < 18) greeting = "Good afternoon";

    onMount(() => {
        loadActivityData();
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
  
    // Extracted once
    $: topTrackList = $topTracks.map((t) => t.track);
  
    // Playback helpers 
    async function playAlbum(album: Album) {
      if (pausedAlbumId === album.id) { togglePlay(); return; }
      if (playingAlbumId === album.id && playing) return;
      goToAlbumDetail(album.id);
    }
  
    function playRecentTrack(track: Track, index: number) {
      playTracks($recentlyPlayed, index);
    }
  
    function playTopTrack(track: Track, index: number) {
      playTracks(topTrackList, index);
    }
  
    // Interaction helpers
    function handleContainerClick(e: MouseEvent, callback: () => void) {
      if ((e.target as HTMLElement).closest(".link") || (e.target as HTMLElement).closest("button")) return;
      callback();
    }
  
    // keyboard activation
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
        items: [
          { label: "Play", action: () => playAlbum(album) },
          { label: "Go to Album", action: () => goToAlbumDetail(album.id) },
          { label: "Go to Artist", action: () => goToArtistDetail(album.artist || "") },
        ],
      });
    }
  
    function trackContextMenu(track: Track, index: number, trackList: Track[], e: MouseEvent) {
      e.preventDefault();
      contextMenu.set({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Play", action: () => playTracks(trackList, index) },
          { label: "Add to Queue", action: () => addToQueue([track]) },
          { type: "separator" },
          { label: "Go to Artist", action: () => goToArtistDetail(track.artist || "") },
          {
            label: "Go to Album",
            action: () => { if (track.album_id) goToAlbumDetail(track.album_id); },
            disabled: !track.album_id,
          },
        ],
      });
    }
  </script>
  
  <div class="desktop-home">
    <!-- Greeting -->
    <header class="home-header">
        <h1 class="greeting">{greeting}</h1>
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
            <span>{currentMonthName} Recap</span>
        </button>
    </header>

    <!-- Quick Play Grid -->
    {#if quickPlayAlbums.length > 0}
      <section class="quick-play-section">
        <div class="quick-play-grid">
          {#each quickPlayAlbums as album}
            {@const isNowPlaying = playingAlbumId === album.id && playing}
            {@const isPaused = pausedAlbumId === album.id}
            <button
              class="quick-play-card"
              class:now-playing={isNowPlaying}
              class:paused={isPaused}
              on:click={() => playAlbum(album)}
              on:contextmenu={(e) => albumContextMenu(album, e)}
            >
              <div class="quick-play-art">
                {#if getAlbumCoverSrc(album)}
                  <img
                    src={getAlbumCoverSrc(album)}
                    alt={album.name}
                    loading="lazy"
                    decoding="async"
                  />
                {:else}
                  <div class="quick-play-placeholder">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
                    </svg>
                  </div>
                {/if}
                {#if isNowPlaying || isPaused}
                  <div class="quick-play-badge" class:paused-badge={isPaused}>
                    {isNowPlaying ? "Now Playing" : "Paused"}
                  </div>
                {/if}
              </div>
              <span class="quick-play-name">{album.name}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Recently Played -->
    {#if $recentlyPlayed.length > 0}
      <section class="home-section">
        <h2 class="section-title">Jump Back In</h2>
        <div class="carousel-row">
          {#each $recentlyPlayed.slice(0, 10) as track, i}
            {@const isNowPlaying = playingTrackId === track.id && playing}
            {@const isPaused = pausedTrackId === track.id}
            <div
              class="carousel-card-wrapper"
              on:contextmenu={(e) => trackContextMenu(track, i, $recentlyPlayed.slice(0, 10), e)}
            >
              <MediaCard
                {isNowPlaying}
                {isPaused}
                playTooltip="Play"
                resumeTooltip="Resume"
                pauseTooltip="Pause"
                primaryText={track.title || "Unknown"}
                secondaryText={track.artist || "Unknown"}
                ariaLabel={track.title || "Unknown"}
                on:play={() => playRecentTrack(track, i)}
                on:pause={togglePlay}
              >
                <svelte:fragment slot="cover">
                  {#if getTrackCoverSrc(track)}
                    <img
                      src={getTrackCoverSrc(track)}
                      alt={track.title}
                      loading="lazy"
                      decoding="async"
                    />
                  {:else}
                    <div class="cover-placeholder">
                      <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" aria-hidden="true">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
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

    <!-- Top Tracks -->
    {#if $topTracks.length > 0}
      <section class="home-section">
        <h2 class="section-title">Your Top Songs</h2>
        <div class="top-tracks-list">
          {#each $topTracks.slice(0, 10) as { track, play_count }, i}
            {@const isNowPlaying = playingTrackId === track.id && playing}
            {@const isPaused = pausedTrackId === track.id}
            <div
              class="top-track-row"
              class:now-playing={isNowPlaying}
              class:paused={isPaused}
              role="button"
              tabindex="0"
              on:click={(e) => handleContainerClick(e, () => playTopTrack(track, i))}
              on:keydown={(e) => handleKeyActivate(e, () => playTopTrack(track, i))}
              on:contextmenu={(e) => trackContextMenu(track, i, topTrackList, e)}
            >
              <span class="top-track-rank">
                {#if isNowPlaying}
                  <span class="equalizer" aria-label="Now playing">
                    <span class="bar"></span>
                    <span class="bar"></span>
                    <span class="bar"></span>
                  </span>
                {:else if isPaused}
                  <span class="equalizer paused" aria-label="Paused">
                    <span class="bar"></span>
                    <span class="bar"></span>
                    <span class="bar"></span>
                  </span>
                {:else}
                  {i + 1}
                {/if}
              </span>
              <div class="top-track-art">
                {#if getTrackCoverSrc(track)}
                  <img src={getTrackCoverSrc(track)} alt={track.title} loading="lazy" decoding="async" />
                {:else}
                  <div class="top-track-art-placeholder">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                    </svg>
                  </div>
                {/if}
              </div>
              <div class="top-track-info">
                <span class="top-track-title" class:accent={isNowPlaying || isPaused}>{track.title || "Unknown"}</span>
                <button
                  class="top-track-artist link"
                  on:click|stopPropagation={() => goToArtistDetail(track.artist || "")}
                  title="Go to artist"
                >
                  {track.artist || "Unknown"}
                </button>
              </div>
              <span class="top-track-plays">{play_count} plays</span>
              <span class="top-track-duration">{formatDuration(track.duration)}</span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Top Albums (List View) -->
    {#if $topAlbums.length > 0}
      <section class="home-section">
        <h2 class="section-title">Most Played Albums</h2>
        <div class="top-tracks-list">
          {#each $topAlbums.slice(0, 10) as { album, play_count }, i}
            {@const isNowPlaying = playingAlbumId === album.id && playing}
            {@const isPaused = pausedAlbumId === album.id}
            <div
              class="top-track-row"
              class:now-playing={isNowPlaying}
              class:paused={isPaused}
              role="button"
              tabindex="0"
              on:click={(e) => handleContainerClick(e, () => goToAlbumDetail(album.id))}
              on:keydown={(e) => handleKeyActivate(e, () => goToAlbumDetail(album.id))}
              on:contextmenu={(e) => albumContextMenu(album, e)}
            >
              <span class="top-track-rank">
                {#if isNowPlaying}
                  <span class="equalizer" aria-label="Now playing">
                    <span class="bar"></span>
                    <span class="bar"></span>
                    <span class="bar"></span>
                  </span>
                {:else if isPaused}
                  <span class="equalizer paused" aria-label="Paused">
                    <span class="bar"></span>
                    <span class="bar"></span>
                    <span class="bar"></span>
                  </span>
                {:else}
                  {i + 1}
                {/if}
              </span>
              <div class="top-track-art">
                {#if getAlbumCoverSrc(album)}
                  <img src={getAlbumCoverSrc(album)} alt={album.name} loading="lazy" decoding="async" />
                {:else}
                  <div class="top-track-art-placeholder">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z" />
                    </svg>
                  </div>
                {/if}
              </div>
              <div class="top-track-info">
                <span class="top-track-title" class:accent={isNowPlaying || isPaused}>{album.name}</span>
                <button
                  class="top-track-artist link"
                  on:click|stopPropagation={() => goToArtistDetail(album.artist || "")}
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
</div>

<style>
    .desktop-home {
        padding: 24px 32px;
        overflow-y: auto;
        height: 100%;
    }

    .home-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-xl);
    }

    .greeting {
      font-size: 2rem;
      font-weight: 800;
      color: var(--text-primary);
      letter-spacing: -0.02em;
      margin: 0;
    }
  
    .recap-launch-btn {
      background: linear-gradient(135deg, #1ed760 0%, #17a34a 100%);
      color: black;
      border: none;
      padding: 8px 20px;
      border-radius: 20px;
      font-size: 0.9rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 12px rgba(30, 215, 96, 0.2);
    }
  
    .recap-launch-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(30, 215, 96, 0.3);
    }
  
    .recap-launch-btn:active {
      transform: translateY(0);
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
    }

    .quick-play-art img {
        width: 100%;
        height: 100%;
        object-fit: cover;
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
  
    .quick-play-badge {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      font-size: 0.55rem;
      font-weight: 700;
      color: var(--accent-primary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      pointer-events: none;
    }
  
    .quick-play-badge.paused-badge {
      color: var(--text-secondary);
    }
  
    .quick-play-name {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-right: 12px;
    }
  
    .quick-play-card.now-playing .quick-play-name,
    .quick-play-card.paused .quick-play-name {
      color: var(--accent-primary);
    }

    /* Section */
    .home-section {
        margin-bottom: 32px;
    }

    .section-title {
        font-size: 1.4rem;
        font-weight: 700;
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
  
    .carousel-row::-webkit-scrollbar { height: 6px; }
    .carousel-row::-webkit-scrollbar-track { background: transparent; border-radius: 3px; }
    .carousel-row::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 3px; }
    .carousel-row::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.35); }
  
    /* Fixed-width wrapper for MediaCard */
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
        font-size: 1rem;
        font-weight: 700;
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
  
    /* Equalizer animation for now-playing rows */
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
  
    .equalizer .bar:nth-child(2) { animation-delay: 0.2s; }
    .equalizer .bar:nth-child(3) { animation-delay: 0.4s; }
  
    .equalizer.paused .bar {
      animation-play-state: paused;
      height: 8px;
      background-color: var(--text-secondary);
    }
  
    @keyframes equalizer {
      0%, 100% { height: 4px; }
      50% { height: 14px; }
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
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
  
    .top-track-title.accent {
      color: var(--accent-primary);
    }
  
    .top-track-artist {
        font-size: 0.75rem;
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
        font-size: 0.75rem;
        color: var(--text-subdued);
        flex-shrink: 0;
    }

    .top-track-duration {
        font-size: 0.75rem;
        color: var(--text-subdued);
        width: 48px;
        text-align: right;
        flex-shrink: 0;
    }
  </style>