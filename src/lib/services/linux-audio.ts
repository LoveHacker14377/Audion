// =============================================================================
// LINUX NATIVE AUDIO SERVICE
// =============================================================================
// This service provides an abstraction layer for audio playback on Linux.
//
// WHY THIS EXISTS:
// WebKitGTK (the WebView engine on Linux) has issues with the asset:// protocol
// for media playback. Instead of trying to work around WebView bugs, we use
// a native audio backend implemented in Rust (rodio).
//
// HOW IT WORKS:
// 1. On app start, we detect if we're running on Linux
// 2. If on Linux, audio commands are routed to the Rust backend via Tauri invoke
// 3. The Rust backend uses rodio to play audio through the system default device
// 4. On Windows/Mac, the existing HTML5 Audio element continues to work
//
// DESIGN DECISIONS:
// - Simple play/pause/stop/seek interface matching the existing player store
// - Position tracking is done via polling since rodio doesn't emit events
// - Volume is controlled through the Rust backend, not the WebView
// =============================================================================

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '$lib/api/tauri';

// Check if we're running on Linux
let isLinuxPlatform: boolean | null = null;

/**
 * Detect if we're running on Linux.
 * This is cached after first check for performance.
 */
export async function isLinux(): Promise<boolean> {
    if (isLinuxPlatform !== null) {
        return isLinuxPlatform;
    }

    if (!isTauri()) {
        isLinuxPlatform = false;
        return false;
    }

    try {
        // Use Tauri's os plugin to detect platform
        const { platform } = await import('@tauri-apps/plugin-os');
        const os = await platform();
        isLinuxPlatform = os === 'linux';
        console.log(`[AUDIO] Platform detected: ${os}, using ${isLinuxPlatform ? 'native' : 'HTML5'} audio`);
        return isLinuxPlatform;
    } catch (e) {
        // Fallback: check navigator.platform
        isLinuxPlatform = typeof navigator !== 'undefined' &&
                          navigator.platform.toLowerCase().includes('linux');
        return isLinuxPlatform;
    }
}

// =============================================================================
// PLAYBACK STATE TYPE
// =============================================================================
// This matches the Rust PlaybackState struct

export interface LinuxPlaybackState {
    is_playing: boolean;
    position: number;  // seconds
    duration: number;  // seconds
    volume: number;    // 0.0 to 1.0
    current_path: string;
}

// =============================================================================
// AUDIO CONTROL FUNCTIONS
// =============================================================================
// These functions call the Rust backend via Tauri invoke.
// They are only called on Linux - the player store handles the platform check.

/**
 * Play an audio file using the native backend
 * @param path - Absolute path to the audio file
 */
export async function linuxAudioPlay(path: string): Promise<void> {
    console.log('[AUDIO] Native play:', path);
    await invoke('linux_audio_play', { path });
}

/**
 * Pause playback
 */
export async function linuxAudioPause(): Promise<void> {
    await invoke('linux_audio_pause');
}

/**
 * Resume playback
 */
export async function linuxAudioResume(): Promise<void> {
    await invoke('linux_audio_resume');
}

/**
 * Stop playback completely
 */
export async function linuxAudioStop(): Promise<void> {
    await invoke('linux_audio_stop');
}

/**
 * Set volume (0.0 to 1.0)
 */
export async function linuxAudioSetVolume(volume: number): Promise<void> {
    await invoke('linux_audio_set_volume', { volume });
}

/**
 * Seek to position (0.0 to 1.0 as fraction of duration)
 */
export async function linuxAudioSeek(position: number): Promise<void> {
    await invoke('linux_audio_seek', { position });
}

/**
 * Get current playback state
 */
export async function linuxAudioGetState(): Promise<LinuxPlaybackState> {
    return await invoke('linux_audio_get_state');
}

/**
 * Check if the current track has finished playing
 */
export async function linuxAudioIsFinished(): Promise<boolean> {
    return await invoke('linux_audio_is_finished');
}

// =============================================================================
// HELPER: Check if native audio backend should be used
// =============================================================================

let useNativeAudioBackend: boolean | null = null;

/**
 * Check if we should use the native audio backend.
 *
 * This returns true when:
 * 1. Running on Linux (always has native audio), OR
 * 2. Running on any platform where native_audio_available command exists
 *    (i.e., built with --features native-audio)
 *
 * The check tries to call the native_audio_available command first.
 * If it fails (command doesn't exist), we fall back to platform detection.
 */
export async function shouldUseNativeAudio(): Promise<boolean> {
    if (useNativeAudioBackend !== null) {
        return useNativeAudioBackend;
    }

    if (!isTauri()) {
        useNativeAudioBackend = false;
        return false;
    }

    try {
        // Try to call the native audio check command
        // If this succeeds, the backend was compiled with native audio support
        const available = await invoke<boolean>('native_audio_available');
        useNativeAudioBackend = available;
        console.log(`[AUDIO] Native audio backend: ${available ? 'available' : 'not available'}`);
        return useNativeAudioBackend;
    } catch (e) {
        // Command doesn't exist, so native audio is not compiled
        console.log('[AUDIO] Native audio backend not available (using HTML5 Audio)');
        useNativeAudioBackend = false;
        return false;
    }
}
