# Release Notes - Audion

## [v1.3.6] - 2026-07-03

### Highlights: UI Overhaul & Search Fixes

* **New Text System**: Text sizes and styles now look consistent everywhere in the app.
* **Settings Page Makeover**: Cleaner menus with smooth animations, mobile-friendly layout, and buttons that look the same size.
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

* **Keyboard Shortcuts**: You can now customize keyboard shortcuts from Settings.
* **Mobile Player**: New compact player for mobile screens with animated seek bar.
* **Auto Updates**: Audion now automatically updates itself on Windows and macOS.
* **Fullscreen**: Improved fullscreen background performance.
* **Plugins**: Better plugin support for cover art and file uploads.
* **Faster Builds**: Developer code builds run faster now.
* **Android**: Better compatibility for newer Android versions.

## [v1.3.5] - 2026-06-12

### Highlights: Server Docker Support & Custom Server Integration

* **Docker Support**: Official support for self-hosted libraries via Docker.
* **Server Streaming**: Listen to your music library streamed directly from a custom server.
* **Positional Syncing**: Playback syncs faster and more reliably when changing devices.

### New Features & Enhancements

* **Device Info**: Clearer names and information for active audio output devices.
* **Music Streaming**: Faster connection handling when switching custom server accounts.
* **Dashboard Libraries**: Upgraded audio playing libraries under the hood for a smoother experience.

### Bug Fixes

* **Cover Art**: Fixed errors when retrieving album covers from the server.
* **Fullscreen Scroll**: Text and lyrics scroll smoothly in fullscreen mode.
* **Android Builds**: Resolved errors when building the Android app.