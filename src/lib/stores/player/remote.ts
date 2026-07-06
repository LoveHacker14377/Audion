// Remote command sending, throttling, and receiving (WebSocket-based)
import { get } from 'svelte/store';
import { activeBackend, currentTrack, currentTime, duration, isPlaying, shuffle, repeat, volume, queue, queueIndex } from './stores';
// NOTE: activeRemoteDevice re-exported from websocket store via stores.ts would be cleaner,
// but it lives in $lib/stores/websocket — import directly to avoid adding it to stores.ts
import { activeRemoteDevice as _activeRemoteDevice } from '$lib/stores/websocket';
import { wsStore } from '$lib/stores/websocket';
import { getTrackCoverSrc } from '$lib/api/tauri';
import { tracks as libraryTracks, getTrackByIdSync } from '$lib/stores/library';
import type { Track } from '$lib/api/tauri';
import { addToast } from '$lib/stores/toast';

// Forward declarations — filled by backend.ts
let _onResume: () => Promise<void> = async () => {};
let _onPause: () => Promise<void> = async () => {};
let _onNext: () => void = () => {};
let _onPrevious: () => Promise<void> = async () => {};
let _onSeek: (pos: number) => Promise<void> = async () => {};
let _onSetVolume: (v: number) => Promise<void> = async () => {};
let _onToggleShuffle: () => void = () => {};
let _onPlayTrack: (track: Track, skipLocalSrc?: boolean, startTime?: number) => Promise<void> = async () => {};
let _onPause2: () => Promise<void> = async () => {};

export function registerRemoteCallbacks(cbs: {
    resume: () => Promise<void>;
    pause: () => Promise<void>;
    next: () => void;
    previous: () => Promise<void>;
    seek: (pos: number) => Promise<void>;
    setVolume: (v: number) => Promise<void>;
    toggleShuffle: () => void;
    playTrack: (track: Track, skipLocalSrc?: boolean, startTime?: number) => Promise<void>;
}): void {
    _onResume = cbs.resume;
    _onPause = cbs.pause;
    _onNext = cbs.next;
    _onPrevious = cbs.previous;
    _onSeek = cbs.seek;
    _onSetVolume = cbs.setVolume;
    _onToggleShuffle = cbs.toggleShuffle;
    _onPlayTrack = cbs.playTrack;
}

export function sendRemoteCommand(targetDeviceId: string, command: string, data?: any) {
    wsStore.send('remote_command', {
        targetDeviceId,
        command,
        data
    });
}

let remoteThrottleTimers: Record<string, ReturnType<typeof setTimeout>> = {};
export function throttledRemoteCommand(targetDeviceId: string, command: string, data: any, delay: number) {
    const key = `${targetDeviceId}:${command}`;
    if (remoteThrottleTimers[key]) return;

    sendRemoteCommand(targetDeviceId, command, data);

    remoteThrottleTimers[key] = setTimeout(() => {
        delete remoteThrottleTimers[key];
    }, delay);
}

export async function handleRemoteCommand(payload: any) {
    const { command, data } = payload;
    console.log('[Player] Received remote command:', command);

    switch (command) {
        case 'resume':
            await _onResume();
            break;
        case 'pause':
            await _onPause();
            break;
        case 'next':
            _onNext();
            break;
        case 'previous':
            _onPrevious();
            break;
        case 'seek':
            if (data?.position != null) {
                _onSeek(data.position);
            }
            break;
        case 'volume':
            if (data?.volume != null) {
                _onSetVolume(data.volume);
            }
            break;
        case 'shuffle':
            if (data?.shuffle != null) {
                if (get(activeBackend) !== 'remote') {
                    if (get(shuffle) !== data.shuffle) _onToggleShuffle();
                } else {
                    shuffle.set(data.shuffle);
                }
            }
            break;
        case 'repeat':
            if (data?.repeat != null) {
                repeat.set(data.repeat);
            }
            break;
    }
}

export function handleRemotePlayerState(payload: any) {
    const isLocalPlaying = get(isPlaying) && get(activeBackend) !== 'remote';

    if (!isLocalPlaying && payload.isPlaying && payload.deviceId) {
        if (get(activeBackend) !== 'remote') {
            activeBackend.set('remote');
            _activeRemoteDevice.set(payload.deviceId);
            console.log(`[Player] Auto-switched to remote session for device: ${payload.deviceId}`);
        }
    }

    if (get(activeBackend) === 'remote' && get(_activeRemoteDevice) === payload.deviceId) {
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
        await _onPlayTrack(localTrack, false, state.currentTime);
        if (!state.isPlaying) {
            await _onPause();
        }
    } else {
        console.warn('[Player] Could not find local track for transfer:', state.track.title);
        addToast(`Cannot transfer: "${state.track.title}" not found in local library`, 'error');
    }
}
