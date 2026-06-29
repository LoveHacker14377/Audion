// Player store - manages audio playback state
import { writable, derived, get } from 'svelte/store';
import { wsStore } from './websocket';
import type { Track } from '$lib/api/tauri';
import {
    getAudioSrc,
    getAlbumArtSrc,
    getTrackCoverSrc,
    convertFileSrc,
    listen,
    initWindowsThumbar,
    updateWindowsThumbarState,
    audioResolvePath,
    audioGetStreamUrl
} from '$lib/api/tauri';
import { invoke } from '@tauri-apps/api/core';
import { addToast } from '$lib/stores/toast';
import { EventEmitter, type PluginEvents } from '$lib/plugins/event-emitter';
import { tracks as libraryTracks, getFullTrack, getAlbumCoverFromTracks, updateTrackCover, getTrackByIdSync } from '$lib/stores/library';
import { fetchTrackCover } from '$lib/services/cover-fetcher';
import { appSettings } from '$lib/stores/settings';
import { equalizer, type EqualizerState } from '$lib/stores/equalizer';
import { pluginStore } from '$lib/stores/plugin-store';
import { recordTrackPlay } from '$lib/stores/activity';
import { submitListenbrainzListen } from '$lib/api/tauri';
import { activeRemoteDevice } from '$lib/stores/websocket';
import { isFullScreen, toggleFullScreen } from '$lib/stores/ui';

// =============================================================================
// NATIVE AUDIO BACKEND
// =============================================================================
import {
    nativeAudioPlay,
    nativeAudioPreload,
    nativeAudioPause,
    nativeAudioResume,
    nativeAudioStop,
    nativeAudioSetVolume,
    nativeAudioSeek,
    nativeAudioSetRepeatOne,
    type AudioEventType,
    nativeAudioSetEq,
    nativeAudioSetReplayGainEnabled,
    nativeAudioSetOutputDevice,
    shouldUseNativeAudio,
} from '$lib/services/native-audio';

// =============================================================================
// HTML5 AUDIO BACKEND
// =============================================================================
import {
    html5SetCallbacks,
    html5Play,
    html5Pause,
    html5Resume,
    html5Stop,
    html5Seek,
    html5SetVolume,
    html5GetState,
    html5Cleanup,
    html5Preload,
    html5SwapPreload,
    html5ClearPreload,
    html5StartCrossfade,
} from '$lib/services/html5-audio';

// Interval for polling native playback state
// =============================================================================
// DEAD-RECKONING STATE (native backend only)
// position is computed locally between backend events using:
//   currentTime = _reckoningOffset + (now - _reckoningStartedAt) / 1000
//
// baseline is reset on every real event: play, seek (correction), pause, resume, gapless advance, TrackFinished
// =============================================================================

let _reckoningOffset: number = 0;       // confirmed position in seconds at last event
let _reckoningStartedAt: number = 0;    // performance.now() at last event
let _reckoningActive: boolean = false;  // true only while native is playing
let _reckoningRafId: number | null = null;

function _startReckoning(offsetSecs: number): void {
    _reckoningOffset = offsetSecs;
    _reckoningStartedAt = performance.now();
    _reckoningActive = true;
    if (_reckoningRafId === null) {
        _reckoningRafId = requestAnimationFrame(_reckoningTick);
    }
}

function _stopReckoning(snapshotSecs?: number): void {
    _reckoningActive = false;
    if (_reckoningRafId !== null) {
        cancelAnimationFrame(_reckoningRafId);
        _reckoningRafId = null;
    }
    if (snapshotSecs !== undefined) {
        _reckoningOffset = snapshotSecs;
        currentTime.set(snapshotSecs);
    }
}

function _correctReckoning(confirmedSecs: number): void {
    // snap the baseline to the backend-confirmed position if the drift exceeds 1 second
    const estimated = _reckoningOffset + (performance.now() - _reckoningStartedAt) / 1000;
    const drift = Math.abs(estimated - confirmedSecs);
    _reckoningOffset = confirmedSecs;
    _reckoningStartedAt = performance.now();
    if (drift > 1.0) {
        currentTime.set(confirmedSecs);
    }
}

function _reckoningTick(): void {
    if (!_reckoningActive) {
        _reckoningRafId = null;
        return;
    }
    const elapsed = (performance.now() - _reckoningStartedAt) / 1000;
    const position = _reckoningOffset + elapsed;
    const dur = get(duration);

    // clamp to duration
    currentTime.set(dur > 0 ? Math.min(position, dur) : position);

    pluginEvents.emit('timeUpdate', { currentTime: position, duration: dur });

    if (get(isPlaying)) {
        updateMediaSessionPosition();
    }

    _reckoningRafId = requestAnimationFrame(_reckoningTick);
}

// HTML5 POSITION TICKER
// html5GetState() reads directly from the <audio> element
// Still use rAF so position updates are frame-rate-aligned, not timer-based

let _html5RafId: number | null = null;
let _hasCrossfaded = false;

function _startHtml5Ticker(): void {
    if (_html5RafId !== null) return;
    _html5RafId = requestAnimationFrame(_html5Tick);
}

function _stopHtml5Ticker(): void {
    if (_html5RafId !== null) {
        cancelAnimationFrame(_html5RafId);
        _html5RafId = null;
    }
}

function _html5Tick(): void {
    if (!get(isPlaying) || get(activeBackend) !== 'html5') {
        _html5RafId = null;
        return;
    }
    const state = html5GetState();
    currentTime.set(state.position);
    if (state.duration > 0 && !isNaN(state.duration)) duration.set(state.duration);
    pluginEvents.emit('timeUpdate', { currentTime: state.position, duration: state.duration });
    if (get(isPlaying)) updateMediaSessionPosition();

    // Check for early crossfade trigger
    const settings = get(appSettings);
    if (settings.crossfadeSeconds > 0 && state.duration > settings.crossfadeSeconds && !_hasCrossfaded) {
        const threshold = state.duration - settings.crossfadeSeconds;
        if (state.position >= threshold) {
            _hasCrossfaded = true;
            _triggerHtml5Crossfade();
        }
    }

    _html5RafId = requestAnimationFrame(_html5Tick);
}

async function _triggerHtml5Crossfade(): Promise<void> {
    const q = get(queue);
    const nextIdx = _advanceQueueIndex(true);
    if (nextIdx === null || nextIdx >= q.length) {
        return;
    }

    const nextTrackObj = q[nextIdx];
    if (!nextTrackObj) return;

    const streaming = isStreaming(nextTrackObj) || !!(nextTrackObj as any).stream_url || (nextTrackObj.path && (nextTrackObj.path.startsWith('http://') || nextTrackObj.path.startsWith('https://')));
    if (!streaming) {
        return;
    }

    const settings = get(appSettings);
    const vol = sliderToAudioVolume(get(volume));
    console.log('[Player] Triggering HTML5 crossfade into next track:', nextTrackObj.title);

    const started = await html5StartCrossfade(nextTrackObj.id, vol, settings.crossfadeSeconds);
    if (started) {
        handleGaplessAdvance();
    } else {
        _hasCrossfaded = false;
    }
}

// Track which backend is currently active ('native', 'html5', 'remote', or 'none')
export type ActiveBackend = 'native' | 'html5' | 'remote' | 'none';
export const activeBackend = writable<ActiveBackend>('none');

// Track if we should use native audio based on platform/settings
let nativeAudioUsed = false;

// Note: html5-audio.ts has its own copy of classifyAudioPath for internal use.
// This copy exists solely for the custom-scheme check in playTrack.
// If the classification logic ever changes, update both.
type AudioPathKind = 'local' | 'stream' | 'blob' | 'custom-scheme';

function classifyAudioPath(path: string): AudioPathKind {
    if (path.startsWith('blob:')) return 'blob';
    if (path.startsWith('http://') || path.startsWith('https://')) return 'stream';
    if (path.startsWith('file://') || path.startsWith('asset://') || path.startsWith('tauri://')) return 'local';
    if (path.includes('://')) return 'custom-scheme';
    return 'local'; // absolute/relative filesystem path
}

