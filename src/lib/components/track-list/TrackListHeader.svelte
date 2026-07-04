<script lang="ts">
  import type { Track } from "$lib/api/tauri";
  import { multiSelect } from "$lib/stores/multiselect";
  import { _ } from "svelte-i18n";

  export let multiSelectMode = false;
  export let showAlbum = true;
  export let playlistId: number | null = null;
  export let scrollbarWidth = 0;
  export let sortedTracks: Track[] = [];
  export let sortField: string | null = null;
  export let sortDirection: "asc" | "desc" = "asc";

  export let toggleSort: (field: any) => void;
</script>

<header
  class="list-header"
  class:no-album={!showAlbum}
  class:with-drag={playlistId !== null}
  class:multiselect={multiSelectMode}
  style={`--scrollbar-width: ${scrollbarWidth}px`}
>
  {#if multiSelectMode}
    <div class="col-header col-checkbox">
      <input
        type="checkbox"
        on:change={(e) => {
          if (e.currentTarget.checked) {
            multiSelect.selectAll(sortedTracks.map((t) => t.id));
          } else {
            multiSelect.clearSelections();
          }
        }}
        checked={$multiSelect.selectedTrackIds.size > 0 &&
          $multiSelect.selectedTrackIds.size === sortedTracks.length}
        indeterminate={$multiSelect.selectedTrackIds.size > 0 &&
          $multiSelect.selectedTrackIds.size < sortedTracks.length}
      />
    </div>
  {/if}
  {#if playlistId !== null && !multiSelectMode}
    <span class="col-header col-drag"></span>
  {/if}
  <button class="col-header col-num sortable" on:click={() => toggleSort("track_number")}>
    #
    {#if sortField === "track_number"}
      <span class="sort-icon">{sortDirection === "asc" ? "▲" : "▼"}</span>
    {/if}
  </button>
  <button
    class="col-header col-artist sortable"
    on:click={() => toggleSort("title")}
  >
    {$_('trackList.title')}
    {#if sortField === "title"}
      <span class="sort-icon">{sortDirection === "asc" ? "▲" : "▼"}</span>
    {/if}
  </button>
  {#if showAlbum}
    <button
      class="col-header col-album sortable"
      on:click={() => toggleSort("album")}
    >
      {$_('trackList.album')}
      {#if sortField === "album"}
        <span class="sort-icon">{sortDirection === "asc" ? "▲" : "▼"}</span>
      {/if}
    </button>
  {/if}
  <button
    class="col-header col-duration sortable"
    on:click={() => toggleSort("duration")}
  >
    {$_('trackList.duration')}
    {#if sortField === "duration"}
      <span class="sort-icon">{sortDirection === "asc" ? "▲" : "▼"}</span>
    {/if}
  </button>
  <button
    class="col-header col-date-added sortable"
    on:click={() => toggleSort("date_added")}
  >
    {$_('trackList.dateAdded')}
    {#if sortField === "date_added"}
      <span class="sort-icon">{sortDirection === "asc" ? "▲" : "▼"}</span>
    {/if}
  </button>
</header>
