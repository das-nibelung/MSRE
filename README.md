# Personal Spaced Repetition

This is a personal, mobile-compatible fork of
[Obsidian Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition).
It keeps the upstream MIT license and attribution while providing an independent
plugin ID so that custom releases can be installed and updated with BRAT without
being overwritten by the official plugin.

## Install with BRAT

1. Install and enable **BRAT** from Obsidian Community Plugins.
2. Run **BRAT: Add a beta plugin for testing**.
3. Enter `https://github.com/das-nibelung/MSRE`.
4. Select the latest release and enable the plugin after installation.

Install the fork separately on desktop and iPhone. Disable the official
`Spaced Repetition` plugin before enabling this fork so that both plugins do not
write scheduling information to the same notes.

## Automation and MCP

Stage 15 adds a versioned API for QuickAdd, Templater, DataviewJS, and other
trusted Obsidian plugins, protected `obsidian://msre` actions, and a local MCP
server for agents. Cards remain ordinary Markdown files; external tools submit
validated operations through MSRE instead of editing the collection directly.
Enable the API, write access, and MCP queue independently in **Settings → Data**.
See [the API guide](docs/automation-api.md) and [MCP setup](mcp/README.md).

## Review reminders

The **Reminder Center** turns reminders into a small study control panel rather
than a wall of settings. Open it from the command palette to inspect today's
load, the short forecast, weak cards, focused rules, and delivery history.
Global reminders support selected weekdays, exact local times, quiet hours,
minimum-card thresholds, cooldowns, and one-tap snooze or skip-until-tomorrow.
Additional rules can target one deck or knowledge area and react to overload,
the upcoming forecast, an area deadline, or weak cards.

Delivery can stay completely local through Obsidian notices and desktop system
notifications. Optional self-hosted delivery supports **ntfy**, **Gotify**, and
**Home Assistant**. External messages include an `obsidian://msre` link that
opens the matching review queue on mobile. Connection tokens remain in local
device storage and are never written into synced plugin data. Configure the
schedule and channels in **Settings → Scheduling → Reminder policy**, then use
**Send test** before relying on an external channel.

## Obsidian-native card workflow

The fork includes a persistent **Cards** view that uses the already-loaded
incremental index instead of rescanning the vault. It supports instant search
across questions, answers, decks, and note paths; filters for new, due, and
scheduled cards; and opens every result at its original note block.

Use **Personal Spaced Repetition: Create flashcard** from the command palette to
turn selected text into a basic card. The plugin adds the configured flashcard
tag when necessary. A new vault can also create its first starter card directly
from the empty deck screen. These workflows work offline on desktop and mobile.

The editor context menu can also create basic, two-way, and cloze cards from a
selection. The file menu opens the browser already filtered to the current note.
Inside the browser, cards can be narrowed by scheduling state and deck, then
sorted by due status, question, or source note without rescanning Markdown.
Each browser row can be edited in place or opened in its source note. A native
overflow menu keeps secondary actions out of the main interface: bury until
tomorrow, confirmed progress reset, and confirmed source deletion. Scheduled
cards show their due date, interval, and ease. Edits still write back to the
original Markdown question, preserving Obsidian as the source of truth.

The browser supports persistent multi-selection across filters, selecting all
current search results, resetting the selected schedules in one confirmed
operation, and burying a selection until tomorrow. The review-session overflow
menu exposes the same bury action. When the browser is scoped to a note, its
review button starts that note's queue directly instead of returning to the
global deck picker.

The mobile study flow uses a touch-first deck dashboard, compact card library,
four adaptive rating controls, swipe shortcuts, one-step source-note access,
single-level review undo, and an end-of-session summary. Keyboard review follows
the familiar `1` Again, `2` Hard, `3` Good, `4` Easy layout, with `Ctrl/Cmd+Z`
for undo. Visible controls remain available for every gesture action.
Mobile review opens as a native Obsidian workspace view to keep controls clear
of the iOS status bar. The study canvas uses a centered layered card, adaptive
reading typography, and a compact response dock.

## Incremental card index