/**
 * Detect if a track needs HTML5 streaming or native local playback
 */
export function isStreaming(track: Track): boolean {
    // 1. Explicitly local sources (by type or path)
    if (track.source_type === 'local' || track.source_type === 'server' || track.local_src) return false;

    if (track.path) {
        // Tauri local protocols are always local
        if (track.path.startsWith('file://') || track.path.startsWith('asset://') || track.path.startsWith('tauri://')) {
            return false;
        }
        // Explicitly streaming protocols
        if (track.path.startsWith('http://') || track.path.startsWith('https://')) {
            return true;
        }
    }

    // 3. Known external source types (Tidal, etc.)
    if (track.source_type && track.source_type !== 'local') return true;

    // 4. Default to local for anything else (safer for absolute paths)
    return false;
}

// Plugin event emitter (global singleton for plugin system)
export const pluginEvents = new EventEmitter<PluginEvents>();

// Playback Context Tracking
export interface PlaybackContext {
    type: 'playlist' | 'album' | 'artist';
    playlistId?: number;
    albumId?: number;
    artistName?: string;
    displayName?: string;
}

export const playbackContext = writable<PlaybackContext | null>(null);

export const currentPlaylistId = derived(
    playbackContext,
    ($ctx) => ($ctx?.type === 'playlist' ? $ctx.playlistId ?? null : null)
);

export const currentAlbumId = derived(
    playbackContext,
    ($ctx) => ($ctx?.type === 'album' ? $ctx.albumId ?? null : null)
);

export const currentArtistName = derived(
    playbackContext,
    ($ctx) => ($ctx?.type === 'artist' ? $ctx.artistName ?? null : null)
);

// Current track
export const currentTrack = writable<Track | null>(null);
export const currentTrackId = derived(currentTrack, ($t) => $t?.id ?? null);

// Playing state
export const isPlaying = writable(false);

// Queue
export const queue = writable<Track[]>([]);
export const queueIndex = writable(0);
export const userQueueCount = writable(0);

// Volume (0-1) - this is the SLIDER value (linear)
export const volume = writable(0.7);

export function sliderToAudioVolume(sliderValue: number): number {
    return Math.pow(sliderValue, 2);
}

export function audioVolumeToSlider(audioVolume: number): number {
    return Math.sqrt(audioVolume);
}

// Playback session tracking
let currentSessionId = 0;
let playStartTime: number = 0;

// Current time and duration
export const currentTime = writable(0);
export const duration = writable(0);

// Shuffle and repeat
export const shuffle = writable(false);
export const repeat = writable<'none' | 'one' | 'all'>('none');

// Subscribe to EQ changes — native half only.
// The HTML5 half is handled inside html5-audio.ts via its own subscription.
//
// debounce: we only send the last state seen during a 200ms burst of EQ sliders
// The backend is checked at the moment the timer fires, not when the subscription
// first ran, so we never send to a backend that became inactive mid-drag
let _eqApplyTimer: ReturnType<typeof setTimeout> | null = null;
let _latestEqState: any = null;
equalizer.subscribe((state) => {
    _latestEqState = state;

    if (_eqApplyTimer) clearTimeout(_eqApplyTimer);
    _eqApplyTimer = setTimeout(async () => {
        _eqApplyTimer = null;

        // re-check backend at fire time as it may have changed during the debounce window
        if (get(activeBackend) !== 'native') return;

        try {
            await nativeAudioSetEq(_latestEqState);
        } catch (err) {
            console.error('[EQ] Failed to apply settings:', err);
            addToast('Failed to apply equalizer settings', 'error');
        }
    }, 200);
});

// =============================================================================
// BACKEND INITIALIZATION
// =============================================================================
export async function initAudioBackend(): Promise<void> {
    console.log('[Player] Initializing audio backend');

    // Wire up HTML5 backend callbacks
    html5SetCallbacks({
        onEnded: () => handleTrackEnd(),
        onError: (message) => addToast(`Streaming playback failed: ${message}`, 'error'),
        onTimeUpdate: (position, dur) => {
            // durationchange pushes here immediately when browser parses duration,
            // ahead of the next poller tick.
            if (dur > 0 && !isNaN(dur)) duration.set(dur);
        },
        onPlayStateChange: (playing) => {
            if (get(activeBackend) === 'html5') {
                isPlaying.set(playing);
                updateMediaSessionPlaybackState(playing ? 'playing' : 'paused');
                updateSmtcPlaybackState(playing ? 'playing' : 'paused');
            }
        },
    });

    // Check if we should use native audio
    nativeAudioUsed = await shouldUseNativeAudio();
    console.log(`[Player] Native audio preferred: ${nativeAudioUsed}`);

    // register the native audio event listener once
    // backend emits 'audio://event' via app_handle.emit
    if (nativeAudioUsed) {
        listen<AudioEventType>('audio://event', ({ payload: event }) => {
            if (event.type === 'TrackFinished') {
                _stopReckoning(get(currentTime));
                handleTrackEnd();
            } else if (event.type === 'TrackAdvanced') {
                _startReckoning(0);
                handleGaplessAdvance();
            } else if (event.type === 'StateChanged') {
                // backend-confirmed position after keyframe alignment or repeat-one loop
                // correct the reckoning baseline if drift exceeds 1 second
                _correctReckoning(event.data.position);
                if (event.data.position === 0) {
                    // repeat-one loop
                    isPlaying.set(true);
                    updateMediaSessionPlaybackState('playing');
                    updateSmtcPlaybackState('playing');
                }
            } else if (event.type === 'DeviceListChanged') {
                console.log('[Player] Device list updated');
            } else if (event.type === 'Error') {
                console.error('[Player] Backend error event:', JSON.stringify(event));
                console.error('[Player] Backend error message:', event.data.message);
                addToast(`Audio error: ${event.data.message}`, 'error');
                // backend is now silent
                // reset UI state so player doesn't show stale track info
                // setting activeBackend to 'none' ensures resume() does a full reopen via playTrack
                _stopReckoning(get(currentTime));
                isPlaying.set(false);
                activeBackend.set('none');
                updateMediaSessionPlaybackState('paused');
                updateSmtcPlaybackState('paused');
            }
        }).catch(err => {
            console.error('[Player] Failed to register audio event listener:', err);
        });
    }
    // start/stop dead-reckoning ticker and thumbar based on playback state
    // must subscribe to both isPlaying and activeBackend. if the backend switches
    // while already playing isPlaying never
    // changes so the isPlaying subscriber alone would never re-evaluate which ticker to run
    // activeBackend changing while playing is the trigger that needs to stop the old ticker and start the correct new one.
    function _syncTickers(playing: boolean, backend: ActiveBackend): void {
        updateWindowsThumbarState(playing).catch(() => { });

        if (playing && backend === 'native') {
            _startReckoning(get(currentTime));
        } else {
            _stopReckoning();
        }

        if (playing && backend === 'html5') {
            _startHtml5Ticker();
        } else {
            _stopHtml5Ticker();
        }
    }

    isPlaying.subscribe((playing) => {
        _syncTickers(playing, get(activeBackend));
        pluginEvents.emit('playStateChange', { isPlaying: playing });
    });

    activeBackend.subscribe((backend) => {
        _syncTickers(get(isPlaying), backend);
    });

    // Subscribe to volume changes to keep backends in sync
    volume.subscribe((val) => {
        const audioVol = sliderToAudioVolume(val);

        // Update HTML5 backend
        html5SetVolume(audioVol);

        // Update Native backend
        if (nativeAudioUsed) {
            nativeAudioSetVolume(audioVol).catch(err => {
                console.warn('[Player] Failed to set native volume:', err);
            });
        }
    });

    // Force sync initial volume to native backend
    if (nativeAudioUsed) {
        nativeAudioSetVolume(sliderToAudioVolume(get(volume))).catch(err => {
            console.warn('[Player] Failed to set initial native volume:', err);
        });
    }

    if (nativeAudioUsed) {
        try {
            const state = equalizer.getState();
            nativeAudioSetRepeatOne(get(repeat) === 'one').catch(console.error);
            await nativeAudioSetEq(state);
            nativeAudioSetReplayGainEnabled(get(appSettings).replayGainEnabled).catch(console.error);
            console.log('[Player] Applied initial EQ settings to native backend');
        } catch (err) {
            console.warn('[Player] Failed to apply initial EQ settings:', err);
        }

        const savedDevice = get(appSettings).outputDevice;
        if (savedDevice) {
            nativeAudioSetOutputDevice(savedDevice).catch(err =>
                console.warn('[Player] Failed to restore output device:', err)
            );
        }
    }

    // =============================================================================
    // TRAY TOGGLE SYNC
    // keep the tray shuffle/repeat checkmarks in sync with the store values.
    // same debounce-free pattern used by the volume subscriber above —
    // the invoke is best-effort (non-fatal) so desktop-only; no-ops on mobile.
    // =============================================================================
    shuffle.subscribe((val) => {
        invoke('tray_update_toggles', { shuffle: val, repeat: get(repeat) }).catch(() => { });
    });
    repeat.subscribe((val) => {
        invoke('tray_update_toggles', { shuffle: get(shuffle), repeat: val }).catch(() => { });
    });

    // tray://toggle-shuffle / tray://toggle-repeat are emitted by the tray
    // on_menu_event when the user clicks the checkboxes. route them through
    // the same functions the keyboard shortcuts and remote commands already use,
    // so all state transitions happen in one place.
    listen<void>('tray://toggle-shuffle', () => {
        toggleShuffle();
    }).catch(() => { });

    listen<void>('tray://toggle-repeat', () => {
        // cycle none -> all -> one -> none, matching the in-app repeat button
        const current = get(repeat);
        const next = current === 'none' ? 'all' : current === 'all' ? 'one' : 'none';
        repeat.set(next);
        if (get(activeBackend) === 'native') {
            nativeAudioSetRepeatOne(next === 'one').catch(console.error);
        }
    }).catch(() => { });

    // emitted when the user clicks the track title in the tray menu
    // (lib.rs already focuses the window before emitting this)
    listen<void>('tray://open-fullscreen', () => {
        if (!get(isFullScreen)) {
            toggleFullScreen();
        }
    }).catch(() => { });

    // Subscribe to WebSocket messages
    wsStore.onMessage((type, payload) => {
        switch (type) {
            case 'transfer_playback':
                transferPlayback(payload);
                break;
            case 'remote_command':
                handleRemoteCommand(payload);
                break;
            case 'player_state':
                handleRemotePlayerState(payload);
                break;
        }
    });



    await initWindowsThumbarIntegration();
    await initSmtcIntegration();
}

