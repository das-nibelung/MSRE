import {
    AutomationOperationKind,
    AutomationRequest,
    FindCardsPayload,
    PublicCardRecord,
    PublicStatistics,
} from "src/automation/automation-types";
import { CollectionData, ReviewLogData } from "src/data/collection/collection-types";
import { normalizeManagedDeckPath } from "src/data/native-card-store";

const WRITE_OPERATIONS = new Set<AutomationOperationKind>([
    "create-card",
    "create-deck",
    "add-media",
    "update-note",
    "import-cards",
]);

export function isWriteOperation(operation: AutomationOperationKind): boolean {
    return WRITE_OPERATIONS.has(operation);
}

export function safeAutomationId(value: string): string | null {
    const normalized = value.trim();
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(normalized) ? normalized : null;
}

export function deckPathAllowed(deckPath: string, allowedPrefixes: readonly string[]): boolean {
    const normalized = normalizeManagedDeckPath(deckPath);
    if (allowedPrefixes.length === 0) return true;
    return allowedPrefixes.some((prefix) => {
        const allowed = normalizeManagedDeckPath(prefix);
        return Boolean(allowed) && (normalized === allowed || normalized.startsWith(`${allowed}/`));
    });
}

export function requestDeckPaths(request: AutomationRequest): string[] {
    const payload = request.payload as Record<string, unknown>;
    const direct = typeof payload.deckPath === "string" ? [payload.deckPath] : [];
    if (request.operation !== "import-cards") return direct;
    const cards = Array.isArray(payload.cards) ? payload.cards : [];
    return cards.flatMap((card) =>
        card &&
        typeof card === "object" &&
        typeof (card as { deckPath?: unknown }).deckPath === "string"
            ? [(card as { deckPath: string }).deckPath]
            : [],
    );
}

export function findPublicCards(
    collection: CollectionData,
    payload: FindCardsPayload = {},
): PublicCardRecord[] {
    const query = (payload.query ?? "").trim().toLocaleLowerCase();
    const tags = (payload.tags ?? []).map((tag) => tag.replace(/^#/, "").toLocaleLowerCase());
    const deckPath = payload.deckPath ? normalizeManagedDeckPath(payload.deckPath) : "";
    const result: PublicCardRecord[] = [];
    for (const card of Object.values(collection.cards)) {
        if (card.deletedAt) continue;
        const note = collection.notes[card.noteId];
        if (!note || note.deletedAt) continue;
        if (payload.noteId && note.id !== payload.noteId) continue;
        if (deckPath && card.deckPath !== deckPath && !card.deckPath.startsWith(`${deckPath}/`)) {
            continue;
        }
        if (tags.length > 0) {
            const noteTags = note.tags.map((tag) => tag.replace(/^#/, "").toLocaleLowerCase());
            if (!tags.every((tag) => noteTags.includes(tag))) continue;
        }
        if (query) {
            const haystack = [
                card.id,
                note.id,
                card.deckPath,
                ...note.tags,
                ...Object.keys(note.fields),
                ...Object.values(note.fields),
            ]
                .join("\n")
                .toLocaleLowerCase();
            if (!haystack.includes(query)) continue;
        }
        result.push({
            card: JSON.parse(JSON.stringify(card)),
            note: JSON.parse(JSON.stringify(note)),
        });
        if (result.length >= Math.max(1, Math.min(10_000, payload.limit ?? 200))) break;
    }
    return result;
}

export function calculatePublicStatistics(
    collection: CollectionData,
    reviewLog: ReviewLogData,
    now = Date.now(),
): PublicStatistics {
    const cards = Object.values(collection.cards).filter((card) => !card.deletedAt);
    const active = cards.filter((card) => card.state === "active");
    return {
        notes: Object.values(collection.notes).filter((note) => !note.deletedAt).length,
        cards: cards.length,
        decks: Object.values(collection.decks).filter((deck) => !deck.deletedAt).length,
        due: active.filter((card) => {
            const due = card.schedule?.scheduleData.dueDate;
            return card.queue !== "new" && typeof due === "string" && Date.parse(due) <= now;
        }).length,
        newCards: active.filter((card) => card.queue === "new").length,
        suspended: cards.filter((card) => card.state === "suspended").length,
        reviews: Object.values(reviewLog.entries).filter((entry) => !entry.deletedAt).length,
    };
}
