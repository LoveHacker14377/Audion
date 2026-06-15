import { writable, derived } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { currentTrack } from "$lib/stores/player";
import { getTrackCoverSrc } from "$lib/api/tauri";

export const albumPalette = writable<string[]>([]);
const cache = new Map<string, string[]>();

currentTrack.subscribe(async (track) => {
  if (!track) {
    albumPalette.set([]);
    return;
  }

  const coverSrc = getTrackCoverSrc(track);
  if (!coverSrc) {
    albumPalette.set([]);
    return;
  }

  if (cache.has(coverSrc)) {
    albumPalette.set(cache.get(coverSrc)!);
    return;
  }

  try {
    const bytes = await fetch(coverSrc).then((r) => r.arrayBuffer());
    const palette: string[] = await invoke("extract_palette", {
      imageBytes: Array.from(new Uint8Array(bytes)),
    });
    cache.set(coverSrc, palette);
    albumPalette.set(palette);
  } catch (e) {
    console.error("Palette extraction failed:", e);
    albumPalette.set([]);
  }
});

export const meshColors = derived(albumPalette, (palette) => {
  const fallback = ["#0a0a0a", "#0a0a0a", "#0a0a0a", "#0a0a0a"];
  switch (palette.length) {
    case 0:
      return fallback;
    case 1:
      return [palette[0], palette[0], palette[0], palette[0]];
    case 2:
      return [palette[1], palette[0], palette[1], palette[0]];
    case 3:
      return [palette[1], palette[0], palette[1], palette[2]];
    default:
      return [palette[1], palette[0], palette[palette.length - 1], palette[palette.length - 2]];
  }
});