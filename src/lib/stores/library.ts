// Library store - manages music library state
import { writable, derived, get } from 'svelte/store';
import type { Track, Album, Artist, Playlist } from '$lib/api/tauri';
import { getLibrary, getPlaylists, getAlbumCoverSrc, getAlbumArtSrc, getTracksPaginated, searchLibrary } from '$lib/api/tauri';

// BLOB URL CONVERSION
/**
 * Convert base64 data URI to Blob URL for better performance and shorter URLs
 */
function convertBase64ToBlobUrl(base64: string): string {
    // If it's already a URL or not base64, return as-is
    if (!base64 || base64.startsWith('http') || base64.startsWith('blob:')) {
        return base64;
    }

    // If it's not a data URI, assume it needs the header
    let dataUri = base64;
    if (!base64.startsWith('data:image')) {
        // Detect image type from base64 header
        if (base64.startsWith('/9j/')) {
            dataUri = `data:image/jpeg;base64,${base64}`;
        } else if (base64.startsWith('iVBOR')) {
            dataUri = `data:image/png;base64,${base64}`;
        } else {
            dataUri = `data:image/jpeg;base64,${base64}`;
        }
    }

    try {
        const [header, data] = dataUri.split(',');
        const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
        const binary = atob(data);
        const array = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            array[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([array], { type: mime });
        return URL.createObjectURL(blob);
    } catch (e) {
        console.error('[Library] Failed to convert base64 to blob URL:', e);
        return base64; // Fallback to original
    }
}

// Track created blob URLs for cleanup
const createdBlobUrls = new Set<string>();

/**
 * Revoke a blob URL and remove from tracking
 */
function revokeBlobUrl(url: string): void {
    if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
        createdBlobUrls.delete(url);
    }
}

// CONFIGURATION
const CACHE_CONFIG = {
    MAX_METADATA_CACHE: 100000,   // Increased for metadata
    MAX_ALBUM_ART_CACHE: 1000,    // Increased for better ux
    TRACK_BATCH_SIZE: 1000,       // Load tracks in batches
    ENABLE_SMART_LOADING: true,
};

// LRU CACHE
class LRUCache<K, V> {
    private cache = new Map<K, { value: V; timestamp: number }>();
    private maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;
        entry.timestamp = Date.now();
        return entry.value;
    }

    set(key: K, value: V): void {
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            this.evictOldest();
        }
        this.cache.set(key, { value, timestamp: Date.now() });
    }

    has(key: K): boolean {
        return this.cache.has(key);
    }

    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    private evictOldest(): void {
        let oldestKey: K | null = null;
        let oldestTime = Date.now();

        this.cache.forEach((entry, key) => {
            if (entry.timestamp < oldestTime) {
                oldestTime = entry.timestamp;
                oldestKey = key;
            }
        });

        if (oldestKey !== null) {
            this.cache.delete(oldestKey);
        }
    }

    get size(): number {
        return this.cache.size;
    }
}

// LIGHTWEIGHT DATA STRUCTURES
/**
 * Lightweight track metadata (without heavy base64 album art)
 * Uses Omit to automatically derive from Track, ensuring type safety
 */
type TrackMetadata = Omit<Track, 'track_cover'>;

// same for albums
type AlbumMetadata = Omit<Album, 'art_data'> & {
    has_art: boolean; // Additional field to track if art exists
};

// INTERNAL STORAGE
// Metadata caches (lightweight)
const trackMetadataCache = new LRUCache<number, TrackMetadata>(CACHE_CONFIG.MAX_METADATA_CACHE);
const albumMetadataCache = new LRUCache<number, AlbumMetadata>(CACHE_CONFIG.MAX_METADATA_CACHE);

// Album art cache (separate, heavy data)
const albumArtCache = new LRUCache<number, string>(CACHE_CONFIG.MAX_ALBUM_ART_CACHE);

// Track cover cache (for tracks with embedded covers)
const trackCoverCache = new LRUCache<number, string>(500);

