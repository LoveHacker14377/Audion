// UI Slot system for plugins
// Provides formal extension points in the UI

export type UISlotName = 'playerbar:left' | 'playerbar:right' | 'sidebar:top' | 'sidebar:bottom' | 'playerbar:menu';

export interface UISlotContent {
    pluginName: string;
    element: HTMLElement;
    priority: number; // Lower numbers = higher priority (appear first)
}

export class UISlotManager {
    private slots: Map<UISlotName, UISlotContent[]> = new Map();
    private containers: Map<UISlotName, HTMLElement> = new Map();

    /**
     * Register a slot container element in the DOM
     */
    registerContainer(slotName: UISlotName, container: HTMLElement): void {
        this.containers.set(slotName, container);

        // Ensure shadow root exists for the container
        if (!container.shadowRoot) {
            container.attachShadow({ mode: 'open' });

            // Inject a style tag to forward CSS variables
            this.injectSharedStyles(container.shadowRoot!);
        }

        // Render any pending content
        this.renderSlot(slotName);
    }

    /**
     * Unregister a slot container
     */
    unregisterContainer(slotName: UISlotName): void {
        this.containers.delete(slotName);
    }

    /**
     * Add plugin content to a slot
     */
    addContent(slotName: UISlotName, content: UISlotContent): void {
        if (!this.slots.has(slotName)) {
            this.slots.set(slotName, []);
        }

        const slotContents = this.slots.get(slotName)!;

        // Check if plugin already has content in this slot
        const existingIndex = slotContents.findIndex(c => c.pluginName === content.pluginName);
        if (existingIndex >= 0) {
            // Replace existing content
            slotContents[existingIndex] = content;
        } else {
            // Add new content
            slotContents.push(content);
        }

        // Sort by priority
        slotContents.sort((a, b) => a.priority - b.priority);

        // Re-render the slot
        this.renderSlot(slotName);
    }

    /**
     * Remove plugin content from a slot
     */
    removeContent(slotName: UISlotName, pluginName: string): void {
        const slotContents = this.slots.get(slotName);
        if (!slotContents) return;

        const filtered = slotContents.filter(c => c.pluginName !== pluginName);
        this.slots.set(slotName, filtered);

        this.renderSlot(slotName);
    }

    /**
     * Remove all content from a plugin across all slots
     */
    removePluginContent(pluginName: string): void {
        this.slots.forEach((contents, slotName) => {
            const filtered = contents.filter(c => c.pluginName !== pluginName);
            this.slots.set(slotName, filtered);
            this.renderSlot(slotName);
        });
    }

    /**
     * Render a slot's content into its container
     */
    private renderSlot(slotName: UISlotName): void {
        const container = this.containers.get(slotName);
        if (!container || !container.shadowRoot) return;

        const contents = this.slots.get(slotName) || [];

        // Clear existing content in shadow root
        // We keep the style tag (first child)
        while (container.shadowRoot.childNodes.length > 1) {
            container.shadowRoot.removeChild(container.shadowRoot.lastChild!);
        }

        // Add all content elements
        contents.forEach(content => {
            container.shadowRoot!.appendChild(content.element);
        });
    }

    /**
     * Inject shared styles into shadow root (themes, variables)
     */
    private injectSharedStyles(shadow: ShadowRoot): void {
        const style = document.createElement('style');
        style.id = 'audion-shared-styles';

        // Forward essential CSS variables for plugins to follow theme
        style.textContent = `
            :host {
                display: flex;
                flex-direction: column;
                gap: 2px;
                --text-primary: var(--text-primary);
                --text-secondary: var(--text-secondary);
                --text-subdued: var(--text-subdued);
                --bg-primary: var(--bg-primary);
                --bg-surface: var(--bg-surface);
                --bg-highlight: var(--bg-highlight);
                --accent-color: var(--accent-color);
                --border-color: var(--border-color);
                --radius-sm: var(--radius-sm);
                --radius-md: var(--radius-md);
                --spacing-sm: var(--spacing-sm);
                --spacing-xs: var(--spacing-xs);
                --transition-fast: var(--transition-fast);
            }
            
            /* Target direct children - premium menu item layout */
            :host > *:not(style) {
                width: 100%;
                box-sizing: border-box;
                text-align: left;
                padding: 10px 12px;
                border-radius: var(--radius-sm);
                background: transparent;
                border: none;
                color: var(--text-secondary);
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 12px;
                font-size: 0.875rem;
                font-weight: 500;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                font-family: inherit;
                text-decoration: none;
                line-height: 1.2;
                transform: translateX(0);
            }

            :host > *:not(style):hover {
                background-color: var(--bg-highlight);
                color: var(--text-primary);
                transform: translateX(4px);
            }

            /* Sleek, constrained icons */
            svg, img, i {
                width: 16px !important;
                height: 16px !important;
                min-width: 16px !important;
                min-height: 16px !important;
                flex-shrink: 0;
                display: block;
                object-fit: contain;
                opacity: 0.8;
                transition: opacity var(--transition-fast);
            }

            :host > *:not(style):hover svg,
            :host > *:not(style):hover img {
                opacity: 1;
            }

            /* Reset for images */
            img {
                border-radius: 2px;
            }
        `;

        shadow.appendChild(style);
    }

    /**
     * Get all content for a slot
     */
    getSlotContent(slotName: UISlotName): UISlotContent[] {
        return this.slots.get(slotName) || [];
    }

    /**
     * Get container element for a slot
     */
    getContainer(slotName: UISlotName): HTMLElement | undefined {
        return this.containers.get(slotName);
    }

    /**
 * Get all slot names that have content
 */
    getAllSlots(): UISlotName[] {
        return Array.from(this.slots.keys());
    }

    /**
     * Clear all slots and containers (for complete cleanup)
     */
    clearAll(): void {
        this.slots.clear();
        this.containers.forEach(container => {
            container.innerHTML = '';
        });
    }
}

// Global singleton
export const uiSlotManager = new UISlotManager();
