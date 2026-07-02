import { platform } from '@tauri-apps/plugin-os';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { writable, get } from 'svelte/store';

const PENDING_KEY = 'audion_pending_update_notes'; // what's new popup shown once after relaunch
const SKIP_KEY = 'audion_ota_skip_version';
const ENABLED_KEY = 'audion_ota_enabled';

/**
 * emitted from lib.rs when the OS requests the window close and the
 * frontend previously armed the close-intercept gate via
 * ota_set_close_intercept(true) (see deferOtaInstallToClose)
 * must match OTA_BEFORE_EXIT_EVENT in lib.rs
 */
export const OTA_BEFORE_EXIT_EVENT = 'ota://before-exit';

export interface PendingUpdateNotes {
    version: string;
    body: string | null;
    date: string | null;
}

export type OtaPhase =
    | 'idle'          // nothing to do / not checked yet
    | 'available'      // update found, not downloaded, popup can offer download
    | 'downloading'    // download in progress (popup may or may not be open)
    | 'ready'          // downloaded, waiting on restart now / later / skip
    | 'installing';    // install in flight

export interface OtaState {
    phase: OtaPhase;
    notes: PendingUpdateNotes | null;
    progress: number; // 0-100, only used while downloading
    installOnClose: boolean; // set when user picked Later
}

const initialState: OtaState = {
    phase: 'idle',
    notes: null,
    progress: 0,
    installOnClose: false,
};

export const otaState = writable<OtaState>(initialState);

/** reactive mirror of the enabled flag, for settings ui binding */
export const otaEnabled = writable<boolean>(readEnabledFromStorage());

// the live update handle from the plugin
let activeUpdate: Update | null = null;

function readEnabledFromStorage(): boolean {
    const raw = localStorage.getItem(ENABLED_KEY);
    if (raw === null) return true; // default on
    return raw === 'true';
}

/** returns whether the OTA flow is enabled (persisted, defaults to true) */
export function isOtaEnabled(): boolean {
    return readEnabledFromStorage();
}

/** enable/disable the OTA flow. sisabling resets any in-flight state */
export function setOtaEnabled(value: boolean): void {
    localStorage.setItem(ENABLED_KEY, value ? 'true' : 'false');
    otaEnabled.set(value);
    if (!value) {
        // don't leave a dangling download/handle
        activeUpdate?.close().catch(() => {});
        activeUpdate = null;
        otaState.set({ ...initialState });
        invoke('ota_set_close_intercept', { enabled: false }).catch(() => {});
    }
}

/** returns true if this platform supports the Tauri OTA updater */
export function supportsOta(): boolean {
    const os = platform();
    return os === 'windows' || os === 'macos';
}

function getSkippedVersion(): string | null {
    return localStorage.getItem(SKIP_KEY);
}

function setSkippedVersion(version: string): void {
    localStorage.setItem(SKIP_KEY, version);
}

/**
 * checks for an update (metadata only => does not download)
 * no-ops on unsupported platforms or when OTA is disabled
 * if an update is found and it isn't the version the user previously
 * skipped, otaState moves to available so the popup can show
 */
export async function checkForOtaUpdate(): Promise<void> {
    if (!isOtaEnabled() || !supportsOta()) return;

    // already have a handle from this session (e.g. re-entrant call) => no-op
    if (activeUpdate) return;

    try {
        const update = await check();
        if (!update) return;

        const skipped = getSkippedVersion();
        if (skipped && skipped === update.version) return;

        activeUpdate = update;
        const notes: PendingUpdateNotes = {
            version: update.version,
            body: update.body ?? null,
            date: update.date ?? null,
        };
        otaState.set({ phase: 'available', notes, progress: 0, installOnClose: false });
    } catch (e) {
        console.error('OTA update check failed:', e);
    }
}

/**
 * begins downloading the update
 * does not install anything
 */
