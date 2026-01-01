import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, setIcon } from 'obsidian';

interface ViewdaySettings {
    widgetId: string;
}

const DEFAULT_SETTINGS: ViewdaySettings = {
    widgetId: ''
}

export const VIEW_TYPE_VIEWDAY = "viewday-google-calendar";

export default class ViewdayPlugin extends Plugin {
    settings: ViewdaySettings;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new ViewdaySettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE_VIEWDAY,
            (leaf) => new ViewdayView(leaf, this.settings)
        );

        this.addRibbonIcon('calendar-days', 'Open Viewday', () => {
            this.activateView();
        });
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_VIEWDAY)[0];
        
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_VIEWDAY, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
    }

    async saveSettings() { 
        await this.saveData(this.settings); 
        
        this.app.workspace.getLeavesOfType(VIEW_TYPE_VIEWDAY).forEach((leaf) => {
            if (leaf.view instanceof ViewdayView) {
                leaf.view.onOpen(); 
            }
        });
    }
}

class ViewdayView extends ItemView {
    settings: ViewdaySettings;
    icon = "calendar-days";

    constructor(leaf: WorkspaceLeaf, settings: ViewdaySettings) {
        super(leaf);
        this.settings = settings;

        this.registerEvent(
            this.app.workspace.on('css-change', () => {
                this.onOpen(); 
            })
        );
    }

    getViewType() { return VIEW_TYPE_VIEWDAY; }
    getDisplayText() { return "Viewday Calendar"; }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        
        if (!this.settings.widgetId) {
            container.createEl("h4", { text: "Please set your Widget ID in settings." });
            return;
        }

        const isDark = document.body.classList.contains('theme-dark');
        
        container.createEl("iframe", {
            attr: {
                src: `https://viewday.app/embed/${this.settings.widgetId}?platform=obsidian&theme=${isDark ? 'dark' : 'light'}`,
                style: "width: 100%; height: 100%; border: none;",
                sandbox: "allow-scripts allow-same-origin allow-popups"
            }
        });
    }
}

class ViewdaySettingTab extends PluginSettingTab {
    plugin: ViewdayPlugin;
    constructor(app: App, plugin: ViewdayPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h1', { text: 'Google Calendar by Viewday' });

        containerEl.createEl("p", {
            text: "A real-time Google Calendar for Obsidian with multi-account sync, secure OAuth, and dark mode support. No manual API key setup required. Requires a Viewday account."
        });

        containerEl.createEl('h2', { text: 'Setup Instructions' });

        containerEl.createEl('p', { 
            text: 'Connect your Google Calendar to Obsidian by follow these simple steps:' 
        });
        
        const steps = containerEl.createEl('ol');
        const step1 = steps.createEl('li', { text: 'Sign up at ' });
        step1.createEl('a', { text: 'Viewday', href: 'https://viewday.app/signup' });
        step1.appendText('.');
        steps.createEl('li', { text: 'Connect your Google accounts.' });
        steps.createEl('li', { text: 'Create a calendar widget' });
        steps.createEl('li', { text: 'Select the calendars you want to see in Obsidian' });
        steps.createEl('li', { text: 'Copy the "Obsidian Widget ID"' });

        new Setting(containerEl)
            .setName('Widget ID')
            .setDesc('Enter the Obsidian Widget ID from your Viewday dashboard and hit Enter')
            .addText(text => text
                .setPlaceholder('Paste ID here...')
                .setValue(this.plugin.settings.widgetId)
                .onChange(async (value) => {
                    this.plugin.settings.widgetId = value;
                    await this.plugin.saveSettings();
                    refreshSuccessMessage(value);
                }));

        const successContainer = containerEl.createDiv();
        
        const refreshSuccessMessage = (id: string) => {
            successContainer.empty();
            if (id && id.length > 0) {
                successContainer.style.marginTop = "15px";
                successContainer.style.display = "flex";
                successContainer.style.alignItems = "center";
                successContainer.style.gap = "5px";

                successContainer.createSpan({ 
                    text: "All set! Click the calendar icon"
                });

                const iconSpan = successContainer.createSpan();
                setIcon(iconSpan, "calendar-days");

                successContainer.createSpan({ 
                    text: "in your sidebar to view your schedule." 
                });
            }
        };

        refreshSuccessMessage(this.plugin.settings.widgetId);

        const linkContainer = containerEl.createDiv({ cls: 'viewday-links' });
        linkContainer.style.marginTop = '20px';
        linkContainer.style.display = 'flex';
        linkContainer.style.flexDirection = 'column';
        linkContainer.style.gap = '10px';

        linkContainer.createEl('a', { 
            text: 'Go to Viewday dashboard ↗', 
            href: 'https://viewday.app/dashboard' 
        });

        linkContainer.createEl('a', { 
            text: 'Request a feature ↗', 
            href: 'https://viewday.app/feature-requests' 
        });

        linkContainer.createEl('a', { 
            text: 'Need help? Contact us ↗', 
            href: 'https://viewday.app/contact' 
        });
        
    }
}