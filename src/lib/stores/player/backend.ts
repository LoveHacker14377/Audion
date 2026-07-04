// Backend initialization, cleanup, and ticker orchestration
import { get } from 'svelte/store';
import {
    activeBackend, isPlaying, currentTrack, currentTime, duration, volume,
    shuffle, repeat, queue, queueIndex,
    sliderToAudioVolume, pluginEvents,
} from './stores';
import { appSettings } from '$lib/stores/settings';
import { equalizer } from '$lib/stores/equalizer';
import { addToast } from '$lib/stores/toast';
import { wsStore } from '$lib/stores/websocket';
import { activeRemoteDevice } from '$lib/stores/websocket';
import {
    shouldUseNativeAudio, nativeAudioStop, nativeAudioSetVolume,
    nativeAudioSetEq, nativeAudioSetRepeatOne, nativeAudioSetReplayGainEnabled,
    nativeAudioSetCrossfadeSeconds, nativeAudioSetOutputDevice,
    type AudioEventType,
} from '$lib/services/native-audio';
import {
    html5SetCallbacks, html5Stop, html5Cleanup, html5SetVolume,
} from '$lib/services/html5-audio';
import { listen } from '$lib/api/tauri';
import { updateWindowsThumbarState } from '$lib/api/tauri';
import {
    _startReckoning, _stopReckoning, _correctReckoning,
    _startHtml5Ticker, _stopHtml5Ticker, registerPositionUpdateCallback,
} from './reckoning';
import {
    initWindowsThumbarIntegration, registerMediaSessionActions,
    updateMediaSessionPlaybackState,
} from './media-session';
import {
    handleTrackEnd, handleGaplessAdvance, nextTrack, previousTrack,
    togglePlay, pause, resume, setPlayerNativeAudioUsed,
    getPlayerNativeAudioUsed, incrementPlayerNativeErrorCount,
    PLAYER_NATIVE_ERROR_FALLBACK_THRESHOLD,
} from './playback';
import { handleRemoteCommand, handleRemotePlayerState, transferPlayback } from './remote';
import { registerRemoteCallbacks } from './remote';
import { seek, setVolume, toggleShuffle } from './playback';
import { playTrack } from './playback';
import { updateMediaSessionPosition } from './media-session';

// Wire up media-session action delegates
registerMediaSessionActions(
    () => void previousTrack(),
    () => void togglePlay(),
    () => nextTrack(),
);

// Wire up remote command callbacks
registerRemoteCallbacks({
    resume,
    pause,
    next: nextTrack,
    previous: previousTrack,
    seek,
    setVolume,
    toggleShuffle,
    playTrack,
});

// Wire up position-update slot (used by both reckoning and html5 ticker)
registerPositionUpdateCallback(() => updateMediaSessionPosition());

export async function initAudioBackend(): Promise<void> {
    console.log('[Player] Initializing audio backend');

    // Wire up HTML5 backend callbacks
    html5SetCallbacks({
        onEnded: () => handleTrackEnd(),
        onError: (message) => addToast(`Streaming playback failed: ${message}`, 'error'),
        onTimeUpdate: (position, dur) => {
            if (dur > 0 && !isNaN(dur)) duration.set(dur);
        },
        onPlayStateChange: (playing) => {
            if (get(activeBackend) === 'html5') {
                isPlaying.set(playing);
                updateMediaSessionPlaybackState(playing ? 'playing' : 'paused');
            }
        },
    });

    // Check if we should use native audio
    const nativeUsed = await shouldUseNativeAudio();
    setPlayerNativeAudioUsed(nativeUsed);
    console.log(`[Player] Native audio preferred: ${nativeUsed}`);

    // Register the native audio event listener once
    if (nativeUsed) {
        listen<AudioEventType>('audio://event', ({ payload: event }) => {
            if (event.type === 'TrackFinished') {
                _stopReckoning(get(currentTime));
                handleTrackEnd();
            } else if (event.type === 'TrackAdvanced') {
                _startReckoning(0);
                handleGaplessAdvance();
            } else if (event.type === 'StateChanged') {
                _correctReckoning(event.data.position);
                if (event.data.position === 0) {
                    isPlaying.set(true);
                    updateMediaSessionPlaybackState('playing');
                }
            } else if (event.type === 'DeviceListChanged') {
                console.log('[Player] Device list updated');
            } else if (event.type === 'Error') {
                console.error('[Player] Backend error:', event.data.message);
                const errCount = incrementPlayerNativeErrorCount();
                _stopReckoning(get(currentTime));
                isPlaying.set(false);
                updateMediaSessionPlaybackState('paused');

                if (errCount >= PLAYER_NATIVE_ERROR_FALLBACK_THRESHOLD) {
                    setPlayerNativeAudioUsed(false);
                    activeBackend.set('none');
                    addToast('Native audio failed repeatedly — switched to HTML5 audio', 'warning');
                    console.warn('[Player] Native backend downgraded to HTML5 after repeated errors');
                } else {
                    activeBackend.set('none');
                    addToast(`Audio error: ${event.data.message}`, 'error');
                    const track = get(currentTrack);
                    if (track) {
                        console.warn('[Player] Native error on track, attempting skip to next');
                        nextTrack();
                    }
                }
            }
        }).catch(err => {
            console.error('[Player] Failed to register audio event listener:', err);
        });
    }

    // Sync tickers when play state or backend changes
    function _syncTickers(playing: boolean, backend: typeof activeBackend extends import('svelte/store').Writable<infer T> ? T : never): void {
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

        html5SetVolume(audioVol);

        if (getPlayerNativeAudioUsed()) {
            nativeAudioSetVolume(audioVol).catch(err => {
                console.warn('[Player] Failed to set native volume:', err);
            });
        }
    });

    // Force sync initial volume to native backend
    if (nativeUsed) {
        nativeAudioSetVolume(sliderToAudioVolume(get(volume))).catch(err => {
            console.warn('[Player] Failed to set initial native volume:', err);
        });
    }

    if (nativeUsed) {
        try {
            const state = equalizer.getState();
            nativeAudioSetRepeatOne(get(repeat) === 'one').catch(console.error);
            await nativeAudioSetEq(state);
            nativeAudioSetReplayGainEnabled(get(appSettings).replayGainEnabled).catch(console.error);
            nativeAudioSetCrossfadeSeconds(get(appSettings).crossfadeSeconds).catch(console.error);
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
}

export function cleanupPlayer(): void {
    console.log('[Player] Cleaning up player resources');
    _stopReckoning();
    _stopHtml5Ticker();
    nativeAudioStop().catch(console.error);

    html5Cleanup();

    activeBackend.set('none');
    isPlaying.set(false);
    currentTrack.set(null);
    currentTime.set(0);
    duration.set(0);

    updateMediaSessionPlaybackState('none');
    if ('mediaSession' in navigator) {
        try { navigator.mediaSession.metadata = null; } catch (_) { /* ignore */ }
    }
}

export function shutdownPlayer(): void {
    cleanupPlayer();
}
