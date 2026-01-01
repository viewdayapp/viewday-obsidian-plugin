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

        // /skip setence case check: Viewday is a proper noun (Name of a company) and should be capitalized
        this.addRibbonIcon('calendar-days', 'Open Viewday', () => {
            void this.activateView();
        });
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_VIEWDAY)[0];
        
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_VIEWDAY, active: true });
        }
        void workspace.revealLeaf(leaf);
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
    }

    async saveSettings() { 
        await this.saveData(this.settings); 
        
        this.app.workspace.getLeavesOfType(VIEW_TYPE_VIEWDAY).forEach((leaf) => {
            if (leaf.view instanceof ViewdayView) {
                void leaf.view.onOpen(); 
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
                void this.onOpen(); 
            })
        );
    }

    getViewType() { return VIEW_TYPE_VIEWDAY; }
    getDisplayText() { return "Viewday calendar"; }

    async onOpen(): Promise<void> {
        await Promise.resolve(); 

        const container = this.contentEl;
        container.empty();
        
        if (!this.settings.widgetId) {
            // /skip setence case check: Widget Id is a proper noun (Name of an entity) and should be capitalized
            container.createEl("h4", { text: 'Please set your "Widget Id" in settings.' });
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

        new Setting(containerEl)
            .setName('Google Calendar by Viewday')
            .setHeading();

        containerEl.createEl("p", {
            // /skip setence case check: Google Calendar is a proper noun (Name of a company), API is an abbreviation, Viewday is a proper noun (Name of a company), all should be capitalized
            text: "A real-time Google Calendar for Obsidian with multi-account sync, secure OAuth, and dark mode support. No manual API key setup required. Requires a Viewday account."
        });

        new Setting(containerEl)
            .setName('Setup instructions')
            .setHeading();

        containerEl.createEl('p', { 
            // /skip setence case check: Google Calendar and Obsidian are proper nouns (Names of a product/company) and should be capitalized
            text: 'Connect your Google Calendar to Obsidian by following these simple steps:' 
        });
        
        const steps = containerEl.createEl('ol');
        const step1 = steps.createEl('li', { text: 'Sign up at ' });
        step1.createEl('a', { text: 'Viewday', href: 'https://viewday.app/signup' });
        step1.appendText('.');
        // /skip setence case check: Google is a proper noun (Name of a product/company) and should be capitalized
        steps.createEl('li', { text: 'Connect your Google accounts.' });
        steps.createEl('li', { text: 'Create a calendar widget.' });
        // /skip setence case check: Obsidian is a proper noun (Name of a product/company) and should be capitalized
        steps.createEl('li', { text: 'Select the calendars you want to see in Obsidian.' });
        // /skip setence case check: Obsidian is a proper noun (Name of a product/company) and should be capitalized
        steps.createEl('li', { text: 'Copy the "Obsidian Widget Id".' });

        new Setting(containerEl)
            .setName('Widget Id')
            // /skip setence case check: Obsidian Widget Id an identity field shown in Viewday product and it should be exactly as shown
            .setDesc('Enter the "Obsidian Widget Id" from your Viewday dashboard and hit enter')
            .addText(text => text
                .setPlaceholder('Paste ID here...')
                .setValue(this.plugin.settings.widgetId)
                .onChange((value) => {
                    this.plugin.settings.widgetId = value;
                    void this.plugin.saveSettings().then(() => {
                        refreshSuccessMessage(value);
                    });
                }));

        const successContainer = containerEl.createDiv();
        
        const refreshSuccessMessage = (id: string) => {
            successContainer.empty();
            if (id && id.length > 0) {
                successContainer.addClass('viewday-success-container');

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

        const linkContainer = containerEl.createDiv('viewday-link-container');

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