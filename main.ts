import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, setIcon, Notice, TFile } from 'obsidian';

interface ViewdaySettings {
    widgetId: string;
    meetingNoteFolder: string; // New setting for folder path
}

const DEFAULT_SETTINGS: ViewdaySettings = {
    widgetId: '',
    meetingNoteFolder: 'Meeting Notes'
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

        // REGISTER LISTENER: Listen for messages from the iframe
        this.registerDomEvent(window, 'message', (event) => {
            void this.handleMessage(event);
        });
    }

    async handleMessage(event: MessageEvent) {
        // SECURITY: Only accept messages from your domain
        if (event.origin !== "https://viewday.app" && event.origin !== "http://localhost:3000") return;

        // Check for specific action type
        if (event.data.type === 'create-meeting-note' && event.data.eventData) {
            await this.createMeetingNote(event.data.eventData);
        }
    }

    async createMeetingNote(data: any) {
        // Helper to escape double quotes for YAML strings
        const escapeYaml = (text: string) => (text || '').replace(/"/g, '\\"');
        // Destructure all the new fields
        const { title, date, time, location, meetingLink, organizer, attendees, description, attachments, gcalLink } = data;
        
        // 1. Sanitize filename
        const safeTitle = (title || 'Untitled Event').replace(/[\\/:*?"<>|]/g, "");
        const fileName = `${date} - ${safeTitle}.md`;
        const folderPath = this.settings.meetingNoteFolder;
        const filePath = `${folderPath}/${fileName}`;

        try {
            // 2. Ensure folder exists
            if (!this.app.vault.getAbstractFileByPath(folderPath)) {
                await this.app.vault.createFolder(folderPath);
            }

            // 3. Check if file exists
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile instanceof TFile) {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(existingFile);
                new Notice(`Opened existing note: ${fileName}`);
                return;
            }

            // 4. Build Rich Content
            // We use YAML frontmatter for metadata, which is standard in Obsidian
            let fileContent = `---
date: ${date}
time: ${time}
location: "${escapeYaml(location)}"
organizer: "${escapeYaml(organizer)}"
meeting_link: "${meetingLink || ''}"
google_cal_link: "${gcalLink || ''}"
attendees: [${attendees ? attendees.map((a: string) => `"${escapeYaml(a)}"`).join(', ') : ''}]
tags: [meeting]
---
# ${title}

`;

            // Add Meeting Link Button-like text if exists
            if (meetingLink) {
                fileContent += `[Join Meeting](${meetingLink})\n\n`;
            }

            fileContent += `## Agenda\n${description || 'No agenda provided.'}\n\n`;
            
            // Add Attachments Section if they exist
            if (attachments && attachments.length > 0) {
                fileContent += `## Attachments\n`;
                attachments.forEach((att: any) => {
                    if (att.url) {
                        fileContent += `- [${att.title}](${att.url})\n`;
                    }
                });
                fileContent += `\n`;
            }

            fileContent += `## Notes\n- \n`;

            // 5. Create and Open
            const newFile = await this.app.vault.create(filePath, fileContent);
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(newFile);
            new Notice(`Created meeting note: ${fileName}`);

        } catch (error) {
            console.error("Viewday: Failed to create note", error);
            new Notice("Viewday: Failed to create meeting note.");
        }
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

        // 1. HEADER & INTRO
        // Using a Setting component ensures the text aligns exactly with the boxes below
        const headerSetting = new Setting(containerEl)
            .setName('Google Calendar by Viewday')
            .setDesc("A real-time Google Calendar for Obsidian with multi-account sync, secure OAuth, and dark mode support. No manual API key setup required. Requires a Viewday account.");
        
        // CSS tweak to make the name look like a header (larger/bold) without the default padding issues
        headerSetting.nameEl.style.fontSize = '1.2em';
        headerSetting.nameEl.style.fontWeight = 'bold';
        headerSetting.nameEl.style.marginBottom = '8px';
        headerSetting.descEl.style.color = 'var(--text-normal)'; // Make description readable


        // 2. SETUP INSTRUCTIONS
        const setupSetting = new Setting(containerEl)
            .setName('Setup instructions')
            .setDesc('Connect your Google Calendar to Obsidian by following these simple steps:');
        
        setupSetting.nameEl.style.fontSize = '1.1em';
        setupSetting.nameEl.style.fontWeight = 'bold';
        setupSetting.nameEl.style.marginTop = '20px';
        setupSetting.nameEl.style.marginBottom = '8px';

        // 3. ORDERED LIST
        // We append the list directly to the description container of the previous setting
        // This keeps it inside the aligned "box" of the setting layout
        const listContainer = setupSetting.descEl.createEl('ol');
        listContainer.style.marginTop = '8px';
        listContainer.style.paddingLeft = '20px'; // Standard list indent

        const step1 = listContainer.createEl('li', { text: 'Sign up at ' });
        step1.createEl('a', { text: 'Viewday', href: 'https://viewday.app/signup' });
        step1.appendText('.');
        listContainer.createEl('li', { text: 'Connect your Google accounts.' });
        listContainer.createEl('li', { text: 'Create a calendar widget.' });
        listContainer.createEl('li', { text: 'Select the calendars you want to see in Obsidian.' });
        listContainer.createEl('li', { text: 'Copy the "Obsidian ID".' });


        // 4. WIDGET ID SETTING (Standard)
        new Setting(containerEl)
            .setName('Widget Id')
            .setDesc('Enter the "Obsidian ID" from your Viewday dashboard and hit enter')
            .addText(text => text
                .setPlaceholder('Paste ID here...')
                .setValue(this.plugin.settings.widgetId)
                .onChange((value) => {
                    this.plugin.settings.widgetId = value;
                    void this.plugin.saveSettings().then(() => {
                        refreshSuccessMessage(value);
                    });
                }));

        // 5. FOLDER SETTING (Standard)
        new Setting(containerEl)
            .setName('Meeting notes folder')
            .setDesc('Where should new meeting notes be created?')
            .addText(text => text
                .setPlaceholder('Meeting Notes')
                .setValue(this.plugin.settings.meetingNoteFolder)
                .onChange((value) => {
                    this.plugin.settings.meetingNoteFolder = value;
                    void this.plugin.saveSettings();
                }));

        // 6. SUCCESS MESSAGE
        const successContainer = containerEl.createDiv();
        const refreshSuccessMessage = (id: string) => {
            successContainer.empty();
            if (id && id.length > 0) {
                // Add some top margin to separate from settings
                successContainer.style.marginTop = '20px';
                successContainer.addClass('viewday-success-container');

                successContainer.createSpan({ text: "All set! Click the calendar icon" });
                const iconSpan = successContainer.createSpan();
                setIcon(iconSpan, "calendar-days");
                successContainer.createSpan({ text: "in your sidebar to view your schedule." });
            }
        };
        refreshSuccessMessage(this.plugin.settings.widgetId);

        // 7. FOOTER LINKS
        const linkContainer = containerEl.createDiv('viewday-link-container');
        linkContainer.style.marginTop = '40px';
        linkContainer.style.borderTop = '1px solid var(--background-modifier-border)';
        linkContainer.style.paddingTop = '20px';

        const createLink = (text: string, href: string) => {
            const a = linkContainer.createEl('a', { text, href });
            a.style.display = 'block';
            a.style.marginBottom = '8px';
            a.style.color = 'var(--text-muted)';
            a.style.fontSize = '0.9em';
        };

        createLink('Go to Viewday dashboard ↗', 'https://viewday.app/dashboard');
        createLink('Request a feature ↗', 'https://viewday.app/feature-requests');
        createLink('Need help? Contact us ↗', 'https://viewday.app/contact');
    }
}