function handleRemotePlayerState(payload: any) {
    const isLocalPlaying = get(isPlaying) && get(activeBackend) !== 'remote';

    if (!isLocalPlaying && payload.isPlaying && payload.deviceId) {
        if (get(activeBackend) !== 'remote') {
            activeBackend.set('remote');
            activeRemoteDevice.set(payload.deviceId);
            console.log(`[Player] Auto-switched to remote session for device: ${payload.deviceId}`);
        }
    }

    if (get(activeBackend) === 'remote' && get(activeRemoteDevice) === payload.deviceId) {
        if (payload.track) {
            const remoteTrack = payload.track;
            const currentObj = get(currentTrack);
            const remoteTrackId = Number(remoteTrack.id);

            if (!currentObj || Number(currentObj.id) !== remoteTrackId) {
                let localTrack: any = getTrackByIdSync(remoteTrackId);

                if (!localTrack) {
                    const $library = get(libraryTracks);
                    localTrack = $library.find(t =>
                        t.title === remoteTrack.title &&
                        t.artist === remoteTrack.artist
                    );
                }

                currentTrack.set({
                    ...remoteTrack,
                    ...(localTrack || {}),
                    id: remoteTrackId,
                    track_cover: localTrack ? getTrackCoverSrc(localTrack) : remoteTrack.coverUrl,
                } as any);
            }
        } else {
            if (get(currentTrack) !== null) currentTrack.set(null);
        }

        if (get(isPlaying) !== payload.isPlaying) isPlaying.set(payload.isPlaying);

        const currentT = get(currentTime);
        if (Math.abs(currentT - payload.currentTime) > 0.25 || payload.isPlaying === false) {
            currentTime.set(payload.currentTime);
        }

        if (get(duration) !== payload.duration) duration.set(payload.duration);

        if (payload.volume !== undefined && get(volume) !== payload.volume) volume.set(payload.volume);
        if (payload.shuffle !== undefined && get(shuffle) !== payload.shuffle) shuffle.set(payload.shuffle);
        if (payload.repeat !== undefined && get(repeat) !== payload.repeat) repeat.set(payload.repeat);
    }
}

let lastBroadcast = 0;
function broadcastState(force = false) {
    if (get(activeBackend) === 'remote') return;

    const now = Date.now();
    if (!force && now - lastBroadcast < 2000) return;

    const track = get(currentTrack);
    const playing = get(isPlaying);
    const pos = get(currentTime);
    const dur = get(duration);

    if (track || lastBroadcast === 0) {
        wsStore.send('player_state', {
            track: track ? {
                id: track.id,
                title: track.title,
                artist: track.artist,
                album: track.album,
                coverUrl: getTrackCoverSrc(track)
            } : null,
            isPlaying: playing,
            currentTime: pos,
            duration: dur,
            volume: get(volume),
            shuffle: get(shuffle),
            repeat: get(repeat)
        });
        lastBroadcast = now;
    }
}

export function cleanupPlayer(): void {
    console.log('[Player] Cleaning up player resources');
    _stopReckoning();
    _stopHtml5Ticker();
    nativeAudioStop().catch(console.error);

    // Cleanup HTML5 backend (audio element + dash + EQ graph)
    html5Cleanup();

    // Reset stores
    activeBackend.set('none');
    isPlaying.set(false);
    currentTrack.set(null);
    currentTime.set(0);
    duration.set(0);

    updateMediaSessionPlaybackState('none');
    updateSmtcPlaybackState('none');
    _unlistenSmtc?.();
    _unlistenSmtc = null;
    smtcInitialized = false;
    if ('mediaSession' in navigator) {
        try { navigator.mediaSession.metadata = null; } catch (_) { /* ignore */ }
    }
}

export function shutdownPlayer(): void {
    cleanupPlayer();
}

// ── Media Session API ──

let mediaSessionInitialized = false;
let windowsThumbarInitialized = false;

async function initWindowsThumbarIntegration(): Promise<void> {
    if (windowsThumbarInitialized) return;

    try {
        const initialized = await initWindowsThumbar();
        if (!initialized) return;

        await listen<{ action?: string }>('windows://thumbar-action', ({ payload }) => {
            const action = payload?.action;
            if (!action) return;

            switch (action) {
                case 'previous':
                    void previousTrack();
                    break;
                case 'toggle_play_pause':
                    void togglePlay();
                    break;
                case 'next':
                    nextTrack();
                    break;
            }
        });

        windowsThumbarInitialized = true;
        await updateWindowsThumbarState(get(isPlaying));

        // queue and queuindex stores are subscribed so the list updates when the track changes or
        // when tracks are added/removed from the queue
        const syncJumpList = () => {
            const $queue = get(queue);
            const currentIdx = get(queueIndex);
            const nextItems = $queue
                .slice(currentIdx + 1, currentIdx + 6)
                .map((t) => ({
                    track_id: t.id,
                    title: t.title ?? 'Unknown Title',
                    artist: t.artist ?? null,
                    path: t.path,
                }));
            if (nextItems.length > 0) {
                invoke('windows_update_jump_list', { tracks: nextItems })
                    .then(() => console.log('[JumpList] Updated with', nextItems))
                    .catch((e) => console.error('[JumpList] update failed:', e));
            } else {
                invoke('windows_clear_jump_list')
                    .then(() => console.log('[JumpList] Cleared'))
                    .catch((e) => console.error('[JumpList] clear failed:', e));
            }
        };
        queue.subscribe(syncJumpList);
        queueIndex.subscribe(syncJumpList);

        // listen for audion://play/<id> deep links routed from lib.rs
        await listen<string>('app://play-track', ({ payload }) => {
            const trackId = Number(payload);
            if (!trackId || isNaN(trackId)) return;
            const track = getTrackByIdSync(trackId);
            if (track) {
                void playTrack(track);
            } else {
                console.warn('[Player] jump list play-track: id not found in library:', trackId);
            }
        });

        console.log('[Player] Windows taskbar thumbar initialized');
    } catch (err) {
        console.warn('[Player] Windows thumbar init failed:', err);
    }
}