// Full object cache (for recently accessed items)
const fullTrackCache = new LRUCache<number, Track>(1000);
const fullAlbumCache = new LRUCache<number, Album>(200);

// Track ID to Album ID mapping (for album cover lookups)
const trackToAlbumMap = new Map<number, number>();

// Album ID to Track IDs mapping (for finding tracks in an album)
const albumToTracksMap = new Map<number, number[]>();

// SVELTE STORES
// Main stores (now contain ALL items but as lightweight metadata)
export const tracks = writable<Track[]>([]);

// Album store
export const albums = writable<Album[]>([]);

// Artist store
export const artists = writable<Artist[]>([]);

// Playlist store
export const playlists = writable<Playlist[]>([]);

// Loading state
export const isLoading = writable(false);

// Error state
export const lastError = writable<string | null>(null);

// Counts (derived from metadata cache, not array length)
let totalTrackCount = 0;
let totalAlbumCount = 0;
let totalArtistCount = 0;

export const trackCount = writable(0);
export const albumCount = writable(0);
export const artistCount = writable(0);

// HELPER FUNCTIONS
/**
 * Strip heavy data from track (remove base64 album art)
 */
function stripTrackHeavyData(track: Track): TrackMetadata {
    const { track_cover, ...metadata } = track;
    return metadata;
}

/**
 * Strip heavy data from album
 */
function stripAlbumHeavyData(album: Album): AlbumMetadata {
    const { art_data, ...metadata } = album;
    return {
        ...metadata,
        has_art: !!art_data,
    };
}

/**
 * Reconstruct track from metadata + cached heavy data
 */
function reconstructTrack(metadata: TrackMetadata): Track {
    const track_cover = trackCoverCache.get(metadata.id) || null;

    return {
        ...metadata,
        track_cover,
    } as Track;
}

/**
 * Reconstruct album from metadata + cached art
 */
function reconstructAlbum(metadata: AlbumMetadata): Album {
    const art_data = albumArtCache.get(metadata.id) || null;

    return {
        ...metadata,
        art_data,
    } as Album;
}

// DATA ACCESS APIS (for components)
/**
 * Get full track with heavy data (for playback)
 * @param trackId - The track ID
 * @param preferBase64 - If true, converts blob URLs back to base64 data URIs (for plugins/exports)
 */
export async function getFullTrack(trackId: number, preferBase64: boolean = false): Promise<Track | null> {
    // Check full cache first (but only if not requesting base64)
    if (!preferBase64) {
        const cached = fullTrackCache.get(trackId);
        if (cached) return cached;
    }

    // Reconstruct from metadata + caches
    const metadata = trackMetadataCache.get(trackId);
    if (!metadata) return null;

    let track = reconstructTrack(metadata);

    // Convert blob URL to base64 data URI if requested
    if (preferBase64 && track.track_cover && track.track_cover.startsWith('blob:')) {
        try {
            const response = await fetch(track.track_cover);
            const blob = await response.blob();
            const dataUri = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            track = { ...track, track_cover: dataUri };
        } catch (error) {
            console.error('[Library] Failed to convert blob URL to data URI:', error);
            // Keep the blob URL as fallback
        }
    }

    // Only cache if not base64 version (to avoid caching duplicates)
    if (!preferBase64) {
        fullTrackCache.set(trackId, track);
    }

    return track;
}

/**
 * Get full album with art data
 */
export function getFullAlbum(albumId: number): Album | null {
    // Check full cache first
    const cached = fullAlbumCache.get(albumId);
    if (cached) return cached;

    // Reconstruct from metadata + art cache
    const metadata = albumMetadataCache.get(albumId);
    if (!metadata) return null;

    const album = reconstructAlbum(metadata);
    fullAlbumCache.set(albumId, album);
    return album;
}

/**
 * Get track cover art (for TrackList)
 */
export function getTrackCover(trackId: number): string | null {
    return trackCoverCache.get(trackId) || null;
}

