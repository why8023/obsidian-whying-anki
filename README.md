# obak

Obsidian desktop plugin for staged one-way sync from Obsidian card blocks into Anki.

## Current status

Phase 1 to phase 4 are implemented:

- Parse `card-start` / `card-back` / `card-end` blocks.
- Validate card syntax per file.
- Generate stable local `uid` values and `rev` hashes.
- Rewrite `card-end` metadata atomically with `Vault.process()`.
- Persist a local index for future sync and deletion phases.
- Connect to Anki through AnkiConnect.
- Auto-create and validate the `OBAK Basic` model before syncing.
- Auto-create missing decks before adding notes.
- Create new notes with `addNote`.
- Update existing notes with the custom field set and `changeDeck`.
- Delete removed notes through the pending delete queue.
- Handle file-path reconciliation at startup.
- Preserve note mappings across file renames.
- Store the Obsidian source URI in a dedicated note field rendered by the card template.
- Convert remote Markdown embeds like `![](<https://.../image.png>)` into Anki-ready HTML media tags.

Planned next phases:

- Future work can focus on deeper UX polish and end-to-end integration tests.

## Card syntax

```md
<!-- card-start deck="Biology::Energy" tags="atp,cell" -->
What does ATP stand for?
<!-- card-back -->
Adenosine Triphosphate
<!-- card-end uid="..." rev="sha256:..." -->
```

Remote media embeds are supported inside the Front and Back content. The sync step converts Obsidian-style external embeds into HTML that Anki can render based on the URL extension:

- Images: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`, `bmp`, `apng`
- Audio: `mp3`, `wav`, `ogg`, `oga`, `opus`, `m4a`, `flac`, `aac`
- Video: `mp4`, `webm`, `mov`, `m4v`, `ogv`

Example:

```md
<!-- card-start -->
Name the structure shown below.
<!-- card-back -->
![](https://img.whynia.wang/20260309_1c371986b8ff8d2bc975039b78a5d213.png)
<!-- card-end -->
```

Supported file defaults:

```md
---
anki-deck: Biology::Cell
anki-tags: [bio, exam]
---
```

Deck priority is:

- Explicit `deck="..."` on `card-start`
- `anki-deck` in file frontmatter
- `Default deck::vault::relative::file`
- `Default deck`

## Commands

- `Sync cards to Anki`
- `Sync changed cards to Anki`
- `Insert card template`
- `Validate card syntax in current file`
- `Refresh card metadata in current file`
- `Rebuild sync index`

## Sync flow

```mermaid
flowchart TD
    A[Trigger] --> A1{Entry point}
    A1 -->|Manual full sync| B[Sync cards to Anki]
    A1 -->|Manual incremental sync| C[Sync changed cards to Anki]
    A1 -->|Auto sync after edit, file leave, rename, or delete| C
    A1 -->|Startup reconcile| R[Reconcile missing files only]
    A1 -->|Refresh metadata or rebuild index| M[Local-only maintenance path]

    R --> R1[Compare tracked files in index vs current vault]
    R1 --> R2[Mark missing files as deletedFilePaths tombstones]
    R2 --> R3[Persist data.json and wait for the next real sync]

    M --> M1{Command}
    M1 -->|Refresh card metadata in current file| M2[Scan file and rewrite uid, noteId, rev markers]
    M1 -->|Rebuild sync index| M3[Rescan whole vault and rebuild cardsByUid plus uidsByFile]
    M2 --> M4[Preserve only known lastSyncedRev values already trusted in the index]
    M3 --> M4
    M4 --> M5[Do not advance the global sync cursor]

    B --> D[Acquire exclusive sync lock]
    C --> D
    D --> E{Vault markdown files ready?}
    E -->|No| Z1[Abort safely and show vault still loading]
    E -->|Yes| F{Full or incremental}

    F -->|Full| G[Select all markdown files]
    F -->|Incremental| H[Select files with pending work]
    H --> H1[Dirty files]
    H --> H2[Files newer than lastSyncAt]
    H --> H3[Files whose tracked cards still have no noteId or no lastSyncedRev]
    H --> H4[Deleted-file tombstones and restored deleted files]

    G --> I[Scan markdown into ParsedCard objects]
    H --> I
    I --> I1[Parse card-start, card-back, card-end]
    I --> I2[Apply frontmatter defaults and plugin defaults]
    I --> I3[Render markdown to Anki HTML]
    I --> I4[Compute current rev hash from content, deck, tags, path, and Obsidian URI]
    I --> I5[Filter duplicate UID conflicts]

    I5 --> J[Connect to AnkiConnect]
    J --> J1[Check AnkiConnect version]
    J --> J2[Ensure OBAK Basic model fields, templates, and CSS are valid]
    J2 --> K[Prepare sync state]
    K --> K1[Ensure each card has a stable uid]
    K --> K2[Recover noteId from local index when possible]
    K --> K3[Recover missing noteId by querying ObsidianUid in Anki]
    K --> K4[Preflight create candidates with canAddNotes]
    K --> K5[Ensure target decks exist when auto-create is enabled]

    K5 --> L[Resolve deletions]
    L --> L1[Cards removed from a live file become delete candidates]
    L --> L2[Files missing from the vault use tracked noteIds as delete candidates]
    L --> L3[Moved UID found elsewhere in the vault means do not delete]
    L --> L4[Unsynced orphan cards with no noteId are cleaned locally only]

    L4 --> N{Need bulk delete backup?}
    N -->|Yes| N1[Export default deck to timestamped .apkg]
    N -->|No| O[Delete queued noteIds in Anki]
    N1 --> O

    O --> P[Sync cards file by file]
    P --> P1[Per card choose create, update, unchanged, or skip]
    P1 --> P2[Create: addNote, then updateNote to write back AnkiNoteId]
    P1 --> P3[Update: updateNote fields and tags, then changeDeck on card ids]
    P1 --> P4[Unchanged: current rev equals lastSyncedRev]
    P1 --> P5[Remote failure or blocked create: keep file dirty for retry]

    P2 --> Q[Rewrite card-end markers with latest uid, noteId, rev]
    P3 --> Q
    P4 --> Q
    P5 --> Q

    Q --> Q1[Use atomic Vault.process rewrite and abort if file changed mid-write]
    Q1 --> S[Update local index]
    S --> S1[Write cardsByUid and uidsByFile]
    S --> S2[Advance lastSyncedRev only after a real successful sync]
    S --> S3[Preserve unseen old cards when delete phase failed or parse errors exist]
    S --> S4[Clear dirty only for files that finished cleanly]

    S4 --> T{Advance global sync cursor?}
    T -->|Full or incremental sync only| T1[Set lastSyncAt and lastScanConfigHash]
    T -->|Maintenance path| T2[Leave cursor unchanged]

    T1 --> U[Persist data.json]
    T2 --> U
    U --> V[Show progress and result notice]
```

Key points:

- `data.json` is the local sync state store. The important fields are `cardsByUid`, `uidsByFile`, `pendingDeleteNoteIds`, `deletedFilePaths`, `lastSyncAt`, and `lastScanConfigHash`.
- `Refresh card metadata in current file` and `Rebuild sync index` are maintenance commands. They can rewrite local markers and rebuild index state, but they do not claim that Anki is already in sync.
- Incremental sync is not only `dirty + mtime`. It also revisits files whose tracked cards still have incomplete sync state, such as missing `noteId` or missing `lastSyncedRev`.
- File deletion is intentionally two-phase: vault events and startup reconcile only record tombstones locally, and a later sync run performs the actual Anki deletion.
- A file is cleared from the dirty set only when its remote sync path finishes cleanly. Remote failures stay eligible for retry on the next incremental sync.

## Development

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run lint`

The project pins Node and npm with Volta in `package.json`.

## Releases

Push a version tag that exactly matches `package.json` and `manifest.json` to build and publish the plugin assets to GitHub Releases automatically.

- Update the version with `npm version patch`, `npm version minor`, or `npm version major`.
- Push the commit and tag with `git push origin main --follow-tags`.
- The release workflow uploads `main.js`, `manifest.json`, and `styles.css`.

If you prefer creating releases in the GitHub UI, publishing a release for an existing version tag runs the same workflow and refreshes the uploaded assets.