function initMediaSessionHandlers(): void {
    if (mediaSessionInitialized || !('mediaSession' in navigator)) return;

    const ms = navigator.mediaSession;

    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
        try {
            ms.setActionHandler(action, handler);
        } catch (err) {
            console.debug(`[MediaSession] Action not supported: ${action}`, err);
        }
    };

    setHandler('play', () => { void resume(); });
    setHandler('pause', () => { void pause(); });
    setHandler('stop', () => { void pause(); });
    setHandler('previoustrack', () => { void previousTrack(); });
    setHandler('nexttrack', () => { void nextTrack(); });
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

async function updateMediaSessionMetadata(track: Track): Promise<void> {
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

function updateMediaSessionPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.playbackState = state;
    } catch (err) {
        // Ignore — some environments don't support playbackState setter
    }
}

function updateMediaSessionPosition(): void {
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

// SMTC (Windows/Linux/macOS native os media controls, via souvlaki)
// driven purely by the same call sites that already
// keep MediaSession in sync, so backend independent

let smtcInitialized = false;
let _unlistenSmtc: (() => void) | null = null;

async function initSmtcIntegration(): Promise<void> {
    if (smtcInitialized) return;

    try {
        _unlistenSmtc = await listen<{ type: string; data?: any }>('smtc://event', ({ payload }) => {
            switch (payload.type) {
                case 'Play':
                    void resume();
                    break;
                case 'Pause':
                    void pause();
                    break;
                case 'Toggle':
                    void togglePlay();
                    break;
                case 'Next':
                    nextTrack();
                    break;
                case 'Previous':
                    void previousTrack();
                    break;
                case 'Stop':
                    void pause();
                    break;
                case 'SeekForward':
                    _smtcSeekRelative(10);
                    break;
                case 'SeekBackward':
                    _smtcSeekRelative(-10);
                    break;
                case 'SeekByForward':
                    _smtcSeekRelative(payload.data.secs);
                    break;
                case 'SeekByBackward':
                    _smtcSeekRelative(-payload.data.secs);
                    break;
                case 'SetPosition': {
                    const dur = get(duration);
                    if (dur > 0) void seek(payload.data.secs / dur);
                    break;
                }
                case 'SetVolume':
                    void _smtcApplyVolume(payload.data.level);
                    break;
            }
        });
        smtcInitialized = true;
        console.log('[Player] SMTC integration initialized');
    } catch (err) {
        console.warn('[Player] SMTC init failed:', err);
    }
}

function _smtcSeekRelative(deltaSecs: number): void {
    const dur = get(duration);
    if (dur <= 0) return;
    const targetSecs = Math.max(0, Math.min(dur, get(currentTime) + deltaSecs));
    void seek(targetSecs / dur);
}

// MPRIS only: the desktop's own volume slider for this player was moved
// apply it the same way the in-app slider would, then ack back to souvlaki
// (smtc_set_volume)
// refer to SmtcEvent::SetVolume doc comment in smtc.rs for why the ack matters
async function _smtcApplyVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, level));
    await setVolume(clamped); // updates the volume store the ui slider reads from
    try {
        await invoke('smtc_set_volume', { level: clamped });
    } catch (err) {
        console.debug('[SMTC] set_volume ack failed:', err);
    }
}

export async function updateSmtcMetadata(track: Track): Promise<void> {
    // raw source only => never a webview asset:// URL here. smtc.rs does the
    // platform specific file:// / percent-encoding conversion on its side
    const rawCover = track.track_cover_path || track.cover_url || null;
    try {
        await invoke('smtc_set_metadata', {
            title: track.title || 'Unknown Title',
            artist: track.artist || 'Unknown Artist',
            album: track.album || null,
            durationSecs: get(duration) || null,
            coverUrl: rawCover,
        });
    } catch (err) {
        console.error('[SMTC] set_metadata failed:', err);
    }
    // keep tray now playing labels in sync
    invoke('tray_update_playback', {
        isPlaying: get(isPlaying),
        title: track.title || 'Unknown Title',
        artist: track.artist || 'Unknown Artist',
    }).catch(() => { });
}

// WINDOWS ONLY.windows taskbar icon progress overlay. value is 0-1 fraction played;
// is_paused swaps the green fill for the yellowish paused color
function _pushTaskbarProgress(): void {
    const dur = get(duration);
    const cur = get(currentTime);
    const value = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
    invoke('windows_set_taskbar_progress', { value, isPaused: !get(isPlaying) }).catch(() => { });
}

let _taskbarProgressInterval: ReturnType<typeof setInterval> | null = null;

function _startTaskbarProgressInterval(): void {
    if (_taskbarProgressInterval !== null) return;
    _taskbarProgressInterval = setInterval(_pushTaskbarProgress, 1000);
}

export function updateSmtcPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    invoke('smtc_set_playback', {
        status: state === 'none' ? 'stopped' : state,
        positionSecs: get(currentTime),
    }).catch(() => { /* no-op if SMTC unavailable, e.g. init failed on this platform */ });
    // keep tray play/pause label in sync
    // title/artist are set by updateSmtcMetadata
    invoke('tray_update_playback', {
        isPlaying: state === 'playing',
        title: null,
        artist: null,
    }).catch(() => { });

    // taskbar icon progress overlay
    if (state === 'none') {
        invoke('windows_clear_taskbar_progress', {}).catch(() => { });
    } else {
        _pushTaskbarProgress();
        _startTaskbarProgressInterval();
    }
}