This fork keeps a disposable, device-local card index in IndexedDB. Unchanged
notes are restored from the index instead of being read and parsed again. File
create, modify, delete, and rename events invalidate only the affected note.
Parser-setting changes automatically rebuild entries as they are encountered.
When no files or settings have changed, reopening a deck skips the vault scan
entirely and only refreshes due-state calculations from the loaded card tree.
When a small set of notes changes, their previous cards are removed and only
those notes are reparsed. The remaining in-memory deck tree and note-review
queue stay intact. Large batches and structural folder changes automatically
fall back to a full, safe rebuild.

On first review, each question receives a persistent Obsidian block ID such as
`^sr-data-id-…`. Existing user-created block IDs are preserved. Together with
the sibling card number, this gives every card a stable identity that survives
question text edits and moves within the vault.

Reviewed-card schedules are also backed up to
`Spaced Repetition/schedule-data.sr.md`. The file stays inside the vault for
offline use and normal vault sync. Inline `<!--SR:...-->` comments remain the
primary source; if one is accidentally removed, the schedule is restored by
stable ID. Use the plugin's reset/delete actions when removal is intentional so
the synchronized backup is cleared as well.

Markdown remains the source of truth. The index is safe to discard and is not
written into the vault, so it does not create sync conflicts between desktop
and mobile devices. If IndexedDB is unavailable, the plugin falls back to an
in-memory index for the current session.

## File-native library

Native-editor cards now keep their stable note ID, note type, editable fields,
tags, deck, answer mode, and generated-card identities in a portable manifest
inside the same Markdown file. The manifest is an HTML comment, so it does not
change reading view or card rendering and it travels with the note when it is
moved or synchronized.

`Spaced Repetition/library.sr.md` is the portable catalog for note types, card
templates, deck presets, decks, and knowledge areas. The collection file and
IndexedDB index are materialized views: if either is deleted, the plugin rebuilds
the editable collection from the catalog, card manifests, review history, and
schedule ledger. Existing native cards are upgraded automatically on first load;
ordinary hand-written Markdown cards continue to work without any manifest.

This keeps the Obsidian model intact: the complete library can be inspected,
versioned, backed up, and restored as normal vault files. No opaque database is
required to preserve the meaning of a card.

## Crash-safe vault writes

Card edits, the portable library catalog, collection materializations, review
history, and the schedule ledger now use one journaled vault writer. Before the
plugin changes a file, it stores the intended contents in
`Spaced Repetition/Recovery/Pending`, keeps a bounded snapshot of the previous
version, verifies the completed write, and removes the temporary transaction.

If Obsidian, iOS, or synchronization stops during a save, the transaction is
replayed automatically on the next plugin start. If another device changed the
same target in the meantime, MSRE never overwrites that newer file: the local
candidate is preserved in `Spaced Repetition/Recovery/Conflicts` and a notice
explains where to find it. Recovery candidates use a non-Markdown extension so
they cannot accidentally appear as duplicate cards. Snapshots are limited to
the twelve newest versions per file.

## Anki and spreadsheet transfer

Open **Cards → Import & export** (or the command palette action) to preview an
Anki `.apkg` before changing the vault. The importer carries over decks and
subdecks, note types, fields, templates, card CSS, media, Image Occlusion output,
card state, flags, and review history. Stable Anki GUIDs are stored in each
portable Markdown manifest, so importing the same package again can keep,
update, or deliberately copy existing notes without accidental duplicates. A
recoverable collection snapshot is created before every import.

The same workspace exports a broadly compatible `.apkg` into
`Spaced Repetition/Exports`. CSV and TSV imports provide an explicit field
mapping preview, while CSV export offers a simple interchange format for other
tools. All operations work offline; the native collection database remains a
disposable materialized view of vault files.

## Upstream project

The original project, documentation, and contributor history are available at
[st3v3nmw/obsidian-spaced-repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition).

---

# Upstream documentation

![SR_Banner](./docs/media/en/SR_Banner.jpg)

<img src="https://img.shields.io/github/downloads/st3v3nmw/obsidian-spaced-repetition/total" /> <img src="https://img.shields.io/github/downloads/st3v3nmw/obsidian-spaced-repetition/latest/total" /> <img src="https://img.shields.io/github/manifest-json/v/st3v3nmw/obsidian-spaced-repetition" /> <img alt="Codecov" src="https://img.shields.io/codecov/c/gh/st3v3nmw/obsidian-spaced-repetition">

