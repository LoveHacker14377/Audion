<script lang="ts">
    import type { Track } from "$lib/api/tauri";

    export let track: Track;
    export let onClose: () => void;

    // Parse metadata_json into a display-friendly object
    $: metadata = (() => {
        if (!track.metadata_json) return null;
        try {
            return JSON.parse(track.metadata_json) as Record<string, string>;
        } catch {
            return null;
        }
    })();

    // Friendly labels for known keys
    const KEY_LABELS: Record<string, string> = {
        TrackTitle: "Title",
        TrackArtist: "Artist",
        AlbumTitle: "Album",
        AlbumArtist: "Album Artist",
        Composer: "Composer",
        Genre: "Genre",
        TrackNumber: "Track #",
        TrackTotal: "Total Tracks",
        DiscNumber: "Disc #",
        DiscTotal: "Total Discs",
        Year: "Year",
        Bpm: "BPM",
        Isrc: "ISRC",
        Label: "Label",
        CatalogNumber: "Catalog #",
        Comment: "Comment",
        Lyrics: "Lyrics",
        Conductor: "Conductor",
        Language: "Language",
        Publisher: "Publisher",
        EncoderSettings: "Encoder Settings",
    };

    function formatKey(key: string): string {
        return KEY_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").trim();
    }

    function handleBackdropClick(e: MouseEvent) {
        if ((e.target as HTMLElement).classList.contains("modal-backdrop")) {
            onClose();
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") onClose();
    }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="modal-backdrop" on:click={handleBackdropClick}>
    <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Track metadata"
    >
        <header class="modal-header">
            <div class="modal-title">
                <h2>{track.title ?? "Unknown Track"}</h2>
                <p class="subtitle">
                    {track.artist ?? "Unknown Artist"}{track.album
                        ? " · " + track.album
                        : ""}
                </p>
            </div>
            <button class="close-btn" on:click={onClose} aria-label="Close"
                >✕</button
            >
        </header>

        <div class="modal-body">
            <!-- Core info always shown -->
            <section class="metadata-section">
                <h3 class="section-label">File Info</h3>
                <div class="metadata-grid">
                    {#if track.format}
                        <div class="metadata-row">
                            <span class="meta-key">Format</span>
                            <span class="meta-value"
                                >{track.format.toUpperCase()}</span
                            >
                        </div>
                    {/if}
                    {#if track.bitrate}
                        <div class="metadata-row">
                            <span class="meta-key">Bitrate</span>
                            <span class="meta-value">{track.bitrate} kbps</span>
                        </div>
                    {/if}
                    {#if track.duration}
                        <div class="metadata-row">
                            <span class="meta-key">Duration</span>
                            <span class="meta-value"
                                >{Math.floor(track.duration / 60)}:{String(
                                    Math.floor(track.duration % 60),
                                ).padStart(2, "0")}</span
                            >
                        </div>
                    {/if}
                    {#if track.date_added}
                        <div class="metadata-row">
                            <span class="meta-key">Date Added</span>
                            <span class="meta-value"
                                >{new Date(
                                    track.date_added,
                                ).toLocaleDateString()}</span
                            >
                        </div>
                    {/if}
                    {#if track.path}
                        <div class="metadata-row file-path-row">
                            <span class="meta-key">Path</span>
                            <span class="meta-value path">{track.path}</span>
                        </div>
                    {/if}
                </div>
            </section>

            <!-- Embedded tags -->
            {#if metadata && Object.keys(metadata).length > 0}
                <section class="metadata-section">
                    <h3 class="section-label">Embedded Tags</h3>
                    <div class="metadata-grid">
                        {#each Object.entries(metadata) as [key, value]}
                            {#if value && key !== "Lyrics"}
                                <div class="metadata-row">
                                    <span class="meta-key"
                                        >{formatKey(key)}</span
                                    >
                                    <span class="meta-value">{value}</span>
                                </div>
                            {/if}
                        {/each}
                    </div>
                </section>

                <!-- Lyrics shown separately if present -->
                {#if metadata["Lyrics"]}
                    <section class="metadata-section">
                        <h3 class="section-label">Embedded Lyrics</h3>
                        <pre class="lyrics-block">{metadata["Lyrics"]}</pre>
                    </section>
                {/if}
            {:else}
                <div class="no-metadata">
                    <span>No additional metadata available.</span>
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        padding: 1rem;
    }

    .modal {
        background: linear-gradient(
            145deg,
            #1a1a2e 0%,
            #16213e 50%,
            #0f3460 100%
        );
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        width: min(680px, 100%);
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        box-shadow:
            0 24px 64px rgba(0, 0, 0, 0.6),
            0 0 0 1px rgba(255, 255, 255, 0.05);
        animation: modal-in 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }

    @keyframes modal-in {
        from {
            opacity: 0;
            transform: scale(0.9) translateY(12px);
        }
        to {
            opacity: 1;
            transform: scale(1) translateY(0);
        }
    }

    .modal-header {
        display: flex;
        align-items: flex-start;
        gap: 1rem;
        padding: 1.5rem 1.5rem 1rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        flex-shrink: 0;
    }

    .modal-title {
        flex: 1;
        min-width: 0;
    }

    .modal-title h2 {
        margin: 0;
        font-size: 1.2rem;
        font-weight: 700;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .subtitle {
        margin: 0.2rem 0 0;
        font-size: 0.85rem;
        color: rgba(255, 255, 255, 0.55);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .close-btn {
        background: rgba(255, 255, 255, 0.08);
        border: none;
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        border-radius: 50%;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.85rem;
        flex-shrink: 0;
        transition:
            background 0.15s,
            color 0.15s;
    }

    .close-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
    }

    .modal-body {
        padding: 1rem 1.5rem 1.5rem;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
    }

    .section-label {
        font-size: 0.7rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: rgba(255, 255, 255, 0.35);
        margin: 0 0 0.6rem;
    }

    .metadata-grid {
        display: flex;
        flex-direction: column;
        gap: 0;
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 10px;
        overflow: hidden;
    }

    .metadata-row {
        display: flex;
        align-items: baseline;
        gap: 1rem;
        padding: 0.5rem 0.9rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        transition: background 0.15s;
    }

    .metadata-row:last-child {
        border-bottom: none;
    }

    .metadata-row:hover {
        background: rgba(255, 255, 255, 0.04);
    }

    .meta-key {
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.45);
        min-width: 120px;
        flex-shrink: 0;
    }

    .meta-value {
        font-size: 0.85rem;
        color: rgba(255, 255, 255, 0.9);
        word-break: break-word;
    }

    .file-path-row {
        align-items: flex-start;
    }

    .path {
        font-family: "Courier New", monospace;
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.6);
        opacity: 0.8;
    }

    .lyrics-block {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 10px;
        padding: 1rem;
        font-size: 0.82rem;
        color: rgba(255, 255, 255, 0.7);
        line-height: 1.7;
        white-space: pre-wrap;
        margin: 0;
        max-height: 200px;
        overflow-y: auto;
    }

    .no-metadata {
        padding: 1.5rem;
        text-align: center;
        color: rgba(255, 255, 255, 0.3);
        font-size: 0.85rem;
        background: rgba(255, 255, 255, 0.03);
        border-radius: 10px;
    }

    @media (max-width: 480px) {
        .modal-backdrop {
            padding: 0;
        }
        .modal {
            border-radius: 16px 16px 0 0;
            align-self: flex-end;
            max-height: 90vh;
            width: 100%;
        }
        .meta-key {
            min-width: 90px;
        }
    }
</style>
