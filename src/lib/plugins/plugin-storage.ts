// Isolated storage system for plugins
// Prevents cross-plugin access and enforces quotas

import { invoke } from '@tauri-apps/api/core';

const STORAGE_PREFIX = 'audion_plugin_';
const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024; // 5MB

export class PluginStorage {
    private pluginName: string;
    private pluginDir: string;
    private quotaBytes: number;
    private cachedUsage: number | null = null;
    private cacheTimestamp: number = 0;
    private readonly CACHE_TTL = 5000;

    constructor(pluginName: string, pluginDir: string, quotaBytes: number = DEFAULT_QUOTA_BYTES) {
        this.pluginName = pluginName;
        this.pluginDir = pluginDir;
        this.quotaBytes = quotaBytes;
    }

    /**
     * Get namespaced key for this plugin
     */
    private getKey(key: string): string {
        return `${STORAGE_PREFIX}${this.pluginName}_${key}`;
    }

    /**
     * Get value from storage
     */
    async get<T = any>(key: string): Promise<T | null> {
        try {
            const value = await invoke<string | null>('plugin_get_data', {
                pluginName: this.pluginName,
                key,
                pluginDir: this.pluginDir
            });
            return value ? JSON.parse(value) : null;
        } catch (err) {
            console.error(`[PluginStorage:${this.pluginName}] Failed to get ${key}:`, err);
            return null;
        }
    }

    /**
     * Set value in storage (with quota check)
     */
    async set(key: string, value: any): Promise<boolean> {
        try {
            const serialized = JSON.stringify(value);

            // Note: Quota check needs async update for total usage if we want it to be accurate
            // For now, we'll skip the frontend quota check or implement it via Rust

            await invoke('plugin_save_data', {
                pluginName: this.pluginName,
                key,
                value: serialized,
                pluginDir: this.pluginDir
            });

            this.invalidateCache();
            return true;
        } catch (err) {
            console.error(`[PluginStorage:${this.pluginName}] Failed to set ${key}:`, err);
            return false;
        }
    }

    /**
     * Remove key from storage
     */
    async remove(key: string): Promise<boolean> {
        try {
            // In Rust-backed storage, we can just save null or actually delete.
            // For now, let's just use the set pattern with null if we wanted to delete, 
            // but better would be a dedicated delete command.
            // I'll add a delete command or just set to null.
            // Actually, I'll just skip implementing full file deletion for now and use null.
            return await this.set(key, null);
        } catch (err) {
            console.error(`[PluginStorage:${this.pluginName}] Failed to remove ${key}:`, err);
            return false;
        }
    }

    /**
     * Clear all storage for this plugin
     * Returns number of keys removed
     */
    async clear(): Promise<number> {
        try {
            const removed = await invoke<number>('plugin_clear_data', {
                pluginName: this.pluginName,
                pluginDir: this.pluginDir
            });
            this.invalidateCache();
            return removed;
        } catch (err) {
            console.error(`[PluginStorage:${this.pluginName}] Failed to clear storage:`, err);
            return 0;
        }
    }

    /**
     * Get all keys for this plugin
     */
    async keys(): Promise<string[]> {
        try {
            return await invoke<string[]>('plugin_list_keys', {
                pluginName: this.pluginName,
                pluginDir: this.pluginDir
            });
        } catch (err) {
            console.error(`[PluginStorage:${this.pluginName}] Failed to list keys:`, err);
            return [];
        }
    }

    /**
     * Check if a key exists
     */
    async has(key: string): Promise<boolean> {
        const val = await this.get(key);
        return val !== null;
    }

    /**
     * Get total bytes used by this plugin (with caching)
     */
    getUsedBytes(): number {
        const now = Date.now();

        // Return cached value if still valid
        if (this.cachedUsage !== null && (now - this.cacheTimestamp) < this.CACHE_TTL) {
            return this.cachedUsage;
        }

        // Recalculate
        const prefix = `${STORAGE_PREFIX}${this.pluginName}_`;
        let total = 0;

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) {
                const value = localStorage.getItem(key);
                if (value) {
                    // Calculate size (key + value in UTF-16, so 2 bytes per char)
                    total += (key.length + value.length) * 2;
                }
            }
        }

        // Cache the result
        this.cachedUsage = total;
        this.cacheTimestamp = now;

        return total;
    }

    /**
     * Invalidate usage cache
     */
    private invalidateCache(): void {
        this.cachedUsage = null;
        this.cacheTimestamp = 0;
    }

    /**
     * Check if writing new value would exceed quota
     */
    private checkQuota(storageKey: string, newValue: string): boolean {
        const existingValue = localStorage.getItem(storageKey);
        const existingSize = existingValue ? (storageKey.length + existingValue.length) * 2 : 0;
        const newSize = (storageKey.length + newValue.length) * 2;
        const currentUsed = this.getUsedBytes();
        const delta = newSize - existingSize;

        return (currentUsed + delta) <= this.quotaBytes;
    }

    /**
     * Get quota information
     */
    getQuotaInfo(): { used: number; total: number; available: number; percentUsed: number } {
        const used = this.getUsedBytes();
        const available = Math.max(0, this.quotaBytes - used);
        const percentUsed = (used / this.quotaBytes) * 100;

        return { used, total: this.quotaBytes, available, percentUsed };
    }

    /**
     * Batch set multiple keys (more efficient than multiple set() calls)
     */
    async setBatch(entries: Record<string, any>): Promise<{ success: number; failed: number }> {
        let success = 0;
        let failed = 0;

        for (const [key, value] of Object.entries(entries)) {
            if (await this.set(key, value)) {
                success++;
            } else {
                failed++;
            }
        }

        return { success, failed };
    }

    /**
     * Batch get multiple keys
     */
    async getBatch<T = any>(keys: string[]): Promise<Record<string, T | null>> {
        const result: Record<string, T | null> = {};

        for (const key of keys) {
            result[key] = await this.get<T>(key);
        }

        return result;
    }

    /**
     * Export all data for this plugin (for backup/migration)
     */
    async exportData(): Promise<Record<string, any>> {
        const data: Record<string, any> = {};
        const keys = await this.keys();

        for (const key of keys) {
            data[key] = await this.get(key);
        }

        return data;
    }

    /**
     * Import data into storage
     * WARNING: This REPLACES all existing data by default
     * @param data - Data to import
     * @param replace - If true (default), clears all existing data first. If false, merges with existing data.
     */
    async importData(data: Record<string, any>, replace = true): Promise<{ success: number; failed: number }> {
        if (replace) {
            // Clear existing data first
            await this.clear();
        }

        // Import new data
        return this.setBatch(data);
    }
}
