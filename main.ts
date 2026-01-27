import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, setIcon, Notice, TFile, debounce } from 'obsidian';

// --- TYPES ---
interface LocalRule {
    id: string;
    name: string;     // Friendly label (e.g. "Deadlines")
    property: string; // The actual key (e.g. "do_date")
    color: string;
    active: boolean;
}

interface ViewdaySettings {
    widgetId: string;
    meetingNoteFolder: string;
    localRules: LocalRule[];
}

const DEFAULT_SETTINGS: ViewdaySettings = {
    widgetId: '',
    meetingNoteFolder: 'Meeting Notes',
    localRules: []
}

export const VIEW_TYPE_VIEWDAY = "viewday-google-calendar";

export default class ViewdayPlugin extends Plugin {
    settings: ViewdaySettings;
    view: ViewdayView | null = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new ViewdaySettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE_VIEWDAY,
            (leaf) => (this.view = new ViewdayView(leaf, this.settings, this))
        );

        this.addRibbonIcon('calendar-days', 'Open Viewday', () => {
            void this.activateView();
        });

        // REGISTER LISTENER: Listen for messages from the iframe
        this.registerDomEvent(window, 'message', (event) => {
            void this.handleMessage(event);
        });

        // --- ENGINE: LISTEN FOR VAULT CHANGES ---
        // Debounce to prevent freezing during rapid typing
        const requestSync = debounce(this.pushLocalEvents.bind(this), 1000, true);

        // Listen for frontmatter changes
        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            requestSync();
        }));

        // Listen for file renames/deletes
        this.registerEvent(this.app.vault.on('rename', requestSync));
        this.registerEvent(this.app.vault.on('delete', requestSync));
    }

    // --- ENGINE: SCAN & PUSH ---
    async pushLocalEvents() {
        // If no view is open or no rules exist, skip
        if (!this.view || !this.settings.localRules.length) return;

        const events: any[] = [];
        const files = this.app.vault.getMarkdownFiles();

        // 1. Scan every file in the vault
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) continue;

            // 2. Check against all active rules (synced from dashboard)
            for (const rule of this.settings.localRules) {
                if (!rule.active) continue;

                const dateVal = cache.frontmatter[rule.property];
                // Check for duration (minutes)
                let durationVal = cache.frontmatter['duration_minutes'];
                if (!durationVal) durationVal = cache.frontmatter['duration']; // Fallback

                if (dateVal) {
                    // Check if it's All Day (YYYY-MM-DD) or Timed (YYYY-MM-DDTHH:mm)
                    const isAllDay = typeof dateVal === 'string' && !dateVal.includes('T');
                    let endVal = undefined;

                    // Calculate End Time if not all-day and we have duration
                    if (!isAllDay && durationVal) {
                        const startMs = Date.parse(dateVal);
                        const durMin = Number(durationVal);
                        if (!isNaN(startMs) && !isNaN(durMin) && durMin > 0) {
                            // Calculate end time while preserving local-time concept (avoid UTC shifts if possible)
                            // We construct a new ISO string manually to ensure consistency
                            const addMinutesToIso = (iso: string, minutes: number) => {
                                const [d, t] = iso.split('T');
                                if (!d || !t) return undefined;
                                const [y, m, day] = d.split('-').map(Number);
                                const [hr, min] = t.split(':').map(Number);
                                const date = new Date(y, m - 1, day, hr, min + minutes);
                                const ny = date.getFullYear();
                                const nm = String(date.getMonth() + 1).padStart(2, '0');
                                const nd = String(date.getDate()).padStart(2, '0');
                                const nh = String(date.getHours()).padStart(2, '0');
                                const nmn = String(date.getMinutes()).padStart(2, '0');
                                return `${ny}-${nm}-${nd}T${nh}:${nmn}`;
                            }
                            endVal = addMinutesToIso(dateVal, durMin);
                        }
                    }

                    events.push({
                        id: `local::${file.path}::${rule.id}`, // Unique ID combination
                        title: file.basename,
                        start: dateVal,
                        end: endVal,
                        allDay: isAllDay,
                        backgroundColor: rule.color,
                        borderColor: rule.color,
                        // Pass data needed for Drag & Drop and Click handling
                        extendedProps: {
                            type: 'local',
                            path: file.path,
                            ruleId: rule.id,
                            property: rule.property
                        }
                    });
                }
            }
        }

        // 3. Send payload to Iframe
        this.view.postMessage({
            type: 'SYNC_LOCAL_EVENTS',
            events: events,
            // We verify rules via the dashboard, but we send them back to confirm 'Active' state
            sources: this.settings.localRules
        });
    }

    async handleMessage(event: MessageEvent) {
        // SECURITY: Only accept messages from your domain or localhost
        if (event.origin !== "https://viewday.app" && event.origin !== "http://localhost:3000") return;

        const { type, eventData, localPath, payload, rules } = event.data;

        // ACTION: Sync Configuration (FROM Dashboard TO Plugin)
        // When the dashboard loads, it tells the plugin what rules to use
        if (type === 'CONFIGURE_RULES' && rules) {
            this.settings.localRules = rules;

            // FIXED: Use saveData instead of saveSettings. 
            // saveSettings() triggers onOpen() which reloads the iframe, causing an infinite loop.
            await this.saveData(this.settings);

            await this.pushLocalEvents(); // Trigger immediate scan with new rules
        }

        // ACTION: Update Local Event (Drag & Drop)
        if (type === 'UPDATE_LOCAL_EVENT' && payload) {
            await this.updateLocalEvent(payload);
        }

        // ACTION: Create Meeting Note (Google Event -> Markdown)
        if (type === 'create-meeting-note' && eventData) {
            await this.createMeetingNote(eventData);
        }

        // ACTION: Open Local Note (Clicking a local event)
        if (type === 'open-local-file' && localPath) {
            const file = this.app.vault.getAbstractFileByPath(localPath);
            if (file instanceof TFile) {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(file);
            } else {
                new Notice(`Could not find file: ${localPath}`);
            }
        }

        // ACTION: Iframe Ready
        if (type === 'viewday-ready') {
            await this.pushLocalEvents();
        }

        // ACTION: Create Local Note (From Quick Create Modal)
        if (type === 'CREATE_LOCAL_NOTE' && payload) {
            await this.createLocalNote(payload);
        }
    }

    async createLocalNote(payload: any) {
        const { title, frontmatter, folder } = payload;

        // 1. Sanitize Filename
        const safeTitle = (title || 'Untitled').replace(/[\\/:*?"<>|]/g, "");
        let fileName = `${safeTitle}.md`;

        // 2. Determine Folder (Priority: Payload -> Root)
        // We default to Root ("") to act as a generic Inbox. 
        let folderPath = folder || "";

        let filePath = folderPath ? `${folderPath}/${fileName}` : fileName;

        try {
            // 3. Ensure folder exists (if specific folder requested)
            if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
                await this.app.vault.createFolder(folderPath);
            }

            // 4. Handle Duplicate Filenames (Increment: Untitled 1.md)
            let fileExists = this.app.vault.getAbstractFileByPath(filePath);
            let i = 1;
            while (fileExists) {
                fileName = `${safeTitle} (${i}).md`;
                filePath = folderPath ? `${folderPath}/${fileName}` : fileName;
                fileExists = this.app.vault.getAbstractFileByPath(filePath);
                i++;
            }

            // 5. Construct File Content (YAML + Body)
            // We use a simple YAML block based on the payload
            const yamlLines = ['---'];
            if (frontmatter) {
                for (const [key, value] of Object.entries(frontmatter)) {
                    if (value !== undefined && value !== null) {
                        yamlLines.push(`${key}: ${value}`);
                    }
                }
            }
            yamlLines.push('---');
            yamlLines.push('');
            yamlLines.push(`# ${title}`); // H1 Title
            yamlLines.push('');

            const fileContent = yamlLines.join('\n');

            // 6. Create & Open
            const newFile = await this.app.vault.create(filePath, fileContent);

            // Open in new leaf (or active leaf if empty)
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(newFile);

            new Notice(`Created: ${fileName}`);

        } catch (error) {
            console.error("Viewday: Failed to create local note", error);
            new Notice("Viewday: Failed to create note.");
        }
    }

    // --- WRITE BACK TO FILE (The Kill Shot Logic) ---
    async updateLocalEvent(payload: any) {
        const { path, property, newValue } = payload;

        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            try {
                // Safely update frontmatter using Obsidian API
                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    frontmatter[property] = newValue;
                });
                new Notice(`Rescheduled: ${file.basename}`);
            } catch (err) {
                console.error("Viewday: Failed to update file", err);
                new Notice("Viewday: Failed to update event date.");
            }
        }
    }

    async createMeetingNote(data: any) {
        const escapeYaml = (text: string) => (text || '').replace(/"/g, '\\"');
        const { title, date, time, location, meetingLink, organizer, attendees, description, attachments, gcalLink } = data;

        const safeTitle = (title || 'Untitled Event').replace(/[\\/:*?"<>|]/g, "");
        const fileName = `${date} - ${safeTitle}.md`;
        const folderPath = this.settings.meetingNoteFolder;
        const filePath = `${folderPath}/${fileName}`;

        try {
            if (!this.app.vault.getAbstractFileByPath(folderPath)) {
                await this.app.vault.createFolder(folderPath);
            }

            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile instanceof TFile) {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(existingFile);
                new Notice(`Opened existing note: ${fileName}`);
                return;
            }

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

            if (meetingLink) fileContent += `[Join Meeting](${meetingLink})\n\n`;
            fileContent += `## Agenda\n${description || 'No agenda provided.'}\n\n`;

            if (attachments && attachments.length > 0) {
                fileContent += `## Attachments\n`;
                attachments.forEach((att: any) => {
                    if (att.url) fileContent += `- [${att.title}](${att.url})\n`;
                });
                fileContent += `\n`;
            }

            fileContent += `## Notes\n- \n`;

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
        // Trigger a push whenever settings are saved (though mostly managed by iframe now)
        await this.pushLocalEvents();

        this.app.workspace.getLeavesOfType(VIEW_TYPE_VIEWDAY).forEach((leaf) => {
            if (leaf.view instanceof ViewdayView) {
                void leaf.view.onOpen();
            }
        });
    }
}

class ViewdayView extends ItemView {
    settings: ViewdaySettings;
    plugin: ViewdayPlugin;
    icon = "calendar-days";
    frame: HTMLIFrameElement | null = null;

    constructor(leaf: WorkspaceLeaf, settings: ViewdaySettings, plugin: ViewdayPlugin) {
        super(leaf);
        this.settings = settings;
        this.plugin = plugin;

        this.registerEvent(
            this.app.workspace.on('css-change', () => {
                void this.onOpen();
            })
        );
    }

    getViewType() { return VIEW_TYPE_VIEWDAY; }
    getDisplayText() { return "Viewday calendar"; }

    postMessage(msg: any) {
        if (this.frame && this.frame.contentWindow) {
            this.frame.contentWindow.postMessage(msg, '*');
        }
    }

    async onOpen(): Promise<void> {
        await Promise.resolve();

        const container = this.contentEl;
        container.empty();

        if (!this.settings.widgetId) {
            container.createEl("h4", { text: 'Please set your "Widget Id" in settings.' });
            return;
        }

        const isDark = document.body.classList.contains('theme-dark');

        this.frame = container.createEl("iframe", {
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

        // 1. HEADER
        const headerSetting = new Setting(containerEl)
            .setName('Google Calendar by Viewday')
            .setDesc("A real-time Google Calendar for Obsidian with multi-account sync.");

        headerSetting.nameEl.style.fontSize = '1.2em';
        headerSetting.nameEl.style.fontWeight = 'bold';

        // 2. WIDGET ID
        new Setting(containerEl)
            .setName('Widget Id')
            .setDesc('Enter the "Obsidian ID" from your Viewday dashboard.')
            .addText(text => text
                .setPlaceholder('Paste ID here...')
                .setValue(this.plugin.settings.widgetId)
                .onChange((value) => {
                    this.plugin.settings.widgetId = value;
                    void this.plugin.saveSettings().then(() => {
                        refreshSuccessMessage(value);
                    });
                }));

        // 3. NOTE FOLDER
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

        // 4. LOCAL SOURCES (Read Only)
        // We now direct users to the dashboard instead of editing here
        containerEl.createEl('h3', { text: 'Local Sources', cls: 'viewday-section-header' });

        const desc = containerEl.createDiv();
        desc.style.color = 'var(--text-muted)';
        desc.style.fontSize = '0.9em';
        desc.style.marginBottom = '12px';
        desc.createSpan({ text: 'Visualize tasks and notes from your vault on the calendar. ' });
        desc.createSpan({ text: 'Configuration is managed in your ' });
        desc.createEl('a', { text: 'Viewday Dashboard', href: 'https://viewday.app/dashboard?tab=sources' });
        desc.createSpan({ text: '.' });

        if (this.plugin.settings.localRules.length > 0) {
            const list = containerEl.createEl('div');
            list.style.background = 'var(--background-secondary)';
            list.style.padding = '10px';
            list.style.borderRadius = '8px';
            list.style.border = '1px solid var(--background-modifier-border)';

            list.createDiv({ text: 'Active Rules:', style: 'font-weight:bold; margin-bottom: 8px; font-size: 0.8em; text-transform: uppercase; color: var(--text-faint);' });

            this.plugin.settings.localRules.forEach(rule => {
                const item = list.createDiv();
                item.style.display = 'flex';
                item.style.alignItems = 'center';
                item.style.gap = '10px';
                item.style.marginBottom = '6px';

                const dot = item.createSpan();
                dot.style.width = '8px';
                dot.style.height = '8px';
                dot.style.borderRadius = '50%';
                dot.style.backgroundColor = rule.color;

                const text = item.createSpan();
                text.innerText = `${rule.name} (property: ${rule.property})`;
                text.style.fontSize = '0.9em';
            });
        } else {
            const empty = containerEl.createDiv();
            empty.style.padding = '10px';
            empty.style.border = '1px dashed var(--background-modifier-border)';
            empty.style.borderRadius = '8px';
            empty.style.textAlign = 'center';
            empty.style.color = 'var(--text-muted)';
            empty.innerText = "No local rules configured yet.";
        }

        // 5. SUCCESS MESSAGE
        const successContainer = containerEl.createDiv();
        const refreshSuccessMessage = (id: string) => {
            successContainer.empty();
            if (id && id.length > 0) {
                successContainer.style.marginTop = '20px';
                successContainer.addClass('viewday-success-container');

                successContainer.createSpan({ text: "All set! Click the calendar icon" });
                const iconSpan = successContainer.createSpan();
                setIcon(iconSpan, "calendar-days");
                successContainer.createSpan({ text: "in your sidebar to view your schedule." });
            }
        };
        refreshSuccessMessage(this.plugin.settings.widgetId);

        // 6. FOOTER LINKS
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