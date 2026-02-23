import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, setIcon, Notice, TFile, debounce, Platform, FuzzySuggestModal } from 'obsidian';

// --- TYPES ---
interface LocalRule {
    id: string;
    name: string;     // Friendly label (e.g. "Deadlines")
    property: string; // The actual key (e.g. "do_date")
    color: string;
    active: boolean;
    folder_path?: string;
    path?: string;
    folder?: string;
}

interface ViewdaySettings {
    viewId: string;
    meetingNoteFolder: string;
    localRules: LocalRule[];
}

const DEFAULT_SETTINGS: ViewdaySettings = {
    viewId: '',
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
        const requestSync = debounce(() => {
            void this.pushLocalEvents();
            void this.pushLinkedNotes();
        }, 1000, true);

        // Listen for frontmatter changes
        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            requestSync();
        }));

        // Listen for file renames/deletes
        this.registerEvent(this.app.vault.on('rename', requestSync));
        this.registerEvent(this.app.vault.on('delete', requestSync));
    }

    // --- ENGINE: SCAN & PUSH ---
    // --- UNSCHEDULED: SCAN & PUSH ---
    async scanForUnscheduled(activeRules: any[]) {
        if (!this.view || !activeRules || !activeRules.length) {
            this.view?.postMessage({ type: 'UNSCHEDULED_RESULTS', items: [] });
            return;
        }

        const items: any[] = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const rule of activeRules) {
            // Note: Dashboard sets both folder_path (preferred) and path (fallback)
            const ruleFolder = rule.folder_path || rule.path || rule.folder || "";

            for (const file of files) {
                // Folder Filter
                if (ruleFolder && !file.path.startsWith(ruleFolder)) continue;

                const cache = this.app.metadataCache.getFileCache(file);
                const frontmatter = cache?.frontmatter || {};
                const property = rule.property;
                const val = frontmatter[property];

                // Logic:
                // 1. If no ruleFolder (Entire Vault): STRICT MODE. 
                //    - Must have the property key, but value must be missing/empty.
                // 2. If ruleFolder exists (Specific Folder): RELAXED MODE.
                //    - Include if the property is missing entirely OR if it has an empty value.
                //    - We STILL exclude it if it has a VALID date value (meaning it's scheduled).

                let isUnscheduled = false;

                if (!ruleFolder) {
                    // Strict Mode: Only show files that HAVE the key but NO value (e.g. "do_date: ")
                    if (val !== undefined && (val === null || val === '')) {
                        isUnscheduled = true;
                    }
                } else {
                    // Relaxed Mode: Property doesn't exist, OR it exists but has no value
                    // If val exists and is a non-empty string/date, it IS scheduled.
                    if (val === undefined || val === null || val === '') {
                        isUnscheduled = true;
                    }
                }

                if (isUnscheduled) {
                    // DURATION LOGIC
                    let durationVal = frontmatter['duration_minutes'];
                    if (!durationVal) durationVal = frontmatter['duration']; // Fallback

                    // Convert to number safely
                    const finalDuration = durationVal ? Number(durationVal) : undefined;

                    items.push({
                        path: file.path,
                        basename: file.basename,
                        folder: file.parent?.path || "",
                        sourceId: rule.id,
                        property: rule.property,
                        sourceColor: rule.color, // Pass color for UI
                        duration: finalDuration  // Send to frontend
                    });
                }
            }
        }

        // Deduplicate items based on path
        const uniqueItems = Array.from(new Map(items.map(item => [item.path, item])).values());

        this.view.postMessage({
            type: 'UNSCHEDULED_RESULTS',
            items: uniqueItems
        });
    }

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

                // Folder Filter
                const ruleFolder = rule.folder_path || rule.path || rule.folder || "";
                if (ruleFolder && !file.path.startsWith(ruleFolder)) continue;

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

    async pushLinkedNotes() {
        if (!this.view) return;

        const linkedNotes: Record<string, Array<{ path: string, basename: string }>> = {};
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const links = cache?.frontmatter?.['viewday_links'];

            if (links !== undefined && links !== null) {
                let eventIds: string[] = [];
                if (Array.isArray(links)) {
                    eventIds = links.map(String);
                } else {
                    eventIds = [String(links)];
                }

                for (const id of eventIds) {
                    if (!linkedNotes[id]) {
                        linkedNotes[id] = [];
                    }
                    linkedNotes[id].push({
                        path: file.path,
                        basename: file.basename
                    });
                }
            }
        }

        this.view.postMessage({
            type: 'SYNC_LINKED_NOTES',
            linkedNotes: linkedNotes
        });
    }

    async handleMessage(event: MessageEvent) {
        // SECURITY: Only accept messages from your domain or localhost
        if (event.origin !== "https://viewday.app" && event.origin !== "http://localhost:3000") return;

        const { type, eventData, localPath, payload, rules, sources } = event.data;

        // ACTION: Fetch Unscheduled Items
        if (type === 'FETCH_UNSCHEDULED' && sources) {
            // sources payload: [{ path: "Tasks", property: "do_date", color: "blue", id: "..." }, ...]
            await this.scanForUnscheduled(sources);
        }

        // ACTION: Sync Configuration (FROM Dashboard TO Plugin)
        // When the dashboard loads, it tells the plugin what rules to use
        if (type === 'CONFIGURE_RULES' && rules) {
            this.settings.localRules = rules;

            // FIXED: Use saveData instead of saveSettings. 
            // saveSettings() triggers onOpen() which reloads the iframe, causing an infinite loop.
            await this.saveData(this.settings);

            await this.pushLocalEvents(); // Trigger immediate scan with new rules
            await this.pushLinkedNotes();
        }

        // ACTION: Update Local Event (Drag & Drop)
        if (type === 'UPDATE_LOCAL_EVENT' && payload) {
            await this.updateLocalEvent(payload);
        }

        // ACTION: Update Note Date (from Unscheduled Drop) - Alias for UPDATE_LOCAL_EVENT
        // The plan mentioned UPDATE_NOTE_DATE, let's support it for clarity/future proofing
        if (type === 'UPDATE_NOTE_DATE' && payload) {
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

        // ACTION: Trigger Fuzzy Search
        if (type === 'TRIGGER_FUZZY_SEARCH' && event.data.eventId) {
            new LinkedNoteSuggester(this.app, this, event.data.eventId).open();
        }

        // ACTION: Unlink Document
        if (type === 'UNLINK_DOCUMENT' && event.data.eventId && event.data.path) {
            await this.unlinkDocument(event.data.path, event.data.eventId);
        }

        // ACTION: Iframe Ready
        if (type === 'viewday-ready') {
            await this.pushLocalEvents();
            await this.pushLinkedNotes();
        }

        // ACTION: Open External URL (Mobile Fix)
        if (type === 'OPEN_EXTERNAL_URL' && event.data.url) {
            window.open(event.data.url);
        }

        // ACTION: Create Local Note (From Quick Create Modal)
        if (type === 'CREATE_LOCAL_NOTE' && payload) {
            await this.createLocalNote(payload);
        }

        // ACTION: Open Daily / Weekly Periodic Note
        if (type === 'OPEN_PERIODIC_NOTE' && event.data.period && event.data.date) {
            await this.openPeriodicNote(event.data.period, event.data.date);
        }
    }

    async openPeriodicNote(period: 'daily' | 'weekly', date: string) {
        try {
            // --- Step 1: Read user settings from core plugins ---
            // Try Periodic Notes plugin first, fall back to core Daily Notes
            let folder = '';
            let format = '';

            if (period === 'daily') {
                // Try Periodic Notes plugin (community)
                const periodicNotes = (this.app as any).plugins?.getPlugin('periodic-notes');
                if (periodicNotes?.settings?.daily?.enabled) {
                    folder = periodicNotes.settings.daily.folder || '';
                    format = periodicNotes.settings.daily.format || 'YYYY-MM-DD';
                } else {
                    // Fallback: core Daily Notes plugin
                    const dailyNotes = (this.app as any).internalPlugins?.getPluginById('daily-notes');
                    folder = dailyNotes?.instance?.options?.folder || '';
                    format = dailyNotes?.instance?.options?.format || 'YYYY-MM-DD';
                }
                if (!format) format = 'YYYY-MM-DD';

                // --- Step 2: Format the filename using moment.js (bundled in Obsidian) ---
                const moment = (window as any).moment;
                if (!moment) { new Notice('Viewday: moment.js not available.'); return; }
                const noteName = moment(date, 'YYYY-MM-DD').format(format);
                const fileName = `${noteName}.md`;
                const filePath = folder ? `${folder}/${fileName}` : fileName;

                // --- Step 3: Find or create ---
                let file = this.app.vault.getAbstractFileByPath(filePath);
                if (!file) {
                    // Also try without extension (getFirstLinkpathDest)
                    file = this.app.metadataCache.getFirstLinkpathDest(noteName, '') || null;
                }

                if (file instanceof TFile) {
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(file);
                } else {
                    // Create it
                    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
                        await this.app.vault.createFolder(folder);
                    }
                    const newFile = await this.app.vault.create(filePath, '');
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(newFile);
                    new Notice(`Created daily note: ${fileName}`);
                }
            } else if (period === 'weekly') {
                // Try Periodic Notes plugin
                const periodicNotes = (this.app as any).plugins?.getPlugin('periodic-notes');
                if (periodicNotes?.settings?.weekly?.enabled) {
                    folder = periodicNotes.settings.weekly.folder || '';
                    format = periodicNotes.settings.weekly.format || 'gggg-[W]WW';
                } else {
                    // No native weekly note support in core — use a sensible default
                    folder = '';
                    format = 'gggg-[W]WW';
                }
                if (!format) format = 'gggg-[W]WW';

                const moment = (window as any).moment;
                if (!moment) { new Notice('Viewday: moment.js not available.'); return; }

                // date is in ISO format e.g. "2026-W08" — parse week number
                const [yearStr, weekStr] = date.split('-W');
                const weekMoment = moment().isoWeekYear(parseInt(yearStr)).isoWeek(parseInt(weekStr)).startOf('isoWeek');
                const noteName = weekMoment.format(format);
                const fileName = `${noteName}.md`;
                const filePath = folder ? `${folder}/${fileName}` : fileName;

                let file = this.app.vault.getAbstractFileByPath(filePath);
                if (!file) {
                    file = this.app.metadataCache.getFirstLinkpathDest(noteName, '') || null;
                }

                if (file instanceof TFile) {
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(file);
                } else {
                    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
                        await this.app.vault.createFolder(folder);
                    }
                    const newFile = await this.app.vault.create(filePath, '');
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(newFile);
                    new Notice(`Created weekly note: ${fileName}`);
                }
            }
        } catch (err) {
            console.error('Viewday: Failed to open periodic note', err);
            new Notice('Viewday: Could not open periodic note. Make sure the Daily Notes or Periodic Notes plugin is enabled.');
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
        const { path, property, newValue, duration } = payload;

        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            try {
                // Safely update frontmatter using Obsidian API
                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    if (newValue === null) {
                        frontmatter[property] = null;
                    } else {
                        frontmatter[property] = newValue;
                        if (duration !== undefined && duration !== null) {
                            frontmatter['duration_minutes'] = duration;
                        }
                    }
                });
                new Notice(`Rescheduled: ${file.basename}`);
            } catch (err) {
                console.error("Viewday: Failed to update file", err);
                new Notice("Viewday: Failed to update event date.");
            }
        }
    }

    async unlinkDocument(path: string, eventId: string) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            try {
                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    let links = frontmatter['viewday_links'];
                    if (Array.isArray(links)) {
                        frontmatter['viewday_links'] = links.filter((id: string) => id !== eventId);
                    } else if (links !== undefined && String(links) === eventId) {
                        frontmatter['viewday_links'] = [];
                    }
                });
                new Notice(`Unlinked note from event`);
            } catch (err) {
                console.error("Viewday: Failed to unlink note", err);
                new Notice("Viewday: Failed to unlink note.");
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
        await this.pushLinkedNotes();

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

        if (!this.settings.viewId) {
            container.createEl("h4", { text: 'Please set your "View Id" in settings.' });
            return;
        }

        const isDark = document.body.classList.contains('theme-dark');

        this.frame = container.createEl("iframe", {
            cls: 'viewday-iframe',
            attr: {
                src: `https://viewday.app/embed/${this.settings.viewId}?platform=obsidian&theme=${isDark ? 'dark' : 'light'}`,
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

        headerSetting.nameEl.addClass('viewday-settings-header-name');

        // 2. VIEW ID
        new Setting(containerEl)
            .setName('View Id')
            .setDesc('Enter the "View Id" from your Viewday dashboard.')
            .addText(text => text
                .setPlaceholder('Paste Id here...')
                .setValue(this.plugin.settings.viewId)
                .onChange((value) => {
                    this.plugin.settings.viewId = value;
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

        const desc = containerEl.createDiv({ cls: 'viewday-section-desc' });
        desc.createSpan({ text: 'Visualize tasks and notes from your vault on the calendar. ' });
        desc.createSpan({ text: 'Configuration is managed in your ' });
        desc.createEl('a', { text: 'Viewday Dashboard', href: 'https://viewday.app/dashboard?tab=sources' });
        desc.createSpan({ text: '.' });

        if (this.plugin.settings.localRules.length > 0) {
            const list = containerEl.createDiv({ cls: 'viewday-rules-list' });

            list.createDiv({ text: 'Active Rules:', cls: 'viewday-active-rules-header' });

            this.plugin.settings.localRules.forEach(rule => {
                const item = list.createDiv({ cls: 'viewday-rule-item' });

                const dot = item.createSpan({ cls: 'viewday-rule-dot' });
                dot.style.backgroundColor = rule.color; // dynamic per-rule color — cannot be a static CSS class

                const text = item.createSpan({ cls: 'viewday-rule-text' });
                const folderDisplayName = rule.folder_path || rule.path || rule.folder || '/';
                text.innerText = `${rule.name} (property: ${rule.property} • folder: ${folderDisplayName})`;
            });
        } else {
            containerEl.createDiv({
                cls: 'viewday-empty-rules',
                text: 'No local rules configured yet.'
            });
        }

        // 5. SUCCESS MESSAGE
        const successContainer = containerEl.createDiv();
        const refreshSuccessMessage = (id: string) => {
            successContainer.empty();
            if (id && id.length > 0) {
                successContainer.addClass('viewday-success-container');

                successContainer.createSpan({ text: "All set! Click the calendar icon" });
                const iconSpan = successContainer.createSpan();
                setIcon(iconSpan, "calendar-days");
                successContainer.createSpan({ text: "in your sidebar to view your schedule." });
            }
        };
        refreshSuccessMessage(this.plugin.settings.viewId);

        // 6. FOOTER LINKS
        const linkContainer = containerEl.createDiv({ cls: 'viewday-link-container' });

        const createLink = (text: string, href: string) => {
            linkContainer.createEl('a', { text, href, cls: 'viewday-footer-link' });
        };

        createLink('Go to Viewday dashboard ↗', 'https://viewday.app/dashboard');
        createLink('Request a feature ↗', 'https://viewday.app/feature-requests');
        createLink('Need help? Contact us ↗', 'https://viewday.app/contact');
    }
}

class LinkedNoteSuggester extends FuzzySuggestModal<TFile> {
    plugin: ViewdayPlugin;
    eventId: string;

    constructor(app: App, plugin: ViewdayPlugin, eventId: string) {
        super(app);
        this.plugin = plugin;
        this.eventId = eventId;
        this.setPlaceholder("Search for a note to link...");
    }

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles();
    }

    getItemText(file: TFile): string {
        return file.path;
    }

    async onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent) {
        try {
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                let links = frontmatter['viewday_links'];
                if (!links) {
                    frontmatter['viewday_links'] = [this.eventId];
                } else if (Array.isArray(links)) {
                    if (!links.includes(this.eventId)) {
                        links.push(this.eventId);
                    }
                } else {
                    // String or other type -> cast to array
                    frontmatter['viewday_links'] = [String(links), this.eventId];
                }
            });
            new Notice(`Linked: ${file.basename}`);
            // Let the metadataCache watcher pick up the change and trigger requestSync
        } catch (err) {
            console.error("Viewday: Failed to link note", err);
            new Notice("Viewday: Failed to link note.");
        }
    }
}