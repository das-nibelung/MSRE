# Automation API

MSRE exposes a stable, versioned API at:

```js
const api = app.plugins.plugins["personal-spaced-repetition"].api;
```

This works from QuickAdd, Templater, DataviewJS, and other trusted Obsidian plugins. Enable automation in **Settings → Data** first. Write methods also require **Allow changes**.

```js
await api.createCard(
    { deckPath: "Medicine/Cardiology", front: "Question", back: "Answer", tags: ["exam"] },
    "quickadd",
);

const cards = await api.findCards({ deckPath: "Medicine", query: "ECG" }, "dataview");
const unsubscribe = api.on("review-recorded", ({ reviewId }) => console.log(reviewId));
```

Available methods: `createCard`, `createDeck`, `addMedia`, `findCards`, `updateNote`, `getStatistics`, `checkIntegrity`, `importCards`, `execute`, and `on`. Returned records are plain serializable objects.

## AI provider plugins

The native card editor includes an AI co-author with a review-before-apply workflow. Another Obsidian plugin can add a provider—Codex included—without writing cards itself:

```js
const unregister = api.registerAiProvider({
    id: "codex",
    label: "Codex",
    description: "Use the authenticated Codex connection from this plugin",
    async run(request) {
        // Send request.task, request.sourceText, and request.currentCard to the provider.
        return {
            summary: "Atomic study prompts",
            cards: [{ front: "Question", back: "Answer", type: "basic", tags: [] }],
        };
    },
});
```

Call `unregister()` when the provider plugin unloads. The editor validates the returned structure, shows every proposal, and requires the user to choose what to apply. See `api.d.ts` for the complete request and result types.

## Obsidian URI

The non-destructive UI links are `obsidian://msre?action=open-creator` and `obsidian://msre?action=open-browser`. Automated operations require the access token and either a URL-encoded JSON `payload` or simple fields such as `deck`, `front`, and `back`.

## Security

External operations use a secret token, optional allowed deck roots, a batch limit, a 20 MB media limit, a sequential operation queue, and a bounded JSONL audit log. MCP never edits card files directly.
