// MediaSession API + Windows taskbar thumbar integration
import { get } from 'svelte/store';
import { currentTrack, currentTime, duration, isPlaying, activeBackend, volume } from './stores';
import { getTrackCoverSrc, convertFileSrc, listen, initWindowsThumbar, updateWindowsThumbarState } from '$lib/api/tauri';
import { getAlbumCoverFromTracks } from '$lib/stores/library';
import type { Track } from '$lib/api/tauri';
import { invoke } from '@tauri-apps/api/core';
import { activeRemoteDevice } from '$lib/stores/websocket';
import { throttledRemoteCommand } from './remote';
import {
    html5Seek,
} from '$lib/services/html5-audio';
import {
    nativeAudioSeek,
} from '$lib/services/native-audio';

// Forward declarations — filled by backend.ts after init
let _onPrevious: () => void = () => {};
let _onTogglePlay: () => void = () => {};
let _onNext: () => void = () => {};

export function registerMediaSessionActions(prev: () => void, toggle: () => void, next: () => void): void {
    _onPrevious = prev;
    _onTogglePlay = toggle;
    _onNext = next;
}

let mediaSessionInitialized = false;
let windowsThumbarInitialized = false;

export async function initWindowsThumbarIntegration(): Promise<void> {
    if (windowsThumbarInitialized) return;

    try {
        const initialized = await initWindowsThumbar();
        if (!initialized) return;

        await listen<{ action?: string }>('windows://thumbar-action', ({ payload }) => {
            const action = payload?.action;
            if (!action) return;

            switch (action) {
                case 'previous':
                    void _onPrevious();
                    break;
                case 'toggle_play_pause':
                    void _onTogglePlay();
                    break;
                case 'next':
                    _onNext();
                    break;
            }
        });

        windowsThumbarInitialized = true;
        await updateWindowsThumbarState(get(isPlaying));
        console.log('[Player] Windows taskbar thumbar initialized');
    } catch (err) {
        console.warn('[Player] Windows thumbar init failed:', err);
    }
}

export function initMediaSessionHandlers(): void {
    if (mediaSessionInitialized || !('mediaSession' in navigator)) return;

    const ms = navigator.mediaSession;

    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
        try {
            ms.setActionHandler(action, handler);
        } catch (err) {
            console.debug(`[MediaSession] Action not supported: ${action}`, err);
        }
    };

    setHandler('play', () => { void _onTogglePlay(); });
    setHandler('pause', () => { void _onTogglePlay(); });
    setHandler('stop', () => { void _onTogglePlay(); });
    setHandler('previoustrack', () => { void _onPrevious(); });
    setHandler('nexttrack', () => { void _onNext(); });
    setHandler('seekto', (details) => {
        if (details.seekTime != null) {
            const dur = get(duration);
            if (dur > 0) {
                const fraction = details.seekTime / dur;
                const backend = get(activeBackend);
                if (backend === 'remote') {
                    const targetId = get(activeRemoteDevice);
                    if (targetId) throttledRemoteCommand(targetId, 'seek', { position: fraction }, 100);
                } else if (backend === 'html5') {
                    html5Seek(fraction);
                } else if (backend === 'native') {
                    nativeAudioSeek(fraction).catch(console.error);
                }
            }
        }
    });
    setHandler('seekbackward', (details) => {
        const offset = details.seekOffset || 10;
        const cur = get(currentTime);
        const dur = get(duration);
        if (dur > 0) {
            const fraction = Math.max(0, cur - offset) / dur;
            const backend = get(activeBackend);
            if (backend === 'remote') {
                const targetId = get(activeRemoteDevice);
                if (targetId) throttledRemoteCommand(targetId, 'seek', { position: fraction }, 100);
            } else if (backend === 'html5') {
                html5Seek(fraction);
            } else if (backend === 'native') {
                nativeAudioSeek(fraction).catch(console.error);
            }
        }
    });
    setHandler('seekforward', (details) => {
        const offset = details.seekOffset || 10;
        const cur = get(currentTime);
        const dur = get(duration);
        if (dur > 0) {
            const fraction = Math.min(dur, cur + offset) / dur;
            const backend = get(activeBackend);
            if (backend === 'remote') {
                const targetId = get(activeRemoteDevice);
                if (targetId) throttledRemoteCommand(targetId, 'seek', { position: fraction }, 100);
            } else if (backend === 'html5') {
                html5Seek(fraction);
            } else if (backend === 'native') {
                nativeAudioSeek(fraction).catch(console.error);
            }
        }
    });

    mediaSessionInitialized = true;
    console.log('[Player] MediaSession action handlers registered');
}

export async function updateMediaSessionMetadata(track: Track): Promise<void> {
    if (!('mediaSession' in navigator)) return;

    initMediaSessionHandlers();

    console.log('[MediaSession] Updating metadata for:', track.title);

    const artworkSources: MediaImage[] = [];
    let artUrl: string | null = null;

    if (track.track_cover && track.track_cover.startsWith('data:')) {
        try {
            console.log('[MediaSession] Saving Base64 artwork to temp file...');
            const tempPath = await invoke<string>('save_notification_image', { dataUri: track.track_cover });
            artUrl = convertFileSrc(tempPath);
            console.log('[MediaSession] Artwork saved to:', artUrl);
        } catch (e) {
            console.error('[MediaSession] Failed to save notification image:', e);
            artUrl = track.track_cover;
        }
    } else {
        artUrl = getTrackCoverSrc(track);
    }

    if (!artUrl && track.album_id) {
        artUrl = getAlbumCoverFromTracks(track.album_id);
    }

    if (artUrl) {
        console.log('[MediaSession] Setting artwork src:', artUrl.substring(0, 50) + '...');
        artworkSources.push(
            { src: artUrl, sizes: '512x512', type: 'image/jpeg' }
        );
    }

    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || 'Unknown Title',
            artist: track.artist || 'Unknown Artist',
            album: track.album || '',
            artwork: artworkSources,
        });
        console.log('[MediaSession] Metadata set successfully');
    } catch (err) {
        console.warn('[Player] Failed to set MediaSession metadata:', err);
    }
}

export function updateMediaSessionPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.playbackState = state;
    } catch (err) {
        // Ignore — some environments don't support playbackState setter
    }
}

export function updateMediaSessionPosition(): void {
    if (!('mediaSession' in navigator)) return;

    let dur = get(duration);
    let pos = get(currentTime);

    if (!dur || !isFinite(dur) || isNaN(dur)) return;

    try {
        const safePos = Math.max(0, Math.min(pos, dur));
        navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: 1,
            position: safePos,
        });
    } catch (err) {
        console.error('[MediaSession] setPositionState failed:', err);
    }
}