// Play a specific track
export async function playTrack(track: Track, skipLocalSrc = false, startTime = 0): Promise<void> {
    const previousTrackObj = get(currentTrack);
    const sessionId = ++currentSessionId;

    // Record play for the previous track (if any)
    if (previousTrackObj && playStartTime > 0) {
        const durationPlayed = Math.floor((Date.now() - playStartTime) / 1000);
        if (durationPlayed > 5) {
            recordTrackPlay(previousTrackObj.id, previousTrackObj.album_id ?? null, durationPlayed);
            const trackDuration = previousTrackObj.duration ?? 0;
            if (get(appSettings).listenBrainzEnabled && trackDuration > 0) {
                const threshold = Math.min(Math.floor(trackDuration / 2), 240);
                if (durationPlayed >= threshold) {
                    submitListenbrainzListen(
                        previousTrackObj.artist ?? 'Unknown Artist',
                        previousTrackObj.title ?? 'Unknown',
                        previousTrackObj.album,
                        previousTrackObj.duration,
                        false,
                    ).catch(e => console.warn('[ListenBrainz] Scrobble failed:', e));
                }
            }
        }
    }
    playStartTime = Date.now();

    if (get(appSettings).listenBrainzEnabled) {
        submitListenbrainzListen(
            track.artist ?? 'Unknown Artist',
            track.title ?? 'Unknown',
            track.album,
            track.duration,
            true,
        ).catch(e => console.warn('[ListenBrainz] Now-playing failed:', e));
    }

    const fullTrack = await getFullTrack(track.id, true);

    if (sessionId !== currentSessionId) return;

    const trackForPlugins = fullTrack || track;
    pluginEvents.emit('trackChange', { track: trackForPlugins, previousTrack: previousTrackObj });

    console.log('[Player] Preparing MediaSession metadata for:', trackForPlugins.title);
    await updateMediaSessionMetadata(trackForPlugins);
    await updateSmtcMetadata(trackForPlugins);

    if (!track.track_cover_path && !track.cover_url) {
        fetchTrackCover(track).then(async (newCoverUrl) => {
            if (newCoverUrl) {
                console.log(`[Player] Auto-fetched cover for "${track.title}": ${newCoverUrl}`);

                try {
                    await invoke('update_track_cover_url', { trackId: track.id, coverUrl: newCoverUrl });
                } catch (e) {
                    console.error('[Player] Failed to persist fetched cover to database:', e);
                }

                updateTrackCover(track.id, newCoverUrl);

                const current = get(currentTrack);
                if (current && current.id === track.id) {
                    currentTrack.update(t => t ? { ...t, cover_url: newCoverUrl } : t);
                    updateMediaSessionMetadata({ ...track, cover_url: newCoverUrl }).catch(() => { });
                    updateSmtcMetadata({ ...track, cover_url: newCoverUrl }).catch(() => { });
                }
            }
        }).catch(err => {
            console.error('[Player] Failed to auto-fetch cover:', err);
        });
    }

    if (sessionId !== currentSessionId) {
        console.log('[Player] Session changed during metadata update, aborting playback');
        return;
    }

    try {
        let audioPath = track.local_src || track.path;

        // Resolve server tracks before checking/preparing backends
        if (track.source_type === 'server' && !track.local_src) {
            if (get(appSettings).streamServerTracks) {
                try {
                    audioPath = await audioGetStreamUrl(audioPath, track.id);
                } catch (err) {
                    console.error('[Player] Failed to get server stream URL:', err);
                    throw new Error(`Failed to get stream URL from server: ${err instanceof Error ? err.message : String(err)}`);
                }
            } else {
                if (nativeAudioUsed) {
                    try {
                        audioPath = await audioResolvePath(audioPath, track.id);
                        track.local_src = audioPath;
                    } catch (err) {
                        console.error('[Player] Failed to resolve server track path:', err);
                        throw new Error(`Failed to download/resolve track from server: ${err instanceof Error ? err.message : String(err)}`);
                    }
                } else {
                    try {
                        audioPath = await audioGetStreamUrl(audioPath, track.id);
                    } catch (err) {
                        console.error('[Player] Failed to get server stream URL:', err);
                        throw new Error(`Failed to get stream URL from server: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        }

        if (!audioPath && (track as any).stream_url) {
            audioPath = (track as any).stream_url;
        }

        if (!audioPath && track.external_id && (track.external_id.startsWith('http://') || track.external_id.startsWith('https://'))) {
            audioPath = track.external_id;
        }

        const streaming = isStreaming(track) || !!(track as any).stream_url || audioPath.startsWith('http://') || audioPath.startsWith('https://');

        let swapped = false;
        if (startTime === 0) {
            swapped = await html5SwapPreload(track.id, sliderToAudioVolume(get(volume)));
        }

        if (swapped) {
            activeBackend.set('html5');
            console.log('[Player] HTML5 swapped from preload:', track.title);
            _scheduleHtml5Preload();
        } else {
            if (streaming) {
                if (!audioPath) {
                    throw new Error('No audio path or stream URL found for track');
                }

                await nativeAudioStop().catch(() => { });

                if (classifyAudioPath(audioPath) === 'custom-scheme') {
                    const runtime = pluginStore.getRuntime();
                    if (runtime) {
                        const sourceType = track.source_type;
                        const externalId = track.external_id;
                        if (sourceType && externalId) {
                            console.log(`[Player] Resolving custom scheme: ${audioPath}`);
                            const resolved = await runtime.resolveStreamUrl(sourceType, externalId, { track: trackForPlugins });
                            if (resolved) {
                                audioPath = resolved;
                            } else {
                                throw new Error(`Failed to resolve stream URL for ${sourceType}`);
                            }
                        }
                    }
                }

                activeBackend.set('html5');
                await html5Play(audioPath, sliderToAudioVolume(get(volume)), startTime);
                console.log('[Player] HTML5 streaming started:', track.title);
                _scheduleHtml5Preload();

            } else {
                if (!audioPath) {
                    throw new Error('No local audio path found for track');
                }

                if (nativeAudioUsed) {
                    html5Stop();

                    console.log('[Player] Invoking nativeAudioPlay');
                    console.log('[Player] audioPath:', audioPath);
                    console.log('[Player] track.id:', track.id);
                    console.log('[Player] track.source_type:', (track as any).source_type);
                    console.log('[Player] track.local_src:', (track as any).local_src);
                    console.log('[Player] track.path:', track.path);

                    try {
                        await nativeAudioPlay(audioPath, track.id, (track as any).replay_gain_db ?? null);
                        console.log('[Player] nativeAudioPlay resolved OK');
                    } catch (nativeErr) {
                        console.error('[Player] nativeAudioPlay rejected:', nativeErr);
                        console.error('[Player] nativeAudioPlay error type:', typeof nativeErr);
                        console.error('[Player] nativeAudioPlay error JSON:', JSON.stringify(nativeErr));
                        throw nativeErr;
                    }

                    const vol = sliderToAudioVolume(get(volume));
                    await nativeAudioSetVolume(vol);

                    if (startTime > 0 && track.duration) {
                        await nativeAudioSeek(startTime / track.duration);
                    }

                    _schedulePreload();
                    activeBackend.set('native');
                    console.log('[Player] Native playback started:', track.title);
                } else {
                    activeBackend.set('html5');
                    await html5Play(convertFileSrc(audioPath), sliderToAudioVolume(get(volume)), startTime);
                    console.log('[Player] Local playback started via HTML5:', track.title);
                    _scheduleHtml5Preload();
                }
            }
        }

        _hasCrossfaded = false;
        currentTrack.set(trackForPlugins);
        currentTime.set(startTime);
        duration.set(track.duration || 0);
        isPlaying.set(true);

        if (get(activeBackend) === 'native') {
            _startReckoning(startTime);
        }

        updateMediaSessionPlaybackState('playing');
        updateMediaSessionPosition();
        updateSmtcPlaybackState('playing');
        broadcastState(true);

    } catch (err) {
        console.error('[Player] Playback failed:', err);
        console.error('[Player] Playback failed type:', typeof err);
        console.error('[Player] Playback failed JSON:', JSON.stringify(err));
        addToast(`Playback failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}


// Shuffled Queue State
export const shuffledIndices = writable<number[]>([]);
export const shuffledIndex = writable<number>(0);

function shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export function playTracks(
    tracks: Track[],
    startIndex: number = 0,
    context?: PlaybackContext
): void {
    const currentQueue = get(queue);

    let isSameQueue = false;

    if (tracks.length === currentQueue.length) {
        if (tracks.length === 0) {
            isSameQueue = true;
        } else {
            if (tracks[0].id === currentQueue[0].id &&
                tracks[tracks.length - 1].id === currentQueue[currentQueue.length - 1].id) {
                isSameQueue = tracks.every((t, i) => t.id === currentQueue[i].id);
            }
        }
    }

    if (!isSameQueue) {
        queue.set(tracks);
    }

    queueIndex.set(startIndex);
    userQueueCount.set(0);

    playbackContext.set(context ?? null);

    if (get(shuffle)) {
        const allIndices = tracks.map((_, i) => i);
        const otherIndices = allIndices.filter(i => i !== startIndex);
        const shuffledOthers = shuffleArray(otherIndices);
        const newShuffledIndices = [startIndex, ...shuffledOthers];

        console.log(`Regenerating shuffle with forced start: ${startIndex}`);
        shuffledIndices.set(newShuffledIndices);
        shuffledIndex.set(0);
    }

    pluginEvents.emit('queueChange', { queue: tracks, index: startIndex });

    if (tracks.length > 0 && startIndex < tracks.length) {
        playTrack(tracks[startIndex]);
    }
}

export async function togglePlay(): Promise<void> {
    if (get(isPlaying)) {
        await pause();
    } else {
        await resume();
    }
}

export async function pause(): Promise<void> {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            sendRemoteCommand(targetId, 'pause');
        }
        return;
    }

    try {
        if (get(activeBackend) === 'html5') {
            html5Pause();
        } else if (get(activeBackend) === 'native') {
            await nativeAudioPause();
            _stopReckoning(get(currentTime));
        }
        isPlaying.set(false);
        updateMediaSessionPlaybackState('paused');
        updateSmtcPlaybackState('paused');
        broadcastState(true);
    } catch (err) {
        console.error('[Player] Pause failed:', err);
    }
}

export async function resume(): Promise<void> {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            sendRemoteCommand(targetId, 'resume');
        }
        return;
    }

    try {
        const track = get(currentTrack);
        if (!track) return;

        if (get(currentTime) >= get(duration) && get(duration) > 0) {
            await playTrack(track);
        } else if (get(activeBackend) === 'none') {
            await playTrack(track, false, get(currentTime));
        } else if (get(activeBackend) === 'html5') {
            await html5Resume();
            isPlaying.set(true);
            updateMediaSessionPlaybackState('playing');
        } else if (get(activeBackend) === 'native') {
            await nativeAudioResume();
            isPlaying.set(true);
            updateMediaSessionPlaybackState('playing');
            _startReckoning(_reckoningOffset);
        }
        updateSmtcPlaybackState('playing');
        updateMediaSessionPosition();
        broadcastState(true);
    } catch (err) {
        console.error('[Player] Resume failed:', err);
    }
}

// =============================================================================
// QUEUE INDEX HELPERS
// =============================================================================

function _advanceQueueIndex(dry = false): number | null {
    const q = get(queue);
    const rep = get(repeat);
    const shuf = get(shuffle);
    const userCount = get(userQueueCount);
    const settings = get(appSettings);
    let idx = get(queueIndex);

    if (q.length === 0) return null;

    if (userCount > 0) {
        idx = idx + 1;
        if (!dry) userQueueCount.update(c => Math.max(0, c - 1));

    } else if (shuf) {
        const shufIndices = get(shuffledIndices);
        let shufIdx = get(shuffledIndex) + 1;

        if (shufIdx >= shufIndices.length) {
            if (rep === 'all') {
                shufIdx = 0;
            } else {
                return null;
            }
        }

        if (!dry) shuffledIndex.set(shufIdx);
        idx = shufIndices[shufIdx];
    } else {
        idx = idx + 1;

        if (idx >= q.length) {
            if (rep === 'all') {
                idx = 0;
            } else {
                return null;
            }
        }
    }

    return idx;
}

export function nextTrack(): void {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            sendRemoteCommand(targetId, 'next');
        }
        return;
    }

    const q = get(queue);
    const settings = get(appSettings);

    if (q.length === 0) {
        if (settings.autoplay) playRandomFromLibrary();
        return;
    }

    const idx = _advanceQueueIndex();

    if (idx === null) {
        if (settings.autoplay) {
            playRandomFromLibrary();
        } else {
            isPlaying.set(false);
        }
        return;
    }

    queueIndex.set(idx);
    playTrack(q[idx]);
}

