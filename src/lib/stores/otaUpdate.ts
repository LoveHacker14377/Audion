import { platform } from '@tauri-apps/plugin-os';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { writable } from 'svelte/store';

const PENDING_KEY = 'audion_pending_update_notes';
const READY_KEY = 'audion_update_ready';

export interface PendingUpdateNotes {
    version: string;
    body: string | null;
    date: string | null;
}

/**
 * reactive store. set to the installed-but-not-yet-applied update notes when
 * a background download completes. cleared on relaunch or explicit dismiss
 * Sidebar is the sole writer (it runs checkAndInstallUpdate on startup)
 * settings and other components subscribe read-only
 */
export const otaUpdateReady = writable<PendingUpdateNotes | null>(null);

/** returns true if this platform supports the Tauri OTA updater */
export function supportsOta(): boolean {
    const os = platform();
    return os === 'windows' || os === 'macos';
}

/**
 * returns the update that has been downloaded and is waiting for a restart,
 * or null if no update is pending. reads from localStorage so the state
 * survives navigation within the same session
 */
export function getUpdateReady(): PendingUpdateNotes | null {
    const raw = localStorage.getItem(READY_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as PendingUpdateNotes;
    } catch {
        return null;
    }
}

/**
 * checks for an update and, if found, downloads + installs it in the
 * background, then prompts the user to restart
 *
 * Notes are only written to local storage after a successful downloadAndInstall
 *
 * no-ops (resolves immediately) on unsupported platforms
 *
 * returns the update notes if an update was downloaded and is ready,
 * or null if no update was found or installation failed
 */
export async function checkAndInstallUpdate(): Promise<PendingUpdateNotes | null> {
    if (!supportsOta()) return null;

    // already downloaded in a previous check this session => no need to recheck
    // this means if the user clicks Later and a newer version comes
    // overnight, it won't be discovered until after restart
    // acceptable i think
    const alreadyReady = getUpdateReady();
    if (alreadyReady) return alreadyReady;

    try {
        const update = await check();
        if (!update) return null;

        await update.downloadAndInstall();

        // only store notes after a confirmed successful install
        const notes: PendingUpdateNotes = {
            version: update.version,
            body: update.body ?? null,
            date: update.date ?? null,
        };
        localStorage.setItem(READY_KEY, JSON.stringify(notes));
        otaUpdateReady.set(notes);
        return notes;
    } catch (e) {
        console.error('OTA update check/install failed:', e);
        return null;
    }
}

/**
 * relaunches the app to apply the installed update
 * accepts the notes directly
 */
export async function applyUpdateAndRelaunch(notes: PendingUpdateNotes): Promise<void> {
    // stash notes so they can be shown as a "what's new" popup on next startup
    localStorage.setItem(PENDING_KEY, JSON.stringify(notes));
    localStorage.removeItem(READY_KEY);
    otaUpdateReady.set(null);
    await relaunch();
}

/**
 * call on app startup
 * if a previous session installed an update and relaunched, returns the stashed notes (and clears them) for one-time display
 * only call this from one place (sidebar, which mounts at startup)
 */
export function consumePendingUpdateNotes(): PendingUpdateNotes | null {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    localStorage.removeItem(PENDING_KEY);
    try {
        return JSON.parse(raw) as PendingUpdateNotes;
    } catch {
        return null;
    }
}