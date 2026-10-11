#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const vaultPath = process.env.MSRE_VAULT_PATH;
const token = process.env.MSRE_TOKEN;
const relativeAutomationPath = process.env.MSRE_AUTOMATION_DIR ?? "Spaced Repetition/Automation";
if (!vaultPath || !token) {
    process.stderr.write("MSRE_VAULT_PATH and MSRE_TOKEN are required.\n");
    process.exit(1);
}

const vaultRoot = resolve(vaultPath);
const automationRoot = isAbsolute(relativeAutomationPath)
    ? resolve(relativeAutomationPath)
    : resolve(vaultRoot, relativeAutomationPath);
if (automationRoot !== vaultRoot && !automationRoot.startsWith(`${vaultRoot}${sep}`)) {
    throw new Error("MSRE_AUTOMATION_DIR must stay inside the vault");
}
const inbox = join(automationRoot, "Inbox");
const outbox = join(automationRoot, "Outbox");
const aiRequests = join(automationRoot, "AI", "Requests");
const aiResponses = join(automationRoot, "AI", "Responses");

const definitions = [
    ["create_card", "Create a Markdown-backed card", "create-card", ["deckPath", "front"]],
    ["create_deck", "Create a deck or nested deck", "create-deck", ["deckPath"]],
    [
        "add_media",
        "Store an offline media file from base64",
        "add-media",
        ["fileName", "dataBase64"],
    ],
    ["find_cards", "Find cards by text, deck, note id, or tags", "find-cards", []],
    ["update_note", "Change fields, tags, or deck for a note", "update-note", ["noteId"]],
    ["get_statistics", "Read collection statistics", "get-statistics", []],
    ["check_integrity", "Check collection and Markdown references", "check-integrity", []],
    [
        "import_cards",
        "Import a bounded batch from another tool",
        "import-cards",
        ["source", "cards"],
    ],
    ["list_ai_requests", "List pending AI co-author requests from Obsidian", null, []],
    [
        "resolve_ai_request",
        "Return reviewed card proposals for a pending AI request",
        null,
        ["requestId", "result"],
    ],
    ["reject_ai_request", "Reject a pending AI request with an explanation", null, ["requestId"]],
];

const tools = definitions.map(([name, description, , required]) => ({
    name,
    description,
    inputSchema: { type: "object", additionalProperties: true, required },
}));
const operationByTool = Object.fromEntries(
    definitions.map(([name, , operation]) => [name, operation]),
);

const sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function callPlugin(operation, payload) {
    await mkdir(inbox, { recursive: true });
    await mkdir(outbox, { recursive: true });
    const id = randomUUID();
    const requestPath = join(inbox, `${id}.request.json`);
    const temporaryPath = `${requestPath}.tmp`;
    const responsePath = join(outbox, `${id}.response.json`);
    const request = {
        version: 1,
        id,
        operation,
        payload,
        token,
        source: "mcp",
        requestedAt: Date.now(),
    };
    await writeFile(temporaryPath, JSON.stringify(request, null, 2), { mode: 0o600 });
    await rename(temporaryPath, requestPath);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            const response = JSON.parse(await readFile(responsePath, "utf8"));
            await rm(responsePath, { force: true });
            if (!response.ok) throw new Error(response.error?.message ?? "MSRE request failed");
            return response.result;
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        await sleep(250);
    }
    throw new Error("MSRE request timed out. Open Obsidian and enable the MCP queue.");
}

function safeAiRequestId(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) {
        throw new Error("Invalid AI request id");
    }
    return value;
}

async function listAiRequests() {
    await mkdir(aiRequests, { recursive: true });
    const names = (await readdir(aiRequests))
        .filter((name) => name.endsWith(".request.json"))
        .sort()
        .slice(0, 20);
    return await Promise.all(
        names.map(async (name) => JSON.parse(await readFile(join(aiRequests, name), "utf8"))),
    );
}

async function resolveAiRequest(payload) {
    const requestId = safeAiRequestId(payload?.requestId);
    const requestPath = join(aiRequests, `${requestId}.request.json`);
    JSON.parse(await readFile(requestPath, "utf8"));
    if (
        !payload.result ||
        typeof payload.result !== "object" ||
        !Array.isArray(payload.result.cards)
    ) {
        throw new Error("result.cards is required");
    }
    await mkdir(aiResponses, { recursive: true });
    const responsePath = join(aiResponses, `${requestId}.response.json`);
    const temporaryPath = `${responsePath}.tmp`;
    const serialized = JSON.stringify(
        {
            version: 1,
            id: requestId,
            ok: true,
            result: payload.result,
            completedAt: Date.now(),
        },
        null,
        2,
    );
    if (serialized.length > 1_000_000) throw new Error("AI response is too large");
    await writeFile(temporaryPath, serialized, { mode: 0o600 });
    await rename(temporaryPath, responsePath);
    await rm(requestPath, { force: true });
    return { requestId, delivered: true };
}

async function rejectAiRequest(payload) {
    const requestId = safeAiRequestId(payload?.requestId);
    const requestPath = join(aiRequests, `${requestId}.request.json`);
    JSON.parse(await readFile(requestPath, "utf8"));
    await mkdir(aiResponses, { recursive: true });
    const responsePath = join(aiResponses, `${requestId}.response.json`);
    const temporaryPath = `${responsePath}.tmp`;
    await writeFile(
        temporaryPath,
        JSON.stringify(
            {
                version: 1,
                id: requestId,
                ok: false,
                error: {
                    code: "agent-rejected",
                    message:
                        typeof payload?.message === "string"
                            ? payload.message.slice(0, 1000)
                            : "The connected agent rejected this request",
                },
                completedAt: Date.now(),
            },
            null,
            2,
        ),
        { mode: 0o600 },
    );
    await rename(temporaryPath, responsePath);
    await rm(requestPath, { force: true });
    return { requestId, delivered: true };
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
    try {
        let result;
        if (message.method === "initialize") {
            result = {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "msre", version: "1.0.0" },
            };
        } else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = { tools };
        else if (message.method === "tools/call") {
            const name = message.params?.name;
            const payload = message.params?.arguments ?? {};
            let value;
            if (name === "list_ai_requests") value = await listAiRequests();
            else if (name === "resolve_ai_request") value = await resolveAiRequest(payload);
            else if (name === "reject_ai_request") value = await rejectAiRequest(payload);
            else {
                const operation = operationByTool[name];
                if (!operation) throw new Error("Unknown MSRE tool");
                value = await callPlugin(operation, payload);
            }
            result = { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
        } else throw new Error(`Unsupported method: ${message.method}`);
        send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
        send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    try {
        void handle(JSON.parse(line));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
});