/**
 * Get album art (for AlbumGrid)
 */
export function getAlbumArt(albumId: number): string | null {
    return albumArtCache.get(albumId) || null;
}

/**
 * Get album cover for a track (follows priority: track_cover → cover_url → album art)
 */
export function getTrackAlbumCover(trackId: number): string | null {
    const metadata = trackMetadataCache.get(trackId);
    if (!metadata) return null;

    // Priority 1: Track's embedded cover
    const trackCover = trackCoverCache.get(trackId);
    if (trackCover) return trackCover;

    // Priority 2: External cover URL
    if (metadata.cover_url) return metadata.cover_url;

    // Priority 3: Album art
    if (metadata.album_id) {
        const albumArt = albumArtCache.get(metadata.album_id);
        if (albumArt) return albumArt;
    }

    return null;
}

/**
 * Get first track's cover for an album (for AlbumGrid)
 */
export function getAlbumCoverFromTracks(albumId: number): string | null {
    // Check album art first
    const album = get(albums).find(a => a.id === albumId);
    if (album) {
        // Priority 1: Album's file-based art
        if (album.art_path) {
            return getAlbumCoverSrc(album);
        }
        // Priority 2: Album's base64 art - old
        if (album.art_data) {
            return getAlbumArtSrc(album.art_data);
        }
    }

    // Priority 3: Get tracks in this album and find first track with cover
    const trackIds = albumToTracksMap.get(albumId);
    if (!trackIds || trackIds.length === 0) return null;

    // Find first track with cover
    for (const trackId of trackIds) {
        const cover = getTrackAlbumCover(trackId);
        if (cover) return cover;
    }

    return null;
}

/**
 * Batch get tracks (for player queue, etc.)
 * @param trackIds - Array of track IDs
 * @param preferBase64 - If true, returns tracks with base64 data URIs instead of blob URLs
 */
export async function getFullTracks(trackIds: number[], preferBase64: boolean = false): Promise<Track[]> {
    const tracks = await Promise.all(
        trackIds.map(id => getFullTrack(id, preferBase64))
    );
    return tracks.filter((t): t is Track => t !== null);
}

// LOADING FUNCTIONS
/**
 * Load more tracks from the backend (pagination)
 */
export async function loadMoreTracks(): Promise<boolean> {
    if (get(isLoading)) return false;

    const currentTracks = get(tracks);
    const offset = currentTracks.length;

    // If we've already loaded everything, don't bother
    if (offset >= get(trackCount) && get(trackCount) > 0) return false;

    isLoading.set(true);
    try {
        const newTracks = await getTracksPaginated(CACHE_CONFIG.TRACK_BATCH_SIZE, offset);
        if (newTracks.length > 0) {
            tracks.update(t => [...t, ...newTracks]);

            // Cache metadata and covers
            newTracks.forEach(track => {
                const metadata = stripTrackHeavyData(track);
                trackMetadataCache.set(track.id, metadata);

                if (track.track_cover_path && !trackCoverCache.has(track.id)) {
                    // (new cover logic uses file paths directly, so we don't need blob URLs as much)
                }
                if (track.album_id) {
                    trackToAlbumMap.set(track.id, track.album_id);
                    const albumTracks = albumToTracksMap.get(track.album_id) || [];
                    if (!albumTracks.includes(track.id)) {
                        albumTracks.push(track.id);
                        albumToTracksMap.set(track.album_id, albumTracks);
                    }
                }
            });
            return true;
        }
        return false;
    } catch (error) {
        console.error('[Library] Failed to load more tracks:', error);
        return false;
    } finally {
        isLoading.set(false);
    }
}

/**
 * Search library using backend FTS5
 */
export async function searchInLibrary(query: string): Promise<void> {
    if (!query || query.trim().length < 2) {
        // Reset to initial library view if search cleared
        loadLibrary();
        return;
    }

    isLoading.set(true);
    try {
        const results = await searchLibrary(query, 100, 0);
        tracks.set(results);
        // Note: we don't update trackCount during search to avoid breaking pagination logic
    } catch (error) {
        console.error('[Library] Search failed:', error);
    } finally {
        isLoading.set(false);
    }
}

