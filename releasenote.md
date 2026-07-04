# Release Notes - Audion

## [v1.3.7] - 2026-07-04

### Highlights: Linux Compatibility & Mobile UI Polish

* **Linux Compatibility**: Resolved critical startup and IPC connection bugs on Linux/Debian systems, including WebKitNetworkProcess launching, missing IPC CSP rules, and adding a `requestIdleCallback` polyfill for older WebKit versions.
* **Mobile UI Polish**: Enhanced mobile player experience with larger seek bar touch targets and visible seek thumb/progress line. Fixed layout issues on mobile view categories and page paddings.

### Bug Fixes

* **Linux IPC**: Added `ipc:` and `ipc://localhost` to CSP to allow frontend commands to talk to the Rust backend on Linux.
* **Linux GVfs**: Fixed gvfs module errors causing AppImages to crash with undefined symbols.
* **Linux WebKit**: Set `APPDIR` environment variable in the wrapper script so the WebKitNetworkProcess binary can be found correctly.
* **Polyfills**: Added fallback for `requestIdleCallback` so pages load without ReferenceErrors on WebKit/Linux views.
* **Mobile Seek Bar**: Expanded the seek bar hit area to 28px on mobile, made progress line accent-colored and always show the seek thumb.
* **Mobile Category Pills**: Fixed plugin marketplace categories on mobile overlapping and extending weirdly by resetting min-sizes.
* **Mobile Black Screen**: Removed redundant bottom padding calc causing layout breakdown and half-black screens on Artist Detail, Liked Songs, and Playlist views.
* **Grid Column Layout**: Clamped the grid to exactly 2 columns for narrow container widths (< 924px) to ensure consistency when sidebar toggles.

## [v1.3.6] - 2026-07-03

### Highlights: Audio Upgrades & UI Refinements

* **Audio Engine Upgrades**: Seamless crossfade transitions between tracks, a customizable Equalizer (EQ), and audio preloading for gapless playback.
* **New Text System**: Text sizes and styles now look consistent everywhere in the app.
* **Settings Page Makeover**: Cleaner menus with smooth animations, mobile-friendly layout, and uniform button sizing.
* **Search Now Works**: Fixed a bug where searching returned nothing — search results now show up properly when you type.
* **Smooth Page Switching**: Switch between views without page content jumping around.

### Bug Fixes

* **Breadcrumbs**: Long folder names in the top bar no longer cover up the search bar.
* **Page Transitions**: Fixed the jarring jump that happened when switching between pages.
* **Album Order**: Tracks inside an album now play in the correct disk and track order.
* **Keyboard Shortcuts**: Fixed rare issues where shortcuts would conflict or register twice.
* **Media Controls**: Less unnecessary updates to the system media player integration.
* **Android Storage**: Allowed adding music folders from external storage and SD cards.
* **Security**: Safe HTML formatting when displaying release notes inside the app.
* **Discord**: Fixed song detail uploads and connectivity issues with Discord.

### New Features & Enhancements

* **Crossfade & EQ**: Custom crossfade duration and a 10-band Equalizer are now available in Settings.
* **Track Preloading**: Seamless gapless playback via background track preloading.
* **Keyboard Shortcuts**: You can now customize keyboard shortcuts from Settings.
* **Mobile Player**: New compact player for mobile screens with animated seek bar.
* **Auto Updates**: Audion now automatically updates itself on Windows and macOS.
* **Fullscreen**: Improved fullscreen background performance.
* **Plugins**: Better plugin support for cover art and file uploads.
* **Faster Builds**: Developer code builds run faster now.
* **Android**: Better compatibility for newer Android versions.