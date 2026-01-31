// Keyboard Shortcuts Plugin
// Adds global keyboard shortcuts for playback control

(function () {
    'use strict';

    const KeyboardShortcuts = {
        name: 'Keyboard Shortcuts',
        shortcuts: {
            'Space': 'togglePlay',
            'ArrowRight': 'next',
            'ArrowLeft': 'prev',
            'ArrowUp': 'volumeUp',
            'ArrowDown': 'volumeDown',
            'm': 'mute',
            'r': 'repeat',
            's': 'shuffle'
        },

        init(api) {
            console.log('[KeyboardShortcuts] Plugin initialized');
            this.api = api;
            this.boundHandler = this.handleKeydown.bind(this);
        },

        handleKeydown(e) {
            // Ignore if typing in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            const action = this.shortcuts[e.key];
            if (!action) return;

            e.preventDefault();
            this.executeAction(action);
        },

        async executeAction(action) {
            if (!this.api?.player) {
                console.warn('[KeyboardShortcuts] Player API not available');
                return;
            }

            try {
                switch (action) {
                    case 'togglePlay':
                        const isPlaying = await this.api.player.isPlaying?.();
                        if (isPlaying) {
                            await this.api.player.pause?.();
                        } else {
                            await this.api.player.play?.();
                        }
                        break;
                    case 'next':
                        await this.api.player.next?.();
                        break;
                    case 'prev':
                        await this.api.player.prev?.();
                        break;
                    case 'volumeUp':
                        console.log('[KeyboardShortcuts] Volume up');
                        break;
                    case 'volumeDown':
                        console.log('[KeyboardShortcuts] Volume down');
                        break;
                    case 'mute':
                        console.log('[KeyboardShortcuts] Toggle mute');
                        break;
                    default:
                        console.log(`[KeyboardShortcuts] Unknown action: ${action}`);
                }
            } catch (err) {
                console.error('[KeyboardShortcuts] Action failed:', err);
            }
        },

        start() {
            console.log('[KeyboardShortcuts] Plugin started');
            document.addEventListener('keydown', this.boundHandler);
            console.log('[KeyboardShortcuts] Shortcuts:', this.shortcuts);
        },

        stop() {
            console.log('[KeyboardShortcuts] Plugin stopped');
            document.removeEventListener('keydown', this.boundHandler);
        },

        destroy() {
            this.stop();
            console.log('[KeyboardShortcuts] Plugin destroyed');
        }
    };

    // Register plugin
    if (typeof Audion !== 'undefined' && Audion.register) {
        Audion.register(KeyboardShortcuts);
    } else {
        window.KeyboardShortcuts = KeyboardShortcuts;
        window.AudionPlugin = KeyboardShortcuts;
    }
})();
