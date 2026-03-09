# Whying Anki Sync

Obsidian desktop plugin for staged one-way sync from Obsidian card blocks into Anki.

## Current status

Phase 1 to phase 3 are implemented:

- Parse `card-start` / `card-back` / `card-end` blocks.
- Validate card syntax per file.
- Generate stable local `uid` values and `rev` hashes.
- Rewrite `card-end` metadata atomically with `Vault.process()`.
- Persist a local index for future sync and deletion phases.
- Connect to Anki through AnkiConnect.
- Validate the `Basic` model before syncing.
- Create new notes with `addNote`.
- Update existing notes with `updateNoteFields`.
- Delete removed notes through the pending delete queue.
- Handle file-path reconciliation at startup.
- Preserve note mappings across file renames.

Planned next phases:

- Phase 4: user experience improvements such as source links and richer commands.

## Card syntax

```md
<!-- card-start deck="Biology::Energy" tags="atp,cell" -->
What does ATP stand for?
<!-- card-back -->
Adenosine Triphosphate
<!-- card-end uid="c_..." rev="sha256:..." -->
```

Supported file defaults:

```md
---
anki-deck: Biology::Cell
anki-tags: [bio, exam]
---
```

## Commands

- `Sync cards to Anki`
- `Insert card template`
- `Validate card syntax in current file`
- `Refresh card metadata in current file`
- `Rebuild sync index`

## Development

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run lint`

The project pins Node and npm with Volta in `package.json`.
