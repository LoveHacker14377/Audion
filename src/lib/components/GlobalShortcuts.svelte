<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import {
        register,
        unregisterAll,
    } from "@tauri-apps/plugin-global-shortcut";
    import { togglePlay, nextTrack, previousTrack } from "$lib/stores/player";

    onMount(async () => {
        try {
            await unregisterAll();

            await register("MediaPlayPause", (event) => {
                if (event.state === "Pressed") {
                    togglePlay();
                }
            });

            await register("MediaTrackNext", (event) => {
                if (event.state === "Pressed") {
                    nextTrack();
                }
            });

            await register("MediaTrackPrevious", (event) => {
                if (event.state === "Pressed") {
                    previousTrack();
                }
            });

            console.log("Global media shortcuts registered");
        } catch (error) {
            console.error("Failed to register global shortcuts:", error);
        }
    });

    onDestroy(async () => {
        try {
            await unregisterAll();
        } catch (err) {
            console.error(err);
        }
    });
</script>
