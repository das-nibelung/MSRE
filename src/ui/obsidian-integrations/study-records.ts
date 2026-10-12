import type SRPlugin from "src/main";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { ISerializedFSRSScheduleData } from "src/scheduling/algorithms/fsrs/serialized-schedule-data";
import {
    annotateCardBrowserDiagnostics,
    CardBrowserRecord,
    createCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";

/** Shared study data used by Bases, Canvas and deep-link study sessions. */
export function createStudyRecords(plugin: SRPlugin): CardBrowserRecord[] {
    if (!plugin.dataManager.isOsrCoreLoaded()) return [];
    const snapshot = plugin.dataManager.collectionStore.getCollectionSnapshot();
    const storedByLegacyId = new Map(
        Object.values(snapshot.cards)
            .filter((card) => !card.deletedAt && card.legacyStableId)
            .map((card) => [card.legacyStableId, card]),
    );
    const areas = plugin.dataManager.data.knowledgeAreas.filter((area) => !area.archivedAt);
    const now = Date.now();

    return annotateCardBrowserDiagnostics(
        createCardBrowserRecords(plugin.dataManager.osrCore.getAllCards()).map((record) => {
            const stableId = record.card.stableId ?? record.card.storageInfo?.questionId;
            const stored = stableId ? storedByLegacyId.get(stableId) : undefined;
            const note = stored ? snapshot.notes[stored.noteId] : undefined;
            const expiredBurial =
                stored?.state === "buried" &&
                stored.buriedUntil !== null &&
                stored.buriedUntil <= now;
            const deckNames = stored?.deckPath ? [stored.deckPath] : record.deckNames;
            let retention: number | null = null;
            let difficulty: number | null = null;
            let stability: number | null = null;
            if (stored?.schedule?.algorithm === SRAlgorithmType.FSRS) {
                const schedule = stored.schedule.scheduleData as ISerializedFSRSScheduleData;
                difficulty = schedule.difficulty;
                stability = schedule.stability;
                const lastReview = Date.parse(schedule.lastReview);
                if (schedule.stability > 0 && Number.isFinite(lastReview)) {
                    const elapsedDays = Math.max(0, (now - lastReview) / 86_400_000);
                    retention = Math.pow(1 + (19 / 81) * (elapsedDays / schedule.stability), -0.5);
                }
            }
            return {
                ...record,
                deckNames,
                lifecycleState: expiredBurial ? "active" : (stored?.state ?? "active"),
                flag: stored?.flag ?? 0,
                tags: note?.tags ?? [],
                noteId: note?.id ?? null,
                reps: stored?.reps ?? 0,
                lapses: stored?.lapses ?? 0,
                retention,
                difficulty,
                stability,
                createdAt: stored?.createdAt ?? note?.createdAt ?? null,
                updatedAt: stored?.updatedAt ?? note?.updatedAt ?? null,
                lastReviewAt: stored?.lastReviewAt ?? null,
                hasSource: Boolean(
                    record.notePath && plugin.app.vault.getFileByPath(record.notePath),
                ),
                areaNames: areas
                    .filter((area) => deckNames.some((deck) => area.deckPaths.includes(deck)))
                    .map((area) => area.name),
            };
        }),
    );
}
