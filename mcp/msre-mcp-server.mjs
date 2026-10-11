#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
            const operation = operationByTool[message.params?.name];
            if (!operation) throw new Error("Unknown MSRE tool");
            const value = await callPlugin(operation, message.params?.arguments ?? {});
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