function playRandomFromLibrary(): void {
    const allTracks = get(libraryTracks);
    if (allTracks.length === 0) {
        isPlaying.set(false);
        return;
    }

    const current = get(currentTrack);
    let availableTracks = allTracks;

    if (current && allTracks.length > 1) {
        availableTracks = allTracks.filter(t => t.id !== current.id);
    }

    const randomIndex = Math.floor(Math.random() * availableTracks.length);
    const randomTrack = availableTracks[randomIndex];

    queue.update(q => [...q, randomTrack]);
    const newQueue = get(queue);
    queueIndex.set(newQueue.length - 1);

    playTrack(randomTrack);
}

export async function previousTrack(): Promise<void> {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            sendRemoteCommand(targetId, 'previous');
        }
        return;
    }

    const q = get(queue);
    const shuf = get(shuffle);
    let idx = get(queueIndex);

    if (q.length === 0) return;

    try {
        let pos = get(currentTime);

        if (pos > 3) {
            if (get(activeBackend) === 'html5') {
                html5Seek(0); // ratio 0 = start of track; semantically correct despite the ratio API
            } else if (get(activeBackend) === 'native') {
                await nativeAudioSeek(0);
            }
            return;
        }
    } catch (err) {
        console.error('[Player] Restart track failed:', err);
    }

    if (shuf) {
        const shufIndices = get(shuffledIndices);
        let shufIdx = get(shuffledIndex);

        shufIdx = shufIdx - 1;
        if (shufIdx < 0) {
            shufIdx = get(repeat) === 'all' ? shufIndices.length - 1 : 0;
        }

        shuffledIndex.set(shufIdx);
        idx = shufIndices[shufIdx];
    } else {
        idx = idx - 1;
        if (idx < 0) {
            idx = get(repeat) === 'all' ? q.length - 1 : 0;
        }
    }

    queueIndex.set(idx);
    playTrack(q[idx]);
}

export async function seek(position: number): Promise<void> {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            throttledRemoteCommand(targetId, 'seek', { position }, 100);
        }
        return;
    }

    try {
        const dur = get(duration);
        const targetSecs = position * dur;
        let didSeek = false;

        if (get(activeBackend) === 'html5') {
            html5Seek(position);
            didSeek = true;
        } else if (get(activeBackend) === 'native') {
            await nativeAudioSeek(position);
            // immediately snap reckoning to the target
            // backend confirms the actual keyframe position via StateChanged after this
            if (get(isPlaying)) {
                _startReckoning(targetSecs);
            } else {
                _stopReckoning(targetSecs);
                currentTime.set(targetSecs);
            }
            didSeek = true;
        }

        if (didSeek) {
            updateMediaSessionPosition();
            updateSmtcPlaybackState(get(isPlaying) ? 'playing' : 'paused');
            broadcastState(true);
            pluginEvents.emit('seeked', { currentTime: targetSecs, duration: dur });
        }
    } catch (err) {
        console.error('[Player] Seek failed:', err);
    }
}

export async function setVolume(sliderValue: number): Promise<void> {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            throttledRemoteCommand(targetId, 'volume', { volume: sliderValue }, 100);
        }
        return;
    }

    volume.set(sliderValue);
    const vol = sliderToAudioVolume(sliderValue);

    try {
        html5SetVolume(vol);
        if (nativeAudioUsed) {
            await nativeAudioSetVolume(vol);
        }
    } catch (err) {
        console.error('[Player] Volume set failed:', err);
    }
    broadcastState(true);
}

export function toggleShuffle(): void {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            sendRemoteCommand(targetId, 'shuffle', { shuffle: !get(shuffle) });
        }
        return;
    }

    shuffle.update(s => {
        const newState = !s;

        if (newState) {
            const q = get(queue);
            const currentIdx = get(queueIndex);
            const indices = q.map((_, i) => i);
            const shuffled = shuffleArray(indices);

            console.log('Regenerating shuffle in toggleShuffle');
            shuffledIndices.set(shuffled);

            const ptr = shuffled.indexOf(currentIdx);
            shuffledIndex.set(ptr !== -1 ? ptr : 0);
        }

        return newState;
    });
    broadcastState(true);
}

