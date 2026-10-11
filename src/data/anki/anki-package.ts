import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { decompress } from "fzstd";
import type { Database, SqlValue } from "sql.js";
import initSqlJs from "sql.js/dist/sql-asm.js";

export interface AnkiField {
    name: string;
    ordinal: number;
}

export interface AnkiTemplate {
    name: string;
    ordinal: number;
    questionFormat: string;
    answerFormat: string;
    deckId: number | null;
}

export interface AnkiModel {
    id: number;
    name: string;
    kind: "standard" | "cloze";
    imageOcclusion?: boolean;
    css: string;
    fields: AnkiField[];
    templates: AnkiTemplate[];
    raw: Record<string, unknown>;
}

export interface AnkiDeck {
    id: number;
    name: string;
    description: string;
    configId: number;
    raw: Record<string, unknown>;
}

export interface AnkiReview {
    id: number;
    cardId: number;
    ease: number;
    interval: number;
    previousInterval: number;
    factor: number;
    durationMs: number;
    type: number;
}

export interface AnkiCard {
    id: number;
    noteId: number;
    deckId: number;
    ordinal: number;
    type: number;
    queue: number;
    due: number;
    interval: number;
    factor: number;
    reps: number;
    lapses: number;
    left: number;
    originalDue: number;
    originalDeckId: number;
    flags: number;
    data: string;
    reviews: AnkiReview[];
}

export interface AnkiNote {
    id: number;
    guid: string;
    modelId: number;
    modifiedAt: number;
    tags: string[];
    fields: string[];
    flags: number;
    data: string;
    cards: AnkiCard[];
}

export interface AnkiPackage {
    format: "apkg";
    collectionCreatedAt: number;
    models: AnkiModel[];
    decks: AnkiDeck[];
    deckConfigs: Record<string, Record<string, unknown>>;
    config: Record<string, unknown>;
    notes: AnkiNote[];
    /** Original media filename to uncompressed bytes. */
    media: Record<string, Uint8Array>;
    warnings: string[];
}

type Row = Record<string, SqlValue>;

const SQLITE_HEADER = "SQLite format 3\0";
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

function isZstd(bytes: Uint8Array): boolean {
    return ZSTD_MAGIC.every((value, index) => bytes[index] === value);
}

function decodeSqlite(bytes: Uint8Array): Uint8Array {
    const decoded = isZstd(bytes) ? decompress(bytes) : bytes;
    if (strFromU8(decoded.subarray(0, 16), true) !== SQLITE_HEADER) {
        throw new Error("anki-unsupported-collection-format");
    }
    return decoded;
}

function rows(database: Database, sql: string): Row[] {
    const result = database.exec(sql)[0];
    if (!result) return [];
    return result.values.map((values) =>
        Object.fromEntries(result.columns.map((column, index) => [column, values[index]])),
    );
}

function hasTable(database: Database, name: string): boolean {
    const statement = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
    );
    try {
        statement.bind([name]);
        return statement.step();
    } finally {
        statement.free();
    }
}

