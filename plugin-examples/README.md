# Audion Plugin Examples

This folder contains example plugins demonstrating the Audion plugin system.

## Plugins

For a complete guide on creating plugins, including API reference and permissions, see the [Plugin Development Guide](../PLUGINS.md).

### 1. Now Playing Notifier
Shows system notifications when the track changes.
- **Type:** JavaScript
- **Permissions:** `player:read`, `system:notify`
- **Category:** Utility

### 2. Play Counter
Tracks how many times each song has been played.
- **Type:** JavaScript
- **Permissions:** `player:read`, `storage:local`
- **Category:** Library

### 3. Keyboard Shortcuts
Adds global keyboard shortcuts for playback control.
- **Type:** JavaScript
- **Permissions:** `player:control`
- **Category:** Utility
- **Shortcuts:**
  - `Space` - Play/Pause
  - `←` / `→` - Previous/Next track
  - `↑` / `↓` - Volume up/down
  - `M` - Mute

### 4. Theme Customizer
Transform Audion's look with stunning visual themes.
- **Type:** JavaScript
- **Permissions:** `ui:inject`, `storage:local`
- **Category:** Appearance

### 5. Tidal Search
Search and browse tracks from the Tidal catalog.
- **Type:** JavaScript
- **Permissions:** `network:fetch`, `ui:inject`, `player:control`
- **Category:** Library
- **Features:**
  - Search for tracks and artists
  - View album art, duration, and quality badges (Hi-Res, Lossless)
  - Toggle between track and artist search modes

## Plugin Structure

Each plugin requires:
- `plugin.json` - Manifest file with metadata
- `index.js` (or `.wasm` for WASM plugins) - Entry point

## Creating Your Own Plugin

```javascript
(function() {
    const MyPlugin = {
        name: 'My Plugin',
        
        init(api) {
            // Called when plugin is loaded
            this.api = api;
        },
        
        start() {
            // Called when plugin is enabled
        },
        
        stop() {
            // Called when plugin is disabled
        },
        
        destroy() {
            // Called when plugin is unloaded
        }
    };
    
    window.MyPlugin = MyPlugin;
    window.AudionPlugin = MyPlugin;
})();
```

## UI Slots

Plugins with the `ui:inject` permission can register UI elements into predefined slots:

| Slot Name | Location | Description |
|---|---|---|
| `playerbar:left` | Player bar (left side) | Next to track info |
| `playerbar:right` | Player bar (right side) | Next to volume controls |
| `playerbar:menu` | Plugin dropdown menu | **Auto-mirrored to mobile home** (see below) |
| `sidebar:top` | Sidebar (top area) | Desktop only |
| `sidebar:bottom` | Sidebar (bottom area) | Desktop only |
| `mobile:home` | Mobile home screen | Shown on the mobile Home tab |
| `mobile:bottomnav` | Mobile bottom navigation | Shown in the bottom nav area |

### Automatic Mobile Mirroring

For **backward compatibility**, content registered to `playerbar:menu` is **automatically cloned** to `mobile:home`. This means existing plugins that use `playerbar:menu` will appear on the mobile Home screen without any code changes.

- The mirrored elements delegate click events back to the original element.
- Removal from `playerbar:menu` also removes the mirrored clone.
- To opt out or add custom mobile-only content, register directly to `mobile:home`.

### Registering to Slots

```javascript
// Register a button in the plugin menu (works on both desktop & mobile automatically)
const btn = document.createElement('button');
btn.textContent = 'My Action';
btn.onclick = () => { /* do something */ };
api.ui.registerSlot('playerbar:menu', btn);

// Optionally register mobile-specific content (in addition to or instead of mirroring)
const mobileWidget = document.createElement('div');
mobileWidget.innerHTML = '<p>My mobile widget</p>';
api.ui.registerSlot('mobile:home', mobileWidget);
```

### Mobile Considerations

- `playerbar:menu` content is auto-mirrored to the mobile Home screen
- Plugin modals should use `max-width: 90vw` and `max-height: 85vh` for responsive sizing
- Fixed-position widgets should account for the bottom nav (60px) and mini player (64px)
- Touch targets should be at least 44×44px
- Use `-webkit-tap-highlight-color: transparent` on interactive elements
