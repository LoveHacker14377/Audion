<script lang="ts">
    import { onMount, tick } from "svelte";
    import { uiSlotManager } from "$lib/plugins/ui-slots";

    let menuOpen = false;
    let menuButton: HTMLButtonElement;
    let menuDropdown: HTMLDivElement;
    let slotContainer: HTMLDivElement;
    let hasContent = false;

    function toggleMenu() {
        menuOpen = !menuOpen;
    }

    function closeMenu(e: MouseEvent) {
        if (
            menuOpen &&
            menuButton &&
            !menuButton.contains(e.target as Node) &&
            menuDropdown &&
            !menuDropdown.contains(e.target as Node)
        ) {
            menuOpen = false;
        }
    }

    function registerMenuSlot(node: HTMLElement) {
        uiSlotManager.registerContainer("playerbar:menu", node);

        return {
            destroy() {
                uiSlotManager.unregisterContainer("playerbar:menu");
            },
        };
    }

    onMount(() => {
        window.addEventListener("click", closeMenu);

        return () => {
            window.removeEventListener("click", closeMenu);
            // Cleanup handled by action destroy
        };
    });
</script>

<div class="plugin-menu-container">
    <button
        class="icon-btn"
        class:active={menuOpen}
        bind:this={menuButton}
        on:click={toggleMenu}
        title="Plugins"
    >
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8 8 8zm-5.5-2.5l7.51-3.22-3.22-7.51-7.51 3.22 3.22 7.51z"
            />
        </svg>
    </button>

    {#if menuOpen}
        <div class="plugin-dropdown" bind:this={menuDropdown}>
            <div
                class="plugin-slot-list"
                use:registerMenuSlot
                bind:this={slotContainer}
            ></div>
            {#if uiSlotManager.getSlotContent("playerbar:menu").length === 0}
                <div class="empty-state">No active plugins in menu</div>
            {/if}
        </div>
    {/if}
</div>

<style>
    .plugin-menu-container {
        position: relative;
    }

    .icon-btn {
        width: 32px;
        height: 32px;
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        transition: all var(--transition-fast);
        background: transparent;
        border: none;
        cursor: pointer;
    }

    .icon-btn:hover,
    .icon-btn.active {
        color: var(--text-primary);
        background-color: var(--bg-highlight);
    }

    .plugin-dropdown {
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: var(--spacing-sm);
        background-color: var(--bg-surface);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        padding: 6px;
        min-width: 220px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
        z-index: 1000;
        display: flex;
        flex-direction: column;
    }

    .plugin-slot-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
    }

    .empty-state {
        padding: var(--spacing-sm);
        color: var(--text-subdued);
        font-size: 0.8rem;
        text-align: center;
    }
</style>