function objectJson(value: SqlValue): Record<string, unknown> {
    if (typeof value !== "string" || !value) return {};
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function objectMap(value: SqlValue): Record<string, Record<string, unknown>> {
    return objectJson(value) as Record<string, Record<string, unknown>>;
}

function numeric(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function tags(value: unknown): string[] {
    return stringValue(value).trim().split(/\s+/).filter(Boolean);
}

function sortedObjectValues(value: Record<string, Record<string, unknown>>) {
    return Object.values(value).sort((left, right) => numeric(left.ord) - numeric(right.ord));
}

function parseModels(raw: Record<string, Record<string, unknown>>): AnkiModel[] {
    return Object.entries(raw).map(([key, model]) => ({
        id: numeric(model.id, numeric(key)),
        name: stringValue(model.name, `Model ${key}`),
        kind: numeric(model.type) === 1 ? "cloze" : "standard",
        imageOcclusion:
            numeric(model.originalStockKind) === 6 ||
            (Array.isArray(model.tmpls) &&
                model.tmpls.some(
                    (template) =>
                        !!template &&
                        typeof template === "object" &&
                        stringValue((template as Record<string, unknown>).qfmt).includes(
                            "imageOcclusion",
                        ),
                )),
        css: stringValue(model.css),
        fields: sortedObjectValues(
            Object.fromEntries(
                (Array.isArray(model.flds) ? model.flds : []).map((field, index) => [
                    String(index),
                    field as Record<string, unknown>,
                ]),
            ),
        ).map((field, index) => ({
            name: stringValue(field.name, `Field ${index + 1}`),
            ordinal: numeric(field.ord, index),
        })),
        templates: sortedObjectValues(
            Object.fromEntries(
                (Array.isArray(model.tmpls) ? model.tmpls : []).map((template, index) => [
                    String(index),
                    template as Record<string, unknown>,
                ]),
            ),
        ).map((template, index) => ({
            name: stringValue(template.name, `Card ${index + 1}`),
            ordinal: numeric(template.ord, index),
            questionFormat: stringValue(template.qfmt),
            answerFormat: stringValue(template.afmt),
            deckId:
                template.did === null || template.did === undefined ? null : numeric(template.did),
        })),
        raw: model,
    }));
}

function parseDecks(raw: Record<string, Record<string, unknown>>): AnkiDeck[] {
    return Object.entries(raw).map(([key, deck]) => ({
        id: numeric(deck.id, numeric(key)),
        name: stringValue(deck.name, `Deck ${key}`),
        description: stringValue(deck.desc),
        configId: numeric(deck.conf, 1),
        raw: deck,
    }));
}

function readVarint(bytes: Uint8Array, cursor: { value: number }): number {
    let result = 0;
    let shift = 0;
    while (cursor.value < bytes.length && shift < 56) {
        const byte = bytes[cursor.value++];
        result += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return result;
        shift += 7;
    }
    throw new Error("invalid-protobuf-varint");
}

interface ProtoValue {
    wire: number;
    value: number | Uint8Array;
}

function protoFields(bytes: Uint8Array): Map<number, ProtoValue[]> {
    const result = new Map<number, ProtoValue[]>();
    const cursor = { value: 0 };
    while (cursor.value < bytes.length) {
        const tag = readVarint(bytes, cursor);
        const field = tag >>> 3;
        const wire = tag & 7;
        let value: number | Uint8Array;
        if (wire === 0) value = readVarint(bytes, cursor);
        else if (wire === 1) {
            value = bytes.slice(cursor.value, cursor.value + 8);
            cursor.value += 8;
        } else if (wire === 2) {
            const length = readVarint(bytes, cursor);
            value = bytes.slice(cursor.value, cursor.value + length);
            cursor.value += length;
        } else if (wire === 5) {
            value = bytes.slice(cursor.value, cursor.value + 4);
            cursor.value += 4;
        } else {
            throw new Error("unsupported-protobuf-wire-type");
        }
        result.set(field, [...(result.get(field) ?? []), { wire, value }]);
    }
    return result;
}

function protoBytes(fields: Map<number, ProtoValue[]>, field: number): Uint8Array {
    const value = fields.get(field)?.[0]?.value;
    return value instanceof Uint8Array ? value : new Uint8Array();
}

function protoNumber(fields: Map<number, ProtoValue[]>, field: number, fallback = 0): number {
    const value = fields.get(field)?.[0]?.value;
    return typeof value === "number" ? value : fallback;
}

function protoString(fields: Map<number, ProtoValue[]>, field: number): string {
    return strFromU8(protoBytes(fields, field));
}

function protoFloats(fields: Map<number, ProtoValue[]>, field: number): number[] {
    return (fields.get(field) ?? []).flatMap((entry) => {
        if (!(entry.value instanceof Uint8Array)) return [];
        const view = new DataView(
            entry.value.buffer,
            entry.value.byteOffset,
            entry.value.byteLength,
        );
        if (entry.wire === 5 && entry.value.byteLength === 4) return [view.getFloat32(0, true)];
        const values: number[] = [];
        for (let offset = 0; offset + 4 <= entry.value.byteLength; offset += 4) {
            values.push(view.getFloat32(offset, true));
        }
        return values;
    });
}

function blob(value: SqlValue): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array();
}

function parseModernModels(database: Database): AnkiModel[] {
    const fieldsByModel = new Map<number, AnkiField[]>();
    for (const row of rows(database, "SELECT ntid, ord, name FROM fields ORDER BY ntid, ord")) {
        const id = numeric(row.ntid);
        fieldsByModel.set(id, [
            ...(fieldsByModel.get(id) ?? []),
            { name: String(row.name ?? "Field"), ordinal: numeric(row.ord) },
        ]);
    }
    const templatesByModel = new Map<number, AnkiTemplate[]>();
    for (const row of rows(
        database,
        "SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord",
    )) {
        const id = numeric(row.ntid);
        const config = protoFields(blob(row.config));
        templatesByModel.set(id, [
            ...(templatesByModel.get(id) ?? []),
            {
                name: String(row.name ?? "Card"),
                ordinal: numeric(row.ord),
                questionFormat: protoString(config, 1),
                answerFormat: protoString(config, 2),
                deckId: protoNumber(config, 5) || null,
            },
        ]);
    }
    return rows(database, "SELECT id, name, config FROM notetypes ORDER BY id").map((row) => {
        const id = numeric(row.id);
        const configBytes = blob(row.config);
        const config = protoFields(configBytes);
        return {
            id,
            name: String(row.name ?? `Model ${id}`),
            kind: protoNumber(config, 1) === 1 ? "cloze" : "standard",
            imageOcclusion: protoNumber(config, 9) === 6,
            css: protoString(config, 3),
            fields: fieldsByModel.get(id) ?? [],
            templates: templatesByModel.get(id) ?? [],
            raw: { modernConfig: [...configBytes] },
        };
    });
}

function parseModernDecks(database: Database): AnkiDeck[] {
    return rows(database, "SELECT id, name, kind FROM decks ORDER BY id").map((row) => {
        const id = numeric(row.id);
        const container = protoFields(blob(row.kind));
        const normalBytes = protoBytes(container, 1);
        const normal = protoFields(normalBytes);
        return {
            id,
            name: String(row.name ?? `Deck ${id}`),
            description: protoString(normal, 4),
            configId: protoNumber(normal, 1, 1),
            raw: { modernKind: [...blob(row.kind)] },
        };
    });
}

function parseModernDeckConfigs(database: Database): Record<string, Record<string, unknown>> {
    if (!hasTable(database, "deck_config")) return {};
    return Object.fromEntries(
        rows(database, "SELECT id, name, config FROM deck_config ORDER BY id").map((row) => {
            const id = numeric(row.id);
            const config = protoFields(blob(row.config));
            const weights = [6, 5, 3]
                .map((field) => protoFloats(config, field))
                .find((values) => values.length > 0);
            return [
                String(id),
                {
                    id,
                    name: String(row.name ?? `Options ${id}`),
                    fsrsWeights: weights ?? [],
                    desiredRetention: protoFloats(config, 37)[0] ?? 0.9,
                    learningSteps: protoFloats(config, 1),
                    relearningSteps: protoFloats(config, 2),
                    newCardsPerDay: protoNumber(config, 9, 20),
                    reviewsPerDay: protoNumber(config, 10, 200),
                },
            ];
        }),
    );
}

function skipProtoValue(bytes: Uint8Array, cursor: { value: number }, wireType: number): void {
    if (wireType === 0) readVarint(bytes, cursor);
    else if (wireType === 1) cursor.value += 8;
    else if (wireType === 2) cursor.value += readVarint(bytes, cursor);
    else if (wireType === 5) cursor.value += 4;
    else throw new Error("unsupported-protobuf-wire-type");
}

/** Minimal decoder for Anki's MediaEntries protobuf; filename and entry order are sufficient. */
function parseModernMediaIndex(bytes: Uint8Array): string[] {
    const names: string[] = [];
    const cursor = { value: 0 };
    while (cursor.value < bytes.length) {
        const tag = readVarint(bytes, cursor);
        const field = tag >>> 3;
        const wireType = tag & 7;
        if (field !== 1 || wireType !== 2) {
            skipProtoValue(bytes, cursor, wireType);
            continue;
        }
        const end = cursor.value + readVarint(bytes, cursor);
        let name = "";
        while (cursor.value < end) {
            const entryTag = readVarint(bytes, cursor);
            const entryField = entryTag >>> 3;
            const entryWire = entryTag & 7;
            if (entryField === 1 && entryWire === 2) {
                const length = readVarint(bytes, cursor);
                name = strFromU8(bytes.subarray(cursor.value, cursor.value + length));
                cursor.value += length;
            } else {
                skipProtoValue(bytes, cursor, entryWire);
            }
        }
        names.push(name);
        cursor.value = end;
    }
    return names;
}

function parsePackageMedia(
    archive: Record<string, Uint8Array>,
    modern: boolean,
    warnings: string[],
): Record<string, Uint8Array> {
    const index = archive.media;
    if (!index) return {};
    try {
        const decodedIndex = modern && isZstd(index) ? decompress(index) : index;
        const mapping = modern
            ? Object.fromEntries(
                  parseModernMediaIndex(decodedIndex).map((name, index) => [String(index), name]),
              )
            : (JSON.parse(strFromU8(decodedIndex)) as Record<string, string>);
        const media: Record<string, Uint8Array> = {};
        for (const [archiveName, originalName] of Object.entries(mapping)) {
            const payload = archive[archiveName];
            if (!payload || !originalName) continue;
            media[originalName] = isZstd(payload) ? decompress(payload) : payload;
        }
        return media;
    } catch {
        warnings.push(
            "The media index could not be decoded; card text was imported but some media may need to be copied separately.",
        );
        return {};
    }
}

export async function parseAnkiPackage(input: ArrayBuffer | Uint8Array): Promise<AnkiPackage> {
    const archive = unzipSync(input instanceof Uint8Array ? input : new Uint8Array(input));
    const collectionName = ["collection.anki21b", "collection.anki21", "collection.anki2"].find(
        (name) => archive[name],
    );
    if (!collectionName) throw new Error("anki-collection-missing");
    const SQL = await initSqlJs();
    const database = new SQL.Database(decodeSqlite(archive[collectionName]));
    const warnings: string[] = [];
    try {
        const collection = rows(
            database,
            "SELECT crt, conf, models, decks, dconf FROM col LIMIT 1",
        )[0];
        if (!collection) throw new Error("anki-invalid-collection");
        const legacyModels = parseModels(objectMap(collection.models));
        const legacyDecks = parseDecks(objectMap(collection.decks));
        const modernSchema = hasTable(database, "notetypes") && hasTable(database, "decks");
        const models =
            legacyModels.length === 0 && modernSchema ? parseModernModels(database) : legacyModels;
        const decks =
            legacyDecks.length === 0 && modernSchema ? parseModernDecks(database) : legacyDecks;
        const reviewsByCard = new Map<number, AnkiReview[]>();
        for (const row of rows(
            database,
            "SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog ORDER BY id",
        )) {
            const cardId = numeric(row.cid);
            const review: AnkiReview = {
                id: numeric(row.id),
                cardId,
                ease: numeric(row.ease),
                interval: numeric(row.ivl),
                previousInterval: numeric(row.lastIvl),
                factor: numeric(row.factor),
                durationMs: numeric(row.time),
                type: numeric(row.type),
            };
            reviewsByCard.set(cardId, [...(reviewsByCard.get(cardId) ?? []), review]);
        }
        const cardsByNote = new Map<number, AnkiCard[]>();
        for (const row of rows(
            database,
            "SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards ORDER BY id",
        )) {
            const id = numeric(row.id);
            const noteId = numeric(row.nid);
            const card: AnkiCard = {
                id,
                noteId,
                deckId: numeric(row.did),
                ordinal: numeric(row.ord),
                type: numeric(row.type),
                queue: numeric(row.queue),
                due: numeric(row.due),
                interval: numeric(row.ivl),
                factor: numeric(row.factor),
                reps: numeric(row.reps),
                lapses: numeric(row.lapses),
                left: numeric(row.left),
                originalDue: numeric(row.odue),
                originalDeckId: numeric(row.odid),
                flags: numeric(row.flags),
                data: String(row.data ?? ""),
                reviews: reviewsByCard.get(id) ?? [],
            };
            cardsByNote.set(noteId, [...(cardsByNote.get(noteId) ?? []), card]);
        }
        const notes = rows(
            database,
            "SELECT id, guid, mid, mod, tags, flds, flags, data FROM notes ORDER BY id",
        ).map<AnkiNote>((row) => {
            const id = numeric(row.id);
            return {
                id,
                guid: String(row.guid ?? id),
                modelId: numeric(row.mid),
                modifiedAt: numeric(row.mod) * 1000,
                tags: tags(row.tags),
                fields: String(row.flds ?? "").split("\u001f"),
                flags: numeric(row.flags),
                data: String(row.data ?? ""),
                cards: cardsByNote.get(id) ?? [],
            };
        });
        return {
            format: "apkg",
            collectionCreatedAt: numeric(collection.crt) * 1000,
            models,
            decks,
            deckConfigs:
                Object.keys(objectMap(collection.dconf)).length === 0 && modernSchema
                    ? parseModernDeckConfigs(database)
                    : objectMap(collection.dconf),
            config: objectJson(collection.conf),
            notes,
            media: parsePackageMedia(archive, collectionName === "collection.anki21b", warnings),
            warnings,
        };
    } finally {
        database.close();
    }
}

function ankiModelJson(model: AnkiModel, modified: number): Record<string, unknown> {
    const raw = { ...model.raw };
    return {
        ...raw,
        id: model.id,
        name: model.name,
        type: model.kind === "cloze" ? 1 : 0,
        mod: modified,
        usn: -1,
        css: model.css,
        flds: model.fields.map((field) => ({
            name: field.name,
            ord: field.ordinal,
            sticky: false,
            rtl: false,
            font: "Arial",
            size: 20,
        })),
        tmpls: model.templates.map((template) => ({
            name: template.name,
            ord: template.ordinal,
            qfmt: template.questionFormat,
            afmt: template.answerFormat,
            did: template.deckId,
            bqfmt: "",
            bafmt: "",
        })),
    };
}

function ankiDeckJson(deck: AnkiDeck, modified: number): Record<string, unknown> {
    return {
        ...deck.raw,
        id: deck.id,
        name: deck.name,
        desc: deck.description,
        conf: deck.configId,
        mod: modified,
        usn: -1,
        dyn: 0,
        collapsed: false,
        browserCollapsed: false,
        extendNew: 0,
        extendRev: 0,
    };
}

function insert(database: Database, sql: string, values: SqlValue[]): void {
    const statement = database.prepare(sql);
    try {
        statement.run(values);
    } finally {
        statement.free();
    }
}

/** Creates a classic, broadly compatible APKG while retaining imported raw scheduler metadata. */
export async function writeAnkiPackage(pkg: AnkiPackage): Promise<Uint8Array> {
    const SQL = await initSqlJs();
    const database = new SQL.Database();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const nowMillis = Date.now();
    database.run(`
        CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
        CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
        CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
        CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
        CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
        CREATE INDEX ix_notes_usn ON notes (usn); CREATE INDEX ix_cards_usn ON cards (usn); CREATE INDEX ix_cards_nid ON cards (nid); CREATE INDEX ix_revlog_usn ON revlog (usn); CREATE INDEX ix_revlog_cid ON revlog (cid);
    `);
    const models = Object.fromEntries(
        pkg.models.map((model) => [String(model.id), ankiModelJson(model, nowSeconds)]),
    );
    const decks = Object.fromEntries(
        pkg.decks.map((deck) => [String(deck.id), ankiDeckJson(deck, nowSeconds)]),
    );
    const dconf = Object.keys(pkg.deckConfigs).length
        ? pkg.deckConfigs
        : {
              "1": {
                  id: 1,
                  name: "Default",
                  mod: nowSeconds,
                  usn: -1,
                  maxTaken: 60,
                  autoplay: true,
                  replayq: true,
              },
          };
    insert(database, "INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        1,
        Math.floor((pkg.collectionCreatedAt || nowMillis) / 1000),
        nowMillis,
        nowMillis,
        11,
        0,
        0,
        0,
        JSON.stringify(pkg.config),
        JSON.stringify(models),
        JSON.stringify(decks),
        JSON.stringify(dconf),
        "{}",
    ]);
    for (const note of pkg.notes) {
        const sort = note.fields[0] ?? "";
        let checksum = 0;
        for (let index = 0; index < sort.length; index++)
            checksum = (checksum * 31 + sort.charCodeAt(index)) >>> 0;
        insert(database, "INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
            note.id,
            note.guid,
            note.modelId,
            Math.floor(note.modifiedAt / 1000) || nowSeconds,
            -1,
            ` ${note.tags.join(" ")} `,
            note.fields.join("\u001f"),
            sort,
            checksum,
            note.flags,
            note.data,
        ]);
        for (const card of note.cards) {
            insert(database, "INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
                card.id,
                note.id,
                card.deckId,
                card.ordinal,
                nowSeconds,
                -1,
                card.type,
                card.queue,
                card.due,
                card.interval,
                card.factor,
                card.reps,
                card.lapses,
                card.left,
                card.originalDue,
                card.originalDeckId,
                card.flags,
                card.data,
            ]);
            for (const review of card.reviews) {
                insert(database, "INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)", [
                    review.id,
                    card.id,
                    -1,
                    review.ease,
                    review.interval,
                    review.previousInterval,
                    review.factor,
                    review.durationMs,
                    review.type,
                ]);
            }
        }
    }
    const collection = database.export();
    database.close();
    const mediaIndex: Record<string, string> = {};
    const archive: Record<string, Uint8Array> = { "collection.anki2": collection };
    Object.entries(pkg.media).forEach(([filename, bytes], index) => {
        const archiveName = String(index);
        archive[archiveName] = bytes;
        mediaIndex[archiveName] = filename;
    });
    archive.media = strToU8(JSON.stringify(mediaIndex));
    return zipSync(archive, { level: 6 });
}

export function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted && char === '"' && text[index + 1] === '"') {
            value += '"';
            index++;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (!quoted && char === delimiter) {
            row.push(value);
            value = "";
        } else if (!quoted && (char === "\n" || char === "\r")) {
            if (char === "\r" && text[index + 1] === "\n") index++;
            row.push(value);
            if (row.some((cell) => cell.length > 0)) rows.push(row);
            row = [];
            value = "";
        } else {
            value += char;
        }
    }
    row.push(value);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    return rows;
}

export function writeDelimited(rows: string[][], delimiter: "," | "\t"): string {
    const escape = (value: string) => {
        if (![delimiter, '"', "\n", "\r"].some((token) => value.includes(token))) return value;
        return `"${value.replaceAll('"', '""')}"`;
    };
    return rows.map((row) => row.map(escape).join(delimiter)).join("\r\n");
}
