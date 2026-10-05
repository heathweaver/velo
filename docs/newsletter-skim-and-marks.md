# Newsletter AI skim + easy marks

**Status**: MVP slice (`feat/newsletter-skim-and-marks`)  
**Defaults (locked)**:
- File into IMAP **Reads** (top-level preferred)
- Notify before file; **new-mail only**; **no delete**
- MCP later over hosted velo-server HTTP
- Marks: Interesting / Noise / Always Reads / Stop auto-treat

DreamHost panel filters are abandoned; Velo owns rules + preferences locally (and later on velo-server).

---

## Mark types

Each mark is applied to the **sender** of the focused (or selected) thread. Preferences live in SQLite `newsletter_sender_prefs`. Filter rules reuse the existing `filter_rules` table (same path as ContactSidebar “Always file as”).

| Mark | Preference write | Rule write |
|------|------------------|------------|
| **Interesting** | `preference_score += 1` (boost sender/topic for future digests) | none (unless a Stop had disabled rules — re-enable) |
| **Noise** | `preference_score -= 1` | optional reject: upsert From→`archive` + `markRead` (demote out of inbox). Does **not** delete. |
| **Always Reads** | `always_reads = 1` | upsert From→`applyLabel` **Reads** when an IMAP/Gmail label/folder named Reads exists; otherwise interim `setCategory: "Newsletters"` (or a user category id `"Reads"` if present). **Server MOVE into IMAP Reads is the real target** — client category is a stopgap until the filer runs. |
| **Stop** | `stopped = 1` | disable (`is_enabled = 0`) filter rules whose criteria.from matches this sender (including Always Reads / Noise rules created by marks). |

Re-applying **Interesting** after **Stop** clears `stopped` and re-enables marks-owned rules when present.

### Always Reads — IMAP folder vs category

1. Prefer a mailbox folder/label whose name is `Reads` (top-level `Reads` preferred over nested `INBOX.Reads`).
2. If found: filter action `{ applyLabel: <labelId> }` (Gmail label id or IMAP folder path as stored in `labels`).
3. If not found: filter action `{ setCategory: "Newsletters" }` **or** `"Reads"` when that category exists — documented as interim. The hosted filer (below) will MOVE into IMAP Reads when available.
4. Never delete; never silent-file without the notify-before-file server policy.

---

## Digest format

`skimNewsletter(input) → NewsletterSkimResult`:

```ts
{
  highlights: Array<{ title: string; why: string; quote: string }>; // top N (default 5)
  score: number; // 0..1 interestingness
}
```

- Input: message body and/or snippet, optional subject/from, optional sender preference score.
- MVP: heuristic stub (headings, links, list items) in `src/services/newsletterMarks/skim.ts` + `aiService.skimNewsletter` wrapper.
- TODO: replace heuristic with LLM skim (reuse `callAi` / provider stack) once sync is fast enough that skim is not competing with inbox paint.

Digest UI (later): top N highlights per newsletter in the reading pane / a Reads digest view. Agents/MCP will call the same interface.

---

## Server filer + later MCP

`velo-server` gains a **filer** module (scaffold: `filer.rs`, behind `VELO_FILER=0` by default):

- Tables (control or per-user data DB — scaffold uses control migrate hooks): `filing_rules`, `filing_state`.
- Behaviour (when enabled): on new mail only, evaluate rules, **notify** the user, then MOVE to Reads (no delete).
- MCP tools (later, over hosted velo-server HTTP): `newsletter_mark`, `newsletter_skim`, `list_filing_rules` — not in this slice.

---

## Reuse of smart labels / Always-file-as

- **Filters** (`filter_rules` + `filterEngine`): Always Reads and Noise write the same structures as Settings → Filters and ContactSidebar “Always file as”.
- **Categories**: interim filing when no Reads folder; classifier respects manual/`setCategory` rules.
- **Smart labels**: not required for MVP marks; digest may later bias toward smart-label descriptions.
- **Quick Steps**: marks are lighter than a full Quick Step; shortcuts are dedicated.

---

## Keyboard shortcuts

Prefix **`n`** (newsletter), generalised two-key sequences (not only `g`):

| Keys | Action id | Mark |
|------|-----------|------|
| `n then i` | `mark.interesting` | Interesting |
| `n then o` | `mark.noise` | Noise |
| `n then r` | `mark.alwaysReads` | Always Reads |
| `n then x` | `mark.stop` | Stop |

Defined in `src/constants/shortcuts.ts` (category **Marks**). Customisable in Settings like other shortcuts.

---

## How to try marks in the app

1. Open a newsletter thread (or select it in the list).
2. Press `n` then `i` / `o` / `r` / `x` within ~1s.
3. Confirm in Settings → Filters that a From rule appeared (Always Reads / Noise), or inspect `newsletter_sender_prefs` in the local DB.
4. Future mail from that sender is treated by `applyFiltersToMessages` on sync (new-mail path).

---

## Performance companion work (same PR)

See `docs/investigations/2026-08-27-0641-sync-engine-performance.md`.

Shipped with this slice:
- Gmail sync uses `format=metadata`; bodies load on thread open via `ensureMessageBodies`.
- Delta Gmail stores wrap `withTransaction` (same lock path as initial).
- IMAP inter-folder delay reduced (1000ms → 200ms).

Deferred:
- IMAP headers-only FETCH in velo-core (needs `headers_only` through ops/Tauri/HTTP).
- Parallel IMAP folders, QRESYNC/IDLE, Tantivy, full filer runtime, MCP tools.
