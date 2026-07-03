// Activity store - manages play history and activity data
import { writable, get } from 'svelte/store';
import { recordPlay, getTopTracks, getTopAlbums, getRecentlyPlayed, getTopArtists, getStatsSummary, getContinueListening, getRecentlyAddedAlbums, type Track, type Album, type TrackWithCount, type AlbumWithCount, type ArtistWithCount, type StatsSummary } from '$lib/api/tauri';

export const topTracks = writable<TrackWithCount[]>([]);
export const topAlbums = writable<AlbumWithCount[]>([]);
export const topArtists = writable<ArtistWithCount[]>([]);
export const recentlyPlayed = writable<Track[]>([]);
export const continueListening = writable<Track[]>([]);
export const recentlyAddedAlbums = writable<Album[]>([]);
export const statsSummary = writable<StatsSummary | null>(null);
export const isLoadingActivity = writable<boolean>(false);

// Record a play event for a track
export async function recordTrackPlay(trackId: number, albumId: number | null, durationPlayed: number): Promise<void> {
    // Only record for tracks with numeric IDs (library tracks)
    if (typeof trackId !== 'number') {
        return;
    }

    try {
        await recordPlay(trackId, albumId, durationPlayed);
    } catch (error) {
        console.error('[Activity] Failed to record play:', error);
    }
}

// Load activity data (top tracks, top albums, recently played)
export async function loadActivityData(): Promise<void> {
    if (get(isLoadingActivity)) return;

    isLoadingActivity.set(true);
    try {
        const [topT, topA, topArt, recent, stats, contList, recAdd] = await Promise.all([
            getTopTracks(50),
            getTopAlbums(20),
            getTopArtists(20),
            getRecentlyPlayed(20),
            getStatsSummary(),
            getContinueListening(20),
            getRecentlyAddedAlbums(20),
        ]);
        topTracks.set(topT);
        topAlbums.set(topA);
        topArtists.set(topArt);
        recentlyPlayed.set(recent);
        statsSummary.set(stats);
        continueListening.set(contList);
        recentlyAddedAlbums.set(recAdd);
    } catch (error) {
        console.error('[Activity] Failed to load activity data:', error);
    } finally {
        isLoadingActivity.set(false);
    }
}

// Refresh just recently played (lightweight)
export async function refreshRecentlyPlayed(): Promise<void> {
    try {
        const recent = await getRecentlyPlayed(20);
        recentlyPlayed.set(recent);
    } catch (error) {
        console.error('[Activity] Failed to refresh recently played:', error);
    }
}

// Clear all activity data (e.g. when switching accounts/servers)
export function clearActivityData(): void {
    topTracks.set([]);
    topAlbums.set([]);
    topArtists.set([]);
    recentlyPlayed.set([]);
    continueListening.set([]);
    recentlyAddedAlbums.set([]);
    statsSummary.set(null);
}
