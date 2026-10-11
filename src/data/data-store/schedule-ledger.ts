import { TFile, Vault } from "obsidian";

import { ISerializedScheduleEntry } from "src/data/plugin-data";
import { AtomicVaultWriter } from "src/data/reliability/atomic-vault-writer";
import { RepItemScheduleFactory } from "src/scheduling/algorithms/base/rep-item-info-factory";
import { RepItemScheduleInfo } from "src/scheduling/algorithms/base/rep-item-schedule-info";

export const SCHEDULE_LEDGER_FOLDER = "Spaced Repetition";
export const SCHEDULE_LEDGER_PATH = `${SCHEDULE_LEDGER_FOLDER}/schedule-data.sr.md`;

const LEDGER_VERSION = 1;
const JSON_BLOCK = /```json\s*([\s\S]*?)\s*```/i;
const BLOCK_ID_AT_END_OF_LINE = / (\^[a-zA-Z0-9-]+)(?=\r?$)/gm;

type SerializedCardSchedule = ISerializedScheduleEntry | null;

interface ScheduleLedgerEntry {
    updatedAt: number;
    schedules: SerializedCardSchedule[] | null;
}

interface ScheduleLedgerData {
    version: number;
    clearedAt: number;
    cards: Record<string, ScheduleLedgerEntry>;
}

export interface ScheduleLedgerStorage {
    read(): Promise<string | null>;
    write(content: string): Promise<void>;
}

export class VaultScheduleLedgerStorage implements ScheduleLedgerStorage {
    constructor(
        private readonly vault: Vault,
        private readonly writer?: AtomicVaultWriter,
    ) {}

    async read(): Promise<string | null> {
        const file = this.vault.getAbstractFileByPath(SCHEDULE_LEDGER_PATH);
        return file instanceof TFile ? await this.vault.read(file) : null;
    }

    async write(content: string): Promise<void> {
        if (this.writer) {
            await this.writer.writeText(SCHEDULE_LEDGER_PATH, content);
            return;
        }
        let file = this.vault.getAbstractFileByPath(SCHEDULE_LEDGER_PATH);
        if (file instanceof TFile) {
            await this.vault.modify(file, content);
            return;
        }

        if (!this.vault.getAbstractFileByPath(SCHEDULE_LEDGER_FOLDER)) {
            await this.vault.createFolder(SCHEDULE_LEDGER_FOLDER);
        }
        file = await this.vault.create(SCHEDULE_LEDGER_PATH, content);
        if (!(file instanceof TFile)) {
            throw new Error(`Unable to create ${SCHEDULE_LEDGER_PATH}`);
        }
    }
}

function emptyLedger(): ScheduleLedgerData {
    return { version: LEDGER_VERSION, clearedAt: 0, cards: {} };
}

function parseLedger(content: string | null): ScheduleLedgerData {
    if (!content) return emptyLedger();
    try {
        const json = content.match(JSON_BLOCK)?.[1];
        if (!json) return emptyLedger();
        const parsed = JSON.parse(json) as Partial<ScheduleLedgerData>;
        if (parsed.version !== LEDGER_VERSION || typeof parsed.cards !== "object") {
            return emptyLedger();
        }
        return {
            version: LEDGER_VERSION,
            clearedAt: typeof parsed.clearedAt === "number" ? parsed.clearedAt : 0,
            cards: parsed.cards ?? {},
        };
    } catch (error) {
        console.warn("SR: Unable to parse the schedule ledger", error);
        return emptyLedger();
    }
}

function mergeLedgers(left: ScheduleLedgerData, right: ScheduleLedgerData): ScheduleLedgerData {
    const clearedAt = Math.max(left.clearedAt, right.clearedAt);
    const cards: Record<string, ScheduleLedgerEntry> = {};
    for (const id of new Set([...Object.keys(left.cards), ...Object.keys(right.cards)])) {
        const leftEntry = left.cards[id];
        const rightEntry = right.cards[id];
        const latest =
            !rightEntry || (leftEntry && leftEntry.updatedAt >= rightEntry.updatedAt)
                ? leftEntry
                : rightEntry;
        if (latest && latest.updatedAt > clearedAt) cards[id] = latest;
    }
    return { version: LEDGER_VERSION, clearedAt, cards };
}

function formatLedger(data: ScheduleLedgerData): string {
    const cards = Object.fromEntries(
        Object.entries(data.cards).sort(([left], [right]) => left.localeCompare(right)),
    );
    return `# MSRE schedule data

This file is managed automatically. Keep it in the vault so card schedules can sync between devices.

\`\`\`json
${JSON.stringify({ ...data, cards }, null, 2)}
\`\`\`
`;
}

export function extractStableQuestionIds(text: string): string[] {
    return [...text.matchAll(BLOCK_ID_AT_END_OF_LINE)].map((match) => match[1]);
}

export class ScheduleLedger {
    private data: ScheduleLedgerData = emptyLedger();
    private initialized = false;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly storage: ScheduleLedgerStorage) {}

    async initialize(): Promise<boolean> {
        if (!this.initialized) {
            try {
                this.data = parseLedger(await this.storage.read());
            } catch (error) {
                console.warn("SR: Unable to load the schedule ledger", error);
                this.data = emptyLedger();
            }
            this.initialized = true;
        }
        return true;
    }

    async reload(): Promise<void> {
        await this.initialize();
        try {
            this.data = mergeLedgers(this.data, parseLedger(await this.storage.read()));
        } catch (error) {
            console.warn("SR: Unable to reload the schedule ledger", error);
        }
    }

    reset(): void {
        this.data = emptyLedger();
        this.initialized = true;
    }

    getSchedules(questionId: string): Array<RepItemScheduleInfo | null> | null {
        const entry = this.data.cards[questionId];
        if (!entry?.schedules || entry.updatedAt <= this.data.clearedAt) return null;
        return entry.schedules.map((schedule) =>
            schedule ? RepItemScheduleFactory.create(schedule.algorithm, schedule) : null,
        );
    }

    async setSchedules(
        questionId: string,
        schedules: Array<RepItemScheduleInfo | null>,
    ): Promise<void> {
        await this.initialize();
        this.data.cards[questionId] = {
            updatedAt: Date.now(),
            schedules: schedules.map((schedule) => schedule?.serializeSchedule() ?? null),
        };
        await this.persist();
    }

    async delete(questionId: string): Promise<void> {
        await this.deleteMany([questionId]);
    }

    async deleteMany(questionIds: string[]): Promise<void> {
        if (questionIds.length === 0) return;
        await this.initialize();
        const updatedAt = Date.now();
        for (const questionId of questionIds) {
            this.data.cards[questionId] = { updatedAt, schedules: null };
        }
        await this.persist();
    }

    async clear(): Promise<void> {
        await this.initialize();
        this.data = { version: LEDGER_VERSION, clearedAt: Date.now(), cards: {} };
        await this.persist();
    }

    private async persist(): Promise<void> {
        const operation = this.writeQueue.then(async () => {
            const onDisk = parseLedger(await this.storage.read());
            this.data = mergeLedgers(this.data, onDisk);
            await this.storage.write(formatLedger(this.data));
        });
        this.writeQueue = operation.catch((error) => {
            console.warn("SR: Unable to update the schedule ledger", error);
        });
        await operation;
    }
}