/**
 * Load library with caching
 */
export async function loadLibrary(): Promise<void> {
    isLoading.set(true);
    lastError.set(null);

    try {
        // For large libraries, we only load the first batch initially
        console.time('[Library] IPC load initial');

        // Parallel load metadata for albums/artists but only first batch of tracks
        const [library, initialTracks] = await Promise.all([
            getLibrary(), // This returns all albums/artists but we'll use paginated tracks
            getTracksPaginated(CACHE_CONFIG.TRACK_BATCH_SIZE, 0)
        ]);

        console.timeEnd('[Library] IPC load initial');

        // Process albums and artists (usually much fewer than tracks)
        const lightAlbums: Album[] = [];
        library.albums.forEach(album => {
            const metadata = stripAlbumHeavyData(album);
            albumMetadataCache.set(album.id, metadata);
            lightAlbums.push({ ...metadata, art_data: null } as Album);
        });

        // Set counts
        trackCount.set(library.tracks.length); // Total count from light library
        albumCount.set(library.albums.length);
        artistCount.set(library.artists.length);

        // Set stores
        albums.set(lightAlbums);
        artists.set(library.artists);
        tracks.set(initialTracks);

        // Initial track processing
        initialTracks.forEach(track => {
            const metadata = stripTrackHeavyData(track);
            trackMetadataCache.set(track.id, metadata);

            if (track.album_id) {
                trackToAlbumMap.set(track.id, track.album_id);
                const albumTracks = albumToTracksMap.get(track.album_id) || [];
                if (!albumTracks.includes(track.id)) {
                    albumTracks.push(track.id);
                    albumToTracksMap.set(track.album_id, albumTracks);
                }
            }
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError.set(message);
        console.error('[Library] Failed to load library:', error);
    } finally {
        isLoading.set(false);
    }
}

// PLAYLISTS
export async function loadPlaylists(): Promise<void> {
    try {
        const playlistList = await getPlaylists();
        playlists.set(playlistList);
    } catch (error) {
        console.error('Failed to load playlists:', error);
    }
}

// REFRESH & CLEAR
export async function refreshAll(): Promise<void> {
    await Promise.all([loadLibrary(), loadPlaylists()]);
}

// Clear library data (for cache clearing)
export async function clearLibrary(): Promise<void> {
    tracks.set([]);
    albums.set([]);
    artists.set([]);
    playlists.set([]);
    lastError.set(null);

    // Revoke all blob URLs before clearing caches
    createdBlobUrls.forEach(url => URL.revokeObjectURL(url));
    createdBlobUrls.clear();

    // Clear all caches
    trackMetadataCache.clear();
    albumMetadataCache.clear();
    albumArtCache.clear();
    trackCoverCache.clear();
    fullTrackCache.clear();
    fullAlbumCache.clear();
    trackToAlbumMap.clear();
    albumToTracksMap.clear();

    totalTrackCount = 0;
    totalAlbumCount = 0;
    totalArtistCount = 0;

    trackCount.set(0);
    albumCount.set(0);
    artistCount.set(0);
}

// CACHE STATS
export function getCacheStats() {
    return {
        metadata: {
            tracks: trackMetadataCache.size,
            albums: albumMetadataCache.size,
        },
        heavyData: {
            albumArt: albumArtCache.size,
            trackCovers: trackCoverCache.size,
        },
        fullObjects: {
            tracks: fullTrackCache.size,
            albums: fullAlbumCache.size,
        },
        mappings: {
            trackToAlbum: trackToAlbumMap.size,
            albumToTracks: albumToTracksMap.size,
        },
        totals: {
            tracks: totalTrackCount,
            albums: totalAlbumCount,
            artists: totalArtistCount,
        },
    };
}