export function cycleRepeat(): void {
    if (get(activeBackend) === 'remote') {
        const targetId = get(activeRemoteDevice);
        if (targetId) {
            const r = get(repeat);
            const next = r === 'none' ? 'all' : r === 'all' ? 'one' : 'none';
            sendRemoteCommand(targetId, 'repeat', { repeat: next });
        }
        return;
    }

    repeat.update(r => {
        const next = r === 'none' ? 'all' : r === 'all' ? 'one' : 'none';
        if (get(activeBackend) === 'native') {
            nativeAudioSetRepeatOne(next === 'one').catch(console.error);
        }
        return next;
    });
    broadcastState(true);
}

function handleTrackEnd(): void {
    const track = get(currentTrack);
    if (track && playStartTime > 0) {
        const durationPlayed = Math.floor((Date.now() - playStartTime) / 1000);
        if (durationPlayed > 5) {
            recordTrackPlay(track.id, track.album_id ?? null, durationPlayed);
            const trackDuration = track.duration ?? 0;
            if (get(appSettings).listenBrainzEnabled && trackDuration > 0) {
                const threshold = Math.min(Math.floor(trackDuration / 2), 240);
                if (durationPlayed >= threshold) {
                    submitListenbrainzListen(
                        track.artist ?? 'Unknown Artist',
                        track.title ?? 'Unknown',
                        track.album,
                        track.duration,
                        false,
                    ).catch(e => console.warn('[ListenBrainz] Scrobble failed:', e));
                }
            }
        }
        playStartTime = 0;
    }

    if (get(repeat) === 'one' && track) {
        console.log('[Player] Repeat one: restarting current track');
        playTrack(track).catch(console.error);
        return;
    }

    nextTrack();
}

function handleGaplessAdvance(): void {
    const q = get(queue);

    const prevTrack = get(currentTrack);
    if (prevTrack && playStartTime > 0) {
        const durationPlayed = Math.floor((Date.now() - playStartTime) / 1000);
        if (durationPlayed > 5) {
            recordTrackPlay(prevTrack.id, prevTrack.album_id ?? null, durationPlayed);
            const trackDuration = prevTrack.duration ?? 0;
            if (get(appSettings).listenBrainzEnabled && trackDuration > 0) {
                const threshold = Math.min(Math.floor(trackDuration / 2), 240);
                if (durationPlayed >= threshold) {
                    submitListenbrainzListen(
                        prevTrack.artist ?? 'Unknown Artist',
                        prevTrack.title ?? 'Unknown',
                        prevTrack.album,
                        prevTrack.duration,
                        false,
                    ).catch(e => console.warn('[ListenBrainz] Scrobble failed:', e));
                }
            }
        }
    }
    playStartTime = Date.now();

    const idx = _advanceQueueIndex();
    if (idx === null) {
        handleTrackEnd();
        return;
    }

    queueIndex.set(idx);
    const nextTrackObj = q[idx];
    if (!nextTrackObj) return;

    _advanceUiToTrack(nextTrackObj);
}

async function _advanceUiToTrack(track: Track): Promise<void> {
    const previousTrackObj = get(currentTrack);

    const fullTrack = await getFullTrack(track.id, true);
    const trackForPlugins = fullTrack || track;

    _hasCrossfaded = false;
    currentTrack.set(trackForPlugins);
    currentTime.set(0);
    duration.set(track.duration || 0);
    isPlaying.set(true);

    if (get(activeBackend) === 'native') {
        _startReckoning(0);
    }

    pluginEvents.emit('trackChange', { track: trackForPlugins, previousTrack: previousTrackObj });
    pluginEvents.emit('queueChange', { queue: get(queue), index: get(queueIndex) });

    await updateMediaSessionMetadata(trackForPlugins);
    updateMediaSessionPlaybackState('playing');
    updateMediaSessionPosition();
    await updateSmtcMetadata(trackForPlugins);
    updateSmtcPlaybackState('playing');
    broadcastState(true);

    _schedulePreload();
    _scheduleHtml5Preload();

    if (get(appSettings).listenBrainzEnabled) {
        submitListenbrainzListen(
            track.artist ?? 'Unknown Artist',
            track.title ?? 'Unknown',
            track.album,
            track.duration,
            true,
        ).catch(e => console.warn('[ListenBrainz] Now-playing failed:', e));
    }
}

// =============================================================================
// GAPLESS PRELOAD
// =============================================================================

function _schedulePreload(): void {
    if (get(activeBackend) !== 'native') return;

    const q = get(queue);
    const nextIdx = _advanceQueueIndex(true);

    if (nextIdx === null || nextIdx >= q.length) return;

    const nextTrackObj = q[nextIdx];
    if (!nextTrackObj || isStreaming(nextTrackObj)) return;

    const nextPath = nextTrackObj.local_src || nextTrackObj.path;
    if (!nextPath) return;

    nativeAudioPreload(nextPath, nextTrackObj.id, (nextTrackObj as any).replay_gain_db ?? null).catch(e => {
        console.warn('[Player] Preload failed (non-fatal):', e);
    });
}

async function _scheduleHtml5Preload(): Promise<void> {
    if (get(activeBackend) !== 'html5') return;

    const q = get(queue);
    const nextIdx = _advanceQueueIndex(true);

    if (nextIdx === null || nextIdx >= q.length) return;

    const nextTrackObj = q[nextIdx];
    if (!nextTrackObj) return;

    let audioPath = nextTrackObj.local_src || nextTrackObj.path;

    // Resolve server tracks
    if (nextTrackObj.source_type === 'server' && !nextTrackObj.local_src) {
        try {
            audioPath = await audioGetStreamUrl(audioPath, nextTrackObj.id);
        } catch (err) {
            console.error('[Player] Preload path resolution failed:', err);
            return;
        }
    }

    if (!audioPath && (nextTrackObj as any).stream_url) {
        audioPath = (nextTrackObj as any).stream_url;
    }

    if (!audioPath && nextTrackObj.external_id && (nextTrackObj.external_id.startsWith('http://') || nextTrackObj.external_id.startsWith('https://'))) {
        audioPath = nextTrackObj.external_id;
    }

    if (!audioPath) return;

    const streaming = isStreaming(nextTrackObj) || !!(nextTrackObj as any).stream_url || audioPath.startsWith('http://') || audioPath.startsWith('https://');

    if (!streaming) {
        // Next track is a local file, native backend handles its own preload
        return;
    }

    // Resolve custom schemes if any
    const scheme = audioPath.includes('://') ? audioPath.split('://')[0] + '://' : '';
    const isCustomScheme = scheme && scheme !== 'http://' && scheme !== 'https://' && scheme !== 'file://' && scheme !== 'asset://' && scheme !== 'tauri://';

    if (isCustomScheme) {
        const runtime = pluginStore.getRuntime();
        if (runtime) {
            const sourceType = nextTrackObj.source_type;
            const externalId = nextTrackObj.external_id;
            if (sourceType && externalId) {
                try {
                    const fullTrack = await getFullTrack(nextTrackObj.id, true);
                    const trackForPlugins = fullTrack || nextTrackObj;
                    const resolved = await runtime.resolveStreamUrl(sourceType, externalId, { track: trackForPlugins });
                    if (resolved) {
                        audioPath = resolved;
                    }
                } catch (e) {
                    console.error('[Player] Failed to resolve custom scheme for preload:', e);
                }
            }
        }
    }

    console.log('[Player] Preloading next HTML5 track:', nextTrackObj.title, audioPath);
    html5Preload(audioPath, nextTrackObj.id).catch(e => {
        console.warn('[Player] HTML5 Preload failed (non-fatal):', e);
    });
}

// Progress as percentage (0-1)
export const progress = derived(
    [currentTime, duration],
    ([$currentTime, $duration]) => {
        if (!$duration || $duration === 0) return 0;
        return $currentTime / $duration;
    }
);

// Queue management functions

export function addToQueue(tracks: Track[]): void {
    const currentIdx = get(queueIndex);
    const userCount = get(userQueueCount);
    const insertPosition = currentIdx + 1 + userCount;
    const addedCount = tracks.length;

    queue.update(q => {
        const newQueue = [...q];
        newQueue.splice(insertPosition, 0, ...tracks);
        pluginEvents.emit('queueChange', { queue: newQueue, index: currentIdx });
        return newQueue;
    });

    userQueueCount.update(c => c + addedCount);

    if (get(shuffle)) {
        console.log('Updating shuffle in addToQueue');
        shuffledIndices.update(indices => {
            const shifted = indices.map(i => i >= insertPosition ? i + addedCount : i);
            const newIndices = Array.from({ length: addedCount }, (_, i) => insertPosition + i);
            const shuffledNew = shuffleArray(newIndices);
            return [...shifted, ...shuffledNew];
        });
    }
}

export function removeFromQueue(index: number): void {
    const currentIdx = get(queueIndex);

    queue.update(q => {
        const newQueue = [...q];
        newQueue.splice(index, 1);
        return newQueue;
    });

    if (index < currentIdx) {
        queueIndex.update(i => i - 1);
    }

    if (get(shuffle)) {
        shuffledIndices.update(indices => {
            return indices
                .filter(i => i !== index)
                .map(i => i > index ? i - 1 : i);
        });
    }

    if (get(shuffle)) {
        const actualCurrentQIdx = get(queueIndex);
        const sIndices = get(shuffledIndices);
        const ptr = sIndices.indexOf(actualCurrentQIdx);
        if (ptr !== -1) {
            shuffledIndex.set(ptr);
        }
    }
}

export function reorderQueue(fromIndex: number, toIndex: number): void {
    const currentIdx = get(queueIndex);
    const isShuffle = get(shuffle);

    if (fromIndex === toIndex) return;

    const queueBefore = get(queue);
    if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= queueBefore.length ||
        toIndex >= queueBefore.length
    ) {
        return;
    }

    queue.update(q => {
        const newQueue = [...q];
        const [removed] = newQueue.splice(fromIndex, 1);
        newQueue.splice(toIndex, 0, removed);
        return newQueue;
    });

    if (fromIndex === currentIdx) {
        queueIndex.set(toIndex);
    } else if (fromIndex < currentIdx && toIndex >= currentIdx) {
        queueIndex.update(i => i - 1);
    } else if (fromIndex > currentIdx && toIndex <= currentIdx) {
        queueIndex.update(i => i + 1);
    }

    if (isShuffle) {
        shuffledIndices.update(indices => {
            const fromPos = indices.indexOf(fromIndex);
            const toPos = indices.indexOf(toIndex);

            const remapped = indices.map(i => {
                if (i === fromIndex) return toIndex;
                if (fromIndex < toIndex) {
                    if (i > fromIndex && i <= toIndex) return i - 1;
                } else {
                    if (i >= toIndex && i < fromIndex) return i + 1;
                }
                return i;
            });

            if (fromPos !== -1 && toPos !== -1 && fromPos !== toPos) {
                const [moved] = remapped.splice(fromPos, 1);
                remapped.splice(toPos, 0, moved);
            }

            return remapped;
        });

        const currentQueueIdx = get(queueIndex);
        const ptr = get(shuffledIndices).indexOf(currentQueueIdx);
        if (ptr !== -1) {
            shuffledIndex.set(ptr);
        }
    }

    pluginEvents.emit('queueChange', { queue: get(queue), index: get(queueIndex) });
    _schedulePreload();
}

export function clearUpcoming(): void {
    const currentIdx = get(queueIndex);
    queue.update(q => q.slice(0, currentIdx + 1));
    userQueueCount.set(0);

    if (get(shuffle)) {
        shuffledIndices.update(indices => indices.filter(i => i <= currentIdx));
        const ptr = get(shuffledIndices).indexOf(currentIdx);
        shuffledIndex.set(ptr !== -1 ? ptr : 0);
    }
}

export function playFromQueue(index: number): void {
    const q = get(queue);
    const currentIdx = get(queueIndex);
    const userCount = get(userQueueCount);

    if (index >= 0 && index < q.length) {
        const userQueueEnd = currentIdx + 1 + userCount;
        if (index > currentIdx && index <= userQueueEnd) {
            const skipped = index - currentIdx;
            userQueueCount.update(c => Math.max(0, c - skipped));
        } else if (index > userQueueEnd) {
            userQueueCount.set(0);
        }

        queueIndex.set(index);
        playTrack(q[index]);

        if (get(shuffle)) {
            const ptr = get(shuffledIndices).indexOf(index);
            if (ptr !== -1) {
                shuffledIndex.set(ptr);
            }
        }
    }
}

export function isPlaylistPlaying(playlistId: number): boolean {
    const ctx = get(playbackContext);
    return ctx?.type === 'playlist' && ctx.playlistId === playlistId;
}

export function isAlbumPlaying(albumId: number): boolean {
    const ctx = get(playbackContext);
    return ctx?.type === 'album' && ctx.albumId === albumId;
}

export function isArtistPlaying(artistName: string): boolean {
    const ctx = get(playbackContext);
    return ctx?.type === 'artist' && ctx.artistName === artistName;
}

export async function transferPlayback(state: any) {
    if (!state || !state.track) return;

    console.log('[Player] Transferring playback to this device...', state.track.title);

    if (state.deviceId) {
        console.log('[Player] Pausing remote device:', state.deviceId);
        sendRemoteCommand(state.deviceId, 'pause');
    }

    const remoteTrack = state.track;
    let localTrack: any = getTrackByIdSync(Number(remoteTrack.id));

    if (!localTrack) {
        const $library = get(libraryTracks);
        localTrack = $library.find(t =>
            t.title === remoteTrack.title &&
            t.artist === remoteTrack.artist
        );
    }

    if (localTrack) {
        const trackWithLocalCover = {
            ...state.track,
            ...localTrack,
            coverUrl: getTrackCoverSrc(localTrack)
        };

        await playTrack(localTrack, false, state.currentTime);
        if (!state.isPlaying) {
            await pause();
        }
    } else {
        console.warn('[Player] Could not find local track for transfer:', state.track.title);
        addToast(`Cannot transfer: "${state.track.title}" not found in local library`, 'error');
    }
}

export function sendRemoteCommand(targetDeviceId: string, command: string, data?: any) {
    wsStore.send('remote_command', {
        targetDeviceId,
        command,
        data
    });
}

let remoteThrottleTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function throttledRemoteCommand(targetDeviceId: string, command: string, data: any, delay: number) {
    const key = `${targetDeviceId}:${command}`;
    if (remoteThrottleTimers[key]) return;

    sendRemoteCommand(targetDeviceId, command, data);

    remoteThrottleTimers[key] = setTimeout(() => {
        delete remoteThrottleTimers[key];
    }, delay);
}

async function handleRemoteCommand(payload: any) {
    const { command, data } = payload;
    console.log('[Player] Received remote command:', command);

    switch (command) {
        case 'resume':
            await resume();
            break;
        case 'pause':
            await pause();
            break;
        case 'next':
            nextTrack();
            break;
        case 'previous':
            previousTrack();
            break;
        case 'seek':
            if (data?.position != null) {
                seek(data.position);
            }
            break;
        case 'volume':
            if (data?.volume != null) {
                setVolume(data.volume);
            }
            break;
        case 'shuffle':
            if (data?.shuffle != null) {
                if (get(activeBackend) !== 'remote') {
                    if (get(shuffle) !== data.shuffle) toggleShuffle();
                } else {
                    shuffle.set(data.shuffle);
                }
            }
            break;
        case 'repeat':
            if (data?.repeat != null) {
                if (get(activeBackend) !== 'remote') {
                    repeat.set(data.repeat);
                    if (get(activeBackend) === 'native') {
                        nativeAudioSetRepeatOne(data.repeat === 'one').catch(console.error);
                    }
                } else {
                    repeat.set(data.repeat);
                }
            }
            break;
    }
}