Fight the forgetting curve by reviewing flashcards & notes using the FSRS or the SM-2 [spaced repetition](https://en.wikipedia.org/wiki/Spaced_repetition) algorithms.

- For more information on how to use the plugin, check either the TL;DR on this page or the [documentation](https://stephenmwangi.com/obsidian-spaced-repetition/).
- Raise an [issue](https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/) if you have a feature request or a bug report.
- Visit the [discussions](https://github.com/st3v3nmw/obsidian-spaced-repetition/discussions/) section for Q&A help, feedback, and general discussion.
- The plugin has been translated into _Arabic, Chinese, Czech, Dutch, French, German, Italian, Korean, Japanese, Polish, Portuguese, Spanish, Russian, Turkish, and Ukrainian_ by the Obsidian community 😄.
    - To help translate this plugin to your language, check the [translation guide here](https://stephenmwangi.com/obsidian-spaced-repetition/contributing/#translating_1).

<br/>

## Features⚡

#### Native Obsidian knowledge tools

- **Study Base** — run `Personal Spaced Repetition: Create or open study Base` to create a native `.base` file. It includes All cards, Today, Errors, Weak, and No area views; one-row-per-note or one-row-per-card layouts; saved sorts and diagnostic column sets; inline deck/tag/area editing; bulk note-type and template changes; multi-level Undo; editable CSV round trips; and reusable Base snapshots.
- **Interactive Knowledge Graph + Canvas** — open the live graph to search, filter, collapse, pan, zoom, find the shortest path, drag decks into areas, and create areas or decks in context. Switch to `Knowledge Map.canvas` whenever you want a free-form Obsidian canvas; automatic refresh preserves manual positions, annotations, and user edges.
- **Knowledge Hub and embeds** — the generated `Knowledge Hub.md` is a live MOC for areas, decks, source notes, and review actions. A `spaced-repetition` Markdown code block embeds a compact study dashboard or linked-note panel in any note.
- **Properties, menus, links, and previews** — `sr_cards`, `sr_due`, `sr_decks`, `sr_areas`, lapses, and retention are synchronized automatically when study data changes, without rewriting unchanged notes. Source links target the exact card block, support modifier-click, and use Obsidian Page Preview on hover.
- **Knowledge Compiler lifecycle** — compile a note, folder, or hand-picked queue into traceable cards. Before writing, the workbench shows an exact create/update/rename/orphan diff. Renamed concepts keep their existing card, stale sources can be queued together, manual versions are never overwritten, and every operation can be rolled back from portable history files after a LiveSync-safe conflict check. Compiled cards link back to the exact source lines.
- **Intelligence Center and Source Lab** — inspect duplicates, contradictions, knowledge gaps, overloaded cards, and likely mistakes with transparent local evidence. Import Markdown, Canvas, PDF, image, or audio sources; optionally add local OCR or route multimodal work through a direct API, MCP/Codex, or a compatible Obsidian provider.

#### Reviewing Flashcards🗃️

- [Getting started](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/flashcards-overview/) (Using Obsidian's hierarchical tags or folder structure)
- Creating Flashcards
    - [Single-line style](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/q-and-a-cards/#single-line-basic) (`Question::Answer`)
    - [Single-line reversed style](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/q-and-a-cards/#single-line-bidirectional) (`Question:::Answer`)
    - [Multi-line style](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/q-and-a-cards/#multi-line-basic) (Separated by `?`)
    - [Multi-line reversed style](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/q-and-a-cards/#multi-line-bidirectional) (Separated by `??`)
    - [Cloze cards](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/cloze-cards/) (`==highlight==` your cloze deletions!, `**bolded text**`, `{{text in curly braces}}`, or use custom cloze patterns)
    - Rich text support in flashcards (inherited from Obsidian)
        - Images, Audio, & Video
        - LaTeX
        - Code syntax highlighting
        - Footnotes
- [Organize Decks](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/decks/) (Using Obsidian's hierarchical tags or folder structure)
- [Card context - automatic titles based on headings](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/reviewing/#context) (i.e. `Note title > Heading 1 > Subheading`)

#### Reviewing Notes📄

- [Getting started](https://stephenmwangi.com/obsidian-spaced-repetition/notes/)
- [Due Notes for review](https://stephenmwangi.com/obsidian-spaced-repetition/notes/#note-review-queue)
- [How to review a note](https://stephenmwangi.com/obsidian-spaced-repetition/notes/#reviewing)

#### [Statistics📈](https://stephenmwangi.com/obsidian-spaced-repetition/flashcards/statistics/)

<br/>
<br/>

## Usage TL;DR🚀

### Creating Decks

1. Add the tag `#flashcards` in a note, where you want to write your cards
2. If you want to have your cards in a specific sub deck, then add your sub deck name to the tag like so: `#flashcards/YOUR_SUB_DECK_NAME`
3. Write your card in the note which where you've added your tag

<br/>

### Creating Cards

##### 1. Decide what card type you need:

- Single line -> Card format:
  `Question::Answer`
- Single line reversable -> Card format:
  `Question:::Answer`
- Multi line -> Card format:
    ```
    Question
    ?
    Answer
    ```
- Multi line reversable -> Card format:
    ```
    Question
    ??
    Answer
    ```

##### 2. Write your card (In one of those formats) in a note that you have tagged as a deck

<br/>

### Reviewing Cards

##### 1.1. Open the list of all decks with either of two commands(ctrl+p):

- _Review Flashcards from all notes_
  -> Here the algorithm decides based on your past reviews, which cards are due to review
- _Select a deck to cram_
  -> All decks and all cards are reviewable and the algorithm is fully ignored

##### 1.2. Or open the list of all decks within your currently opened note(ctrl+p):

- _Review flashcards in this note_
  -> Here the algorithm decides based on your past reviews, which cards from this note are due to review
- _Cram flashcards in this note_
  -> All decks and all cards from this note are reviewable and the algorithm is fully ignored

![Deck view](./docs/media/en/deck-view.png)

##### 2. Select a deck via the list and click on the deck name

##### 3. Rate your ability to remember the answer to the current question

- This tells the algorithm what you know well and what you don't

![Card view](./docs/media/en/card-view.png)

<br/>

### Creating & reviewing whole notes

Sometimes it makes more sense to recall a whole note, when it isn't just pure facts which you have to learn.
This is where marking a note for review comes in handy.

1. Just like with decks add the tag `#review` to your note to mark them as reviewable
2. To see which notes are due for review open the note review queue via the command(ctrl+p): _Open Notes Review Queue in sidebar_
3. There you can open up the notes for review, just as if you would open them up in your file explorer, only that they are sorted her by when they are due for review
4. Once you have recalled/reviewed your note you can rate your recall ability by executing the command(ctrl+p, or just via the 3 dots next to the note): _Review note as YOUR_RATING_ - The algorithm will take your rating into account to calculate a new due date, when you have to review it again
   <br/>

## Links & Resources🔗

- [Documentation](https://stephenmwangi.com/obsidian-spaced-repetition/).
- [Roadmap](https://github.com/st3v3nmw/obsidian-spaced-repetition/projects/3/)
- [Dev News](https://github.com/st3v3nmw/obsidian-spaced-repetition/discussions/categories/development-news)
- [Issues](https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/)
- [Discussions](https://github.com/st3v3nmw/obsidian-spaced-repetition/discussions/)

<br/>

## Support Development💻

<table>
    <thead>
        <tr>
            <th>Stephen Mwangi (Owner)</th>
            <th>Kyle Klus (Maintainer)</th>
        </tr>
    </thead>
    <tbody>
  <tr>
    <td align="center">
        <a href='https://ko-fi.com/M4M44DEN6' target='_blank' style="text-decoration: none;">
            <img height='30' style='border:0px;height:30px;' src='https://cdn.ko-fi.com/cdn/kofi3.png?v=2' border='0' alt='Buy Me a Coffee at ko-fi.com' />
        </a>
    </td>
    <td align="center">
      <a href="https://github.com/KyleKlus" style="text-decoration: none;">
        <img src="https://img.shields.io/badge/Kyle%20Klus-darkgreen?style=flat&logo=github&label=Github&link=https%3A%2F%2Fgithub.com%2FKyleKlus
        " alt="Github">
      </a>
    </td>
  </tr>
    </tbody>
</table>