export async function startOtaDownload(): Promise<void> {
    if (!activeUpdate) return;

    let contentLength = 0;
    let downloaded = 0;

    otaState.update((s) => ({ ...s, phase: 'downloading', progress: 0 }));

    try {
        await activeUpdate.download((event: DownloadEvent) => {
            switch (event.event) {
                case 'Started':
                    contentLength = event.data.contentLength ?? 0;
                    break;
                case 'Progress':
                    downloaded += event.data.chunkLength;
                    if (contentLength > 0) {
                        const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
                        otaState.update((s) => ({ ...s, progress: pct }));
                    }
                    break;
                case 'Finished':
                    break;
            }
        });

        otaState.update((s) => ({ ...s, phase: 'ready', progress: 100 }));
    } catch (e) {
        console.error('OTA download failed:', e);
        // fall back to available so the user can retry
        otaState.update((s) => ({ ...s, phase: 'available', progress: 0 }));
    }
}

/**
 * installs the already-downloaded update immediately
 */
export async function installOtaNow(): Promise<void> {
    if (!activeUpdate) return;
    const notes = get(otaState).notes;

    otaState.update((s) => ({ ...s, phase: 'installing' }));

    // stash notes so the "what's new" popup can show on next startup, in case
    // the process gets killed by the installer before we get any further
    if (notes) {
        localStorage.setItem(PENDING_KEY, JSON.stringify(notes));
    }
    clearSkipIfMatches(notes?.version);
    invoke('ota_set_close_intercept', { enabled: false }).catch(() => {});

    try {
        await activeUpdate.install();
        await relaunch();
    } catch (e) {
        console.error('OTA install/relaunch failed:', e);
        // if we get here the app is presumably still alive => restore state
        otaState.update((s) => ({ ...s, phase: 'ready' }));
    }
}

/**
 * marks the downloaded update to be installed when the app is closing, instead of right now
 * actual install happens in handleBeforeExit, invoked from the close-request listener
 * arms the backend close-intercept gate so the window
 * actually waits for us instead of quitting immediately
 */
export function deferOtaInstallToClose(): void {
    otaState.update((s) => ({ ...s, installOnClose: true }));
    invoke('ota_set_close_intercept', { enabled: true }).catch((e) => {
        console.error('Failed to arm OTA close intercept:', e);
    });
}

/**
 * discards the currently offered/downloaded update entirely and remembers
 * not to show it again until a newer version is released.
 */
export async function skipOtaVersion(): Promise<void> {
    const notes = get(otaState).notes;
    if (notes) setSkippedVersion(notes.version);

    try {
        // closing the resource also cleans up the downloaded installer file
        await activeUpdate?.close();
    } catch (e) {
        console.error('Failed to close OTA update handle:', e);
    }

    activeUpdate = null;
    otaState.set({ ...initialState });
    invoke('ota_set_close_intercept', { enabled: false }).catch(() => {});
}

function clearSkipIfMatches(version: string | undefined | null): void {
    if (!version) return;
    if (getSkippedVersion() === version) {
        localStorage.removeItem(SKIP_KEY);
    }
}

/**
 * call on app startup (once, from Sidebar) if a previous session installed
 * an update and relaunched, returns the stashed notes (and clears them) for
 * one-time what's new display
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

/**
 * registers the listener for the OS-level close request. Only installs the
 * update if the user previously picked "Later" while an update was fully
 * downloaded ('ready' phase + installOnClose). This only fires at all when
 * the Rust-side gate was armed via deferOtaInstallToClose(), so it's safe
 * to register unconditionally on startup.
 */
export function registerOtaExitHandler(): Promise<() => void> {
    return listen(OTA_BEFORE_EXIT_EVENT, async () => {
        await handleBeforeExit();
    });
}

async function handleBeforeExit(): Promise<void> {
    const state = get(otaState);
    if (state.phase === 'ready' && state.installOnClose && activeUpdate) {
        try {
            await activeUpdate.install();
        } catch (e) {
            console.error('Install-on-close failed:', e);
        }
    }
    // tell backend it's safe to actually close the window now
    try {
        await invoke('ota_confirm_exit');
    } catch (e) {
        console.error('Failed to confirm OTA exit:', e);
    }
}