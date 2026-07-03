import { writable } from 'svelte/store';

const STORAGE_KEY = 'audion_home_layout_v1';

export interface HomeSection {
    id: string;
    visible: boolean;
}

const defaultLayout: HomeSection[] = [
    { id: 'stats', visible: true },
    { id: 'pinned', visible: true },
    { id: 'quickplay', visible: true },
    { id: 'recent', visible: true },
    { id: 'continue', visible: true },
    { id: 'added', visible: true },
    { id: 'topTracks', visible: true },
    { id: 'topAlbums', visible: true },
    { id: 'charts', visible: true }
];

function loadFromStorage(): HomeSection[] {
    if (typeof window === 'undefined') return defaultLayout;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return defaultLayout;
        const parsed = JSON.parse(raw);
        // Ensure any newly added sections are appended if not present in stored layout
        const merged = [...parsed];
        defaultLayout.forEach(defSec => {
            if (!merged.some(s => s.id === defSec.id)) {
                merged.push(defSec);
            }
        });
        return merged;
    } catch (e) {
        console.error('[homeLayout] failed to load:', e);
        return defaultLayout;
    }
}

function saveToStorage(state: HomeSection[]) {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.error('[homeLayout] failed to save:', e);
    }
}

const initial = loadFromStorage();
export const homeLayout = writable<HomeSection[]>(initial);

homeLayout.subscribe((v) => saveToStorage(v));

export function toggleSection(id: string) {
    homeLayout.update((state) => {
        return state.map(s => s.id === id ? { ...s, visible: !s.visible } : s);
    });
}

export function reorderSection(fromIndex: number, toIndex: number) {
    homeLayout.update((state) => {
        const result = [...state];
        const [removed] = result.splice(fromIndex, 1);
        result.splice(toIndex, 0, removed);
        return result;
    });
}
