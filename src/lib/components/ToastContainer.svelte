<script lang="ts">
    import { toasts } from "$lib/stores/toast";
    import Toast from "./Toast.svelte";
</script>

<div class="toast-container">
    {#each $toasts as toast (toast.id)}
        <Toast {toast} />
    {/each}
</div>

<style>
    .toast-container {
        position: fixed;
        bottom: 24px; /* Above the player bar ideally, or just float on top */
        right: 24px;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        pointer-events: none; /* Let clicks pass through container but not toasts */
    }

    /* Adjust position if miniplayer or mobile layouts needed later */

    @media (max-width: 768px) {
        .toast-container {
            right: 0;
            left: 0;
            bottom: 72px; /* Above mobile player bar (64px) */
            align-items: center;
            padding: 0 var(--spacing-sm);
        }
    }
</style>
