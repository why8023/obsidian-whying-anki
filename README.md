# OBAK

Obsidian desktop plugin for one-way Markdown card sync into Anki.

Chinese README: [README.zh-CN.md](README.zh-CN.md)

## Overview

OBAK treats Obsidian as the source of truth. It scans Markdown files for card blocks, syncs them to Anki through AnkiConnect, and keeps enough local index state to support incremental sync, file renames, and file deletions.

Current implementation highlights:

- Parse `card-start` / `card-back` / `card-end` blocks from Markdown files.
- Rewrite `card-end` markers atomically with the synced Anki `id`.
- Persist a local file-to-note index for incremental sync and delete reconciliation.
- Auto-create or repair the `OBAK Basic` Anki model before syncing.
- Auto-create missing decks when enabled.
- Create, update, and delete Anki notes to match the vault.
- Preserve note tracking across file renames.
- Queue deleted-file cleanup locally and apply it on the next sync.
- Store Obsidian URI, path, and computed revision in Anki fields.
- Render an `Open in Obsidian` link on the card back.
- Render Markdown to Anki HTML, including task lists, `==mark==`, math, tables, raw HTML, and supported remote media embeds.
- Optionally run incremental auto sync after edits stop or tracked files change.
- Optionally export a deck backup before bulk note deletion.

## Requirements

- Obsidian desktop only.
- Anki desktop running with AnkiConnect enabled.
- AnkiConnect version 6 or newer.
- Default AnkiConnect endpoint: `127.0.0.1:8765`.

## Card syntax

Minimal example:

```md
<!-- card-start deck="Biology::Energy" tags="atp,cell" -->
What does ATP stand for?
<!-- card-back -->
Adenosine triphosphate
<!-- card-end -->
```

After the first successful sync, OBAK rewrites the end marker with the Anki note id:

```md
<!-- card-end id="1759203812345" -->
```

Supported file defaults:

```md
---
anki-deck: Biology::Cell
anki-tags:
  - bio
  - exam
---
```

Rules:

- `card-start` accepts built-in `deck="..."` and `tags="tag1,tag2"` attributes, and also allows extra custom `key="value"` attributes.
- Unknown custom attributes on `card-start` are parsed but ignored during sync; `deck` and `tags` remain reserved attribute names.
- `card-back` accepts no attributes.
- `card-end` is plugin-managed and currently stores only `id="..."`.
- If `card-end` has no `id`, the card is treated as new.
- Legacy `rev="..."` markers are tolerated on read and removed on rewrite.
- Legacy `uid="..."` markers are not supported by the current parser.
- Markers must be in order and cards cannot be nested.
- Front and back cannot both be empty.

Deck resolution order:

- Explicit `deck="..."` on `card-start`
- `anki-deck` in file frontmatter
- `Default deck::folder::note`
- `Default deck`

Tag resolution merges plugin default tags, file `anki-tags`, and per-card `tags`.

## Markdown support

Card bodies are normalized and rendered to HTML before sync. Current support includes:

- Common Markdown blocks and inline formatting
- Tables
- Task lists
- `==highlight==`
- Inline and display math
- Raw inline HTML
- Remote `http` / `https` media embeds with known extensions

Supported remote media conversion:

- Images: `apng`, `avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `webp`
- Audio: `aac`, `flac`, `m4a`, `mp3`, `oga`, `ogg`, `opus`, `wav`
- Video: `m4v`, `mov`, `mp4`, `ogv`, `webm`

Local Obsidian embeds and unsupported media URLs are left as literal text for now.

## Sync behavior

- Full sync scans every Markdown file in the vault.
- Incremental sync scans dirty files, recent file changes, pending-sync files, and tracked delete state.
- Full sync compares against existing `OBAK Basic` notes in Anki and can delete notes that no longer exist in the vault when the full scan is trusted.
- Deleted files are handled in two steps: record locally first, then confirm and delete in Anki on a later sync.
- File renames update the local index so note ownership follows the new path.
- `Refresh card metadata in current file` and `Rebuild sync index` are local maintenance commands. They update local markers and index state but do not claim Anki is already synced.
- File rewrites use `Vault.process()` and abort if the file changed mid-rewrite.

## Commands

- `Sync cards to Anki`
- `Sync changed cards to Anki`
- `Validate card syntax in current file`
- `Refresh card metadata in current file`
- `Rebuild sync index`
- `Make card`
- `Delete card`
- `Insert card template`

The editor template command inserts:

```md
<!-- card-start -->
Front
<!-- card-back -->
Back
<!-- card-end -->
```

## Settings

- Default deck
- Default tags
- Anki host
- Anki port
- Auto-create missing decks
- Reconcile on startup
- Auto-sync incremental changes
- Auto-sync delay
- Backup before bulk delete
- Bulk delete backup export path
- Bulk delete backup threshold
- Show detailed error notices
- Verbose console logging

## Anki model

OBAK syncs into a custom note type named `OBAK Basic`. The plugin creates or repairs it automatically.

Fields:

- `ObakSyncId`
- `AnkiDeck`
- `AnkiTags`
- `AnkiNoteId`
- `Front`
- `Back`
- `ObsidianUri`
- `ObsidianPath`
- `ObsidianRev`

The back template includes an `Open in Obsidian` link when `ObsidianUri` is present.

## Development

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run lint`

`package.json` pins `node` and `npm` through Volta:

- `node`: `22.20.0`
- `npm`: `10.9.3`

## Releases

- Bump the version with `npm version patch`, `npm version minor`, or `npm version major`.
- The repo `version` script updates `manifest.json` and `versions.json`.
- Push the commit and the version tag without a leading `v`.
- Release artifacts are `main.js`, `manifest.json`, and `styles.css`.

## License

0BSD
