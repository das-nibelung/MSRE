import { normalizePath } from "obsidian";

import {
    AutomationAuditEntry,
    AutomationOperationKind,
    AutomationRequest,
    AutomationResponse,
} from "src/automation/automation-types";
import { SRSettings } from "src/data/settings";
import SRPlugin from "src/main";

const OPERATIONS = new Set<AutomationOperationKind>([
    "create-card",
    "create-deck",
    "add-media",
    "find-cards",
    "update-note",
    "get-statistics",
    "check-integrity",
    "import-cards",
]);

export class AutomationBridge {
    private processing = false;
    private interval: number | null = null;

    constructor(
        private readonly plugin: SRPlugin,
        private readonly executeRequest: (request: AutomationRequest) => Promise<unknown>,
    ) {}

    get rootPath(): string {
        return normalizePath(
            `${this.plugin.dataManager.data.settings.scheduleDataVaultLocation}/Automation`,
        );
    }

    get inboxPath(): string {
        return normalizePath(`${this.rootPath}/Inbox`);
    }

    get outboxPath(): string {
        return normalizePath(`${this.rootPath}/Outbox`);
    }

    get auditPath(): string {
        return normalizePath(`${this.rootPath}/automation-log.jsonl`);
    }

    async start(): Promise<void> {
        await this.ensureDirectories();
        if (this.interval !== null) return;
        this.interval = window.setInterval((): void => {
            void this.processNow();
        }, 1500);
        this.plugin.registerInterval(this.interval);
        await this.processNow();
    }

    stop(): void {
        if (this.interval !== null) window.clearInterval(this.interval);
        this.interval = null;
    }

    async processNow(): Promise<number> {
        const settings = this.plugin.dataManager.data.settings;
        if (!settings.automationEnabled || !settings.automationQueueEnabled || this.processing) {
            return 0;
        }
        this.processing = true;
        try {
            await this.ensureDirectories();
            const adapter = this.plugin.app.vault.adapter;
            const listing = await adapter.list(this.inboxPath);
            const requests = listing.files
                .filter((path) => path.endsWith(".request.json"))
                .sort()
                .slice(0, settings.automationMaxBatchSize);
            for (const path of requests) await this.processFile(path, settings);
            return requests.length;
        } finally {
            this.processing = false;
        }
    }

    async appendAudit(entry: AutomationAuditEntry): Promise<void> {
        await this.ensureDirectories();
        const adapter = this.plugin.app.vault.adapter;
        const previous = (await adapter.exists(this.auditPath))
            ? await adapter.read(this.auditPath)
            : "";
        const limit = this.plugin.dataManager.data.settings.automationAuditRetention;
        const lines = [...previous.split("\n").filter(Boolean), JSON.stringify(entry)].slice(
            -limit,
        );
        await adapter.write(this.auditPath, `${lines.join("\n")}\n`);
    }

    async readAudit(limit = 100): Promise<AutomationAuditEntry[]> {
        const adapter = this.plugin.app.vault.adapter;
        if (!(await adapter.exists(this.auditPath))) return [];
        return (await adapter.read(this.auditPath))
            .split("\n")
            .filter(Boolean)
            .slice(-Math.max(1, Math.min(1000, limit)))
            .flatMap((line) => {
                try {
                    return [JSON.parse(line) as AutomationAuditEntry];
                } catch {
                    return [];
                }
            })
            .reverse();
    }

    private async processFile(path: string, settings: SRSettings): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        let id =
            path
                .split("/")
                .pop()
                ?.replace(/\.request\.json$/, "") ?? "invalid";
        let response: AutomationResponse;
        let request: AutomationRequest | null = null;
        let delegated = false;
        try {
            request = JSON.parse(await adapter.read(path)) as AutomationRequest;
            id = request.id;
            if (request.version !== 1 || !OPERATIONS.has(request.operation)) {
                throw new Error("unsupported-operation");
            }
            if (!request.token || request.token !== settings.automationAccessToken) {
                throw new Error("access-denied");
            }
            delegated = true;
            const result = await this.executeRequest({ ...request, source: "mcp" });
            response = { version: 1, id, ok: true, result, completedAt: Date.now() };
        } catch (error) {
            const message = error instanceof Error ? error.message : "automation-failed";
            response = {
                version: 1,
                id,
                ok: false,
                error: { code: message, message },
                completedAt: Date.now(),
            };
            if (!delegated && request && OPERATIONS.has(request.operation)) {
                await this.appendAudit({
                    version: 1,
                    id: safeAuditId(id),
                    operation: request.operation,
                    source: "mcp",
                    requestedAt: Number(request.requestedAt) || Date.now(),
                    completedAt: Date.now(),
                    ok: false,
                    errorCode: message,
                });
            }
        }
        const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id) ? id : `invalid-${Date.now()}`;
        await adapter.write(
            normalizePath(`${this.outboxPath}/${safeId}.response.json`),
            JSON.stringify(response, null, 2),
        );
        await adapter.remove(path);
    }

    private async ensureDirectories(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        for (const folder of [this.rootPath, this.inboxPath, this.outboxPath]) {
            const segments = folder.split("/").filter(Boolean);
            for (let index = 1; index <= segments.length; index++) {
                const path = segments.slice(0, index).join("/");
                if (!(await adapter.exists(path))) await adapter.mkdir(path);
            }
        }
    }
}

function safeAuditId(value: string): string {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value) ? value : `invalid-${Date.now()}`;
}
