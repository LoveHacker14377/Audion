<script lang="ts">
  import SupportSection from "./settings/SupportSection.svelte";
  import AccountSection from "./settings/AccountSection.svelte";
  import SyncSection from "./settings/SyncSection.svelte";
  import PlaybackSection from "./settings/PlaybackSection.svelte";
  import ShortcutsSection from "./settings/ShortcutsSection.svelte";
  import StorageSection from "./settings/StorageSection.svelte";
  import AudioSection from "./settings/AudioSection.svelte";
  import CommunitySection from "./settings/CommunitySection.svelte";
  import AppearanceSection from "./settings/AppearanceSection.svelte";
  import PrivacySection from "./settings/PrivacySection.svelte";
  import UpgradeSection from "./settings/UpgradeSection.svelte";
  import AboutSection from "./settings/AboutSection.svelte";
  import "./settings/styles.css";
  import { _ } from "svelte-i18n";

  let openSections: Record<string, boolean> = {};

  function toggle(section: string) {
    openSections[section] = !openSections[section];
    openSections = openSections;
  }
</script>

<div class="settings-view">
  <header class="view-header">
    <h1>{$_('settings.title', { default: 'Settings' })}</h1>
  </header>

  <div class="settings-content">
    <div class="settings-container">
      <SupportSection open={openSections['support'] ?? false} on:toggle={() => toggle('support')} />
      <AccountSection open={openSections['account'] ?? false} on:toggle={() => toggle('account')} />
      <SyncSection open={openSections['sync'] ?? false} on:toggle={() => toggle('sync')} />
      <PlaybackSection open={openSections['playback'] ?? false} on:toggle={() => toggle('playback')} />
      <ShortcutsSection open={openSections['shortcuts'] ?? false} on:toggle={() => toggle('shortcuts')} />
      <StorageSection open={openSections['storage'] ?? false} on:toggle={() => toggle('storage')} />
      <AudioSection open={openSections['audio'] ?? false} on:toggle={() => toggle('audio')} />
      <CommunitySection open={openSections['community'] ?? false} on:toggle={() => toggle('community')} />
      <AppearanceSection open={openSections['appearance'] ?? false} on:toggle={() => toggle('appearance')} />
      <PrivacySection open={openSections['privacy'] ?? false} on:toggle={() => toggle('privacy')} />
      <UpgradeSection open={openSections['upgrade'] ?? false} on:toggle={() => toggle('upgrade')} />
      <AboutSection open={openSections['about'] ?? false} on:toggle={() => toggle('about')} />
    </div>
  </div>
</div>