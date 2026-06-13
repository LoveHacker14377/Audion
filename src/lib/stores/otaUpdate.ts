import { platform } from '@tauri-apps/plugin-os';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const PENDING_KEY = 'audion_pending_update_notes';

export interface PendingUpdateNotes {
    version: string;
    body: string | null;
    date: string | null;
}

/** returns true if this platform supports the Tauri OTA updater */
export function supportsOta(): boolean {
    const os = platform();
    return os === 'windows' || os === 'macos';
}

/**
 * checks for an update and, if found, downloads + installs it silently,
 * stashing release notes so they can be shown after relaunch
 * no-ops (resolves immediately) on unsupported platforms
 */
export async function checkAndInstallUpdate(): Promise<void> {
    if (!supportsOta()) return;

    try {
        const update = await check();
        if (!update) return;

        // stash notes for display after relaunch
        const notes: PendingUpdateNotes = {
            version: update.version,
            body: update.body ?? null,
            date: update.date ?? null,
        };
        localStorage.setItem(PENDING_KEY, JSON.stringify(notes));

        await update.downloadAndInstall();
        await relaunch();
    } catch (e) {
        console.error('OTA update check/install failed:', e);
    }
}

/**
 * call on app startup. if a previous session installed an update,
 * returns the stashed notes (and clears them) for one-time display
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