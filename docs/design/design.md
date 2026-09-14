# Ders Programı İhtimalleri — Web App Design

**Date:** 2026-09-10
**Status:** Approved
**Supersedes:** the CLI flow in `app.js` (PDF input → `top_10_schedules.xlsx`)

## 1. Purpose

Turn the existing Node script into a lightweight, offline web app: upload the
university's weekly-schedule XLSX, pick courses from a searchable chip list,
and see the ten best conflict-free weekly timetables ranked by personal
preferences.

`app.js` and `lectures.pdf` remain in the repo untouched. They are the old
PDF-based path and are not part of this app.

## 2. Goals and non-goals

### Goals

- Parse the lecture XLSX entirely in the browser; the file never leaves the machine.
- Search and select courses as chips labelled with code + credit; hover reveals the full name.
- Show total selected credits, counted once per base course.
- Produce the top 10 distinct weekly schedules under user-tunable preferences.
- Apply the Işık rules that the file can actually support, and be explicit where it cannot.

### Non-goals

- No prerequisite/corequisite enforcement. Madde 10 places prerequisites in course
  profiles, which are absent from the XLSX. Inventing them would be guesswork.
- No quota enforcement. Deferred; column C is parsed and retained in the model so
  it can be added later without a schema change.
- No XLSX export. The browser view plus print-to-PDF replaces `top_10_schedules.xlsx`.
- No server, no build step, no package manager for the app itself.

## 3. Source data

Sheet `Lectures`, 1269 data rows, 799 base courses (every row's code parses
under §5.4). Header labels are unreliable
and are **not** trusted (see §5).

| Col | Header (as written) | Actual content | Example |
|-----|--------------------|----------------|---------|
| A | Ders Kodu | section code | `COMP1111-L.1` |
| B | Başlık | title, credit in trailing parens | `Programlama Temelleri (4)` |
| C | Kalan / Toplam Kota | remaining / total quota | `37 / 37` |
| D | Kampüs | campus | `Şile`, `Maslak`, `Online` |
| E, F | Eğitmen Adı / Soyadı | instructor | `AHMET KAMİL`, `TEKEREK` |
| G | "Ders Saati" | **time slots** | `T2T3T4` |
| H | Fakülte Adı | faculty | `Mühendislik ve Doğa Bilimleri Fakültesi` |
| I | "Ders Saati(leri)" | **weekly contact hours** (= slot count) | `3` |
| J | Live Section | `YES` / `NO` | `NO` |

Verified properties of the reference file:

- Hour indices run **1–13**. Day tokens are **M, T, W, Th, F, St**. No Sunday.
- All 120 `-L` / `-PS` rows carry **no** `(n)` credit; credit lives only on the parent row.
- 116 further rows lack `(n)`: internships, thesis, orientation. These are 0-credit.
- 164 rows have an empty slots cell (unscheduled: internship, thesis).
- Credit values observed: 1, 2, 3, 4, 5, 6, 8, 10.
- Every base code has at least one `LEC` section; no course is lab-only.
- Container is a normal ZIP using deflate and stored entries only.
- Elements carry an `x:` namespace prefix (`<x:row>`, `<x:c>`). Excel's own output
  has no prefix, so the parser must accept both.
- Text cells use **`t="str"` with the literal in `<v>`**, not inline strings.
  `sharedStrings.xml` exists but is empty. All four encodings must be supported:
  `str` (literal in `<v>`), `s` (index into shared strings), `inlineStr`
  (`<is><t>`), and no `t` at all (numeric).
- Empty cells appear **self-closing**: `<x:c r="F212" s="12" t="str" />`.

### Known dirty data

| Problem | Example | Handling |
|---|---|---|
| Turkish letters in codes | `AHİZ2132.1` | Unicode-aware code regex, never `[A-Z]` |
| Trailing space in code | `HUSS1003 .1` | trim before parsing |
| Extra dot in code | `GSKE-250.2.1` | base `GSKE-250`, section `2.1` |
| **Truncated slot string** | `1M2M3T5T6W1W2W3Th5Th6F1` (leading `M` cut at 23 chars) | flag section, exclude from solving, surface in a warnings panel |
| Trailing punctuation in slots | `M11M12Th11Th12.` | tolerated; only residue after slot matching triggers a warning |
| Dirty faculty values | `F2 Yabancı Diller Okulu` | carried through verbatim; display only |

6 rows in the reference file have truncated slot strings (the five `PREP1111`
sections and `PREP1373.1`). `MATH1000.1`'s `M11M12Th11Th12.` is *not* among
them: its trailing dot is punctuation, which the parser tolerates.

## 4. Architecture

Three files, no build step, opened directly via `file://`.

```
index.html          markup + all CSS + boot
schedule-core.js    pure logic: unzip, parse, model, solve, score  (no DOM)
ui.js               rendering, events, tooltips, localStorage
```

`schedule-core.js` is loaded as a classic script (not an ES module) so `file://`
works, and ends with a CommonJS export shim:

```js
if (typeof module !== 'undefined' && module.exports) module.exports = ScheduleCore;
```

This lets Node tests `require()` the exact file the browser executes, giving
testability without a bundler.

The solver runs on the main thread. Web Workers are blocked under `file://` in
Chrome, and the bitmask solver is fast enough that a worker is not needed.

## 5. XLSX reading

### 5.1 Unzip

Browser-native, zero dependencies:

- read the file as an `ArrayBuffer`
- walk the ZIP central directory
- method `0` (stored) → use bytes directly
- method `8` (deflate) → `DecompressionStream('deflate-raw')`

If `DecompressionStream` is unavailable, show an explicit "your browser is too
old for offline XLSX reading" message rather than failing silently.

### 5.2 Sheet parsing

A small **regex-based scanner**, not `DOMParser`.

`DOMParser` does not exist in Node, so a DOM-based parser could only be tested by
adding jsdom — a dependency, which contradicts the zero-dependency goal. A regex
scanner runs identically in the browser and under `node --test`, so the sheet
parser is covered by the same tests that cover everything else.

All element patterns must tolerate an optional namespace prefix (`<x:row>` and
`<row>` alike).

Cell text resolution covers all four encodings listed in §3: `str`, `s`,
`inlineStr`, and untyped numeric — so both this file and an Excel re-save work.

**The attribute capture must be non-greedy.** With a greedy `([^>]*)`, the `/` of
a self-closing empty cell is absorbed into the attribute run, the `/>` branch
never matches, and the cell instead consumes the *following* cell's content up to
its `</c>`. In the reference file this silently deleted `COMP1111-L.3`'s meeting
time. The required form is:

```js
/<(?:\w+:)?c\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g
```

This has a dedicated regression test (§13).

### 5.3 Column identification by content, not header

Headers are demonstrably wrong, so columns are identified by scoring each column
against the data shape of a sample of rows:

| Role | Predicate |
|---|---|
| slots | `^((Th|St|Su|M|T|W|F)\d{1,2})+$` |
| quota | `^\d+\s*/\s*\d+$` |
| code | section-code pattern (§5.4) |
| hours | pure integer, and correlates with slot count |
| title | highest rate of trailing `(n)` |
| campus | small distinct-value set drawn from text |
| akts (optional) | integer column distinct from `hours`, populated on `LEC` rows; absent in the reference file (§11) |

The column with the highest match rate wins each role. Header text is **not read
at all** — the header row is discarded before scoring, so no role can be swayed by
a mislabelled heading. This survives reordering and mislabeling in future exports.

If a required role (code, title, slots) cannot be identified, the app reports
which one failed instead of producing an empty list.

### 5.4 Code parsing

```
^(?<base>.+?)(?:-(?<kind>L|PS))?\.(?<section>\d+(?:\.\d+)?)$
```

applied to the trimmed code. `kind` absent → `LEC`.

### 5.5 Slot parsing

```
/(Th|St|Su|M|T|W|F)(\d{1,2})/g
```

`Th` and `St` must precede `T` and `S` in the alternation or `Th4` mis-parses as
`T` + `h4`. After matching, the concatenation of all matches is compared against
the input with punctuation stripped; any residue marks the section `truncated`.

Truncated sections are **excluded from solving** and listed in a warnings panel.
Silently scheduling a course whose real meeting times are unknown is the worst
available outcome.

## 6. Domain model

```js
Section {
  code, base, kind: 'LEC'|'LAB'|'PS', sectionNo,
  title, credit, slots: [{day, hour}], mask: Uint16Array(6),
  hours, campus, instructor, faculty,
  quota: {left, total}, live: bool,
  truncated: bool, unscheduled: bool
}

Course {
  base, title, credit,
  groups: { LEC: Section[], LAB: Section[], PS: Section[] }
}
```

Each **non-empty** group is a mandatory pick-one, matching `app.js` semantics.

**Credit rule:** `credit` is the `(n)` from the parent `LEC` row, counted **once
per base course**. Labs and PS contribute 0. Absent `(n)` → 0, displayed as `—`.
This prevents the double-count that a naive per-row sum would produce.

## 7. Solver

### 7.1 Search

Depth-first over course groups with immediate pruning, replacing the full
cartesian product in `app.js`:

1. order groups ascending by option count (fail fast)
2. at each level try each section; if it conflicts with the accumulated
   occupancy mask, prune the entire subtree
3. at a complete assignment, score and offer to a bounded top-K heap

Occupancy is a `Uint16Array(6)` — one element per day, 13 significant bits.
Conflict detection is a single `AND` per day.

Memory stays flat regardless of search size because only K results are retained.

### 7.2 Node cap

A hard cap of 2,000,000 explored nodes. On hitting it the search stops and the
UI shows **"search truncated — results may be incomplete"**. A frozen tab with no
explanation is not an acceptable alternative.

### 7.3 Madde 18/2 tolerance

Default **off**, reproducing today's strict no-overlap behaviour.

When enabled, a schedule is also admissible if it has **at most 2 overlapping
course pairs, each overlapping by at most 1 hour**. Such schedules are badged
*"needs advisor approval"* and are ranked below equally-scoring clean schedules.

Boundary cases that must be rejected: 3 overlapping pairs; any single pair
overlapping 2 or more hours.

### 7.4 Deduplication

Sections can be time-identical: `COMP1111-L.1`, `-L.2` and `-L.3` all meet at
`Th2Th3`. Without dedup the top 10 can be three copies of one timetable.

Schedules are keyed by **time signature** — the sorted set of (base, slot) pairs.
The first occurrence is kept; time-identical alternatives are attached to that
result as interchangeable section choices and shown on the card.

Dedup happens **at insertion into the top-K heap**, not as a pass afterwards.
Deduping after collection would let ten near-identical schedules fill the heap
and leave fewer than ten distinct timetables to show. The heap therefore holds a
signature→entry index alongside it, and a duplicate signature either merges into
the existing entry as an alternative or is discarded.

## 8. Scoring

Preferences, all user-adjustable:

| Preference | Control | Effect |
|---|---|---|
| Free days | day toggles + weight slider | bonus per requested day left empty |
| Compactness ↔ gaps | slider, packed .. spread | signed weight × total gap hours |
| Max gap | optional number | hard filter: reject any day with a longer gap |
| Avoid single-course days | checkbox | penalty per day holding one distinct base course |

Carried over from `app.js` as defaults: free days on with moderate weight,
compactness biased toward packed, avoid-single-course-days on.

Raw scores are normalized to 0–100 across the returned set. Each card shows a
**breakdown of what earned and cost points**, so a ranking is never opaque.

## 9. UI

Light theme, single scrolling page.

### Layout

1. **Drop zone / file input** — replaced after load by a compact file summary
   (name, course count, warning count).
2. **Sticky summary bar** — total credits; AKTS gauge with GNO tier picker; count selected.
3. **Search box** — filters on code, title, and instructor, diacritic-insensitive
   so `ısı` matches `İSİ`.
4. **Chip list** — content-sized chips in a wrapping flex row, so rows are
   naturally ragged. Label shows **code + credit only** (`COMP1111 · 4`).
   Hover shows a positioned tooltip with full title, instructor, campus, slot
   list, section count, and quota. Chips are `<label>` wrapping a visually-hidden
   checkbox, so keyboard and screen-reader behaviour come free.
5. **Selected tray** — compact list of chosen courses with individual remove.
6. **Preferences panel** — the §8 controls.
7. **Results** — ten weekly calendar cards.

### Calendar card

Rows = hours 1–13, columns = M, T, W, Th, F, with St and Su appended only when a
selected section actually uses them. The reference file has 14 Saturday sections
and no Sunday ones, but the parser accepts `Su` defensively so a future file
containing it renders rather than dropping slots.
Consecutive slots of one section merge into a single block. Each course gets a
stable pastel colour derived from a hash of its base code, so a course keeps its
colour across all ten cards. Each card shows rank, normalized score, score
breakdown, any Madde 18 badge, and interchangeable lab alternatives.

### Persistence

Selection and preferences persist in `localStorage`, wrapped in `try/catch` so a
private window or blocked site data degrades to a working app with no memory.

### Print

Print stylesheet so a card can be saved as PDF, replacing the old XLSX export.

## 10. Işık rules implemented

Source: [Ders Kayıt Yönergesi](https://www.isikun.edu.tr/sites/default/files/2024-09/14119_1_isik-universitesi-ders-kayit-yonergesi_R2.pdf), Senato 11.05.2022 no 13.

| Madde | Rule | Treatment |
|---|---|---|
| 18/1 | Schedules should not conflict | default strict mode |
| 18/2 | At most two courses may overlap by one hour each | optional tolerance mode, §7.3 |
| 14 | Load ceilings 30 / 31 / 37 / 43 / 45 AKTS by GNO tier and ÇAP | advisory gauge, §11 |
| 10 | Prerequisites live in course profiles | out of scope, stated in the UI |
| 13 | Quota needs approval when full | parsed and stored, not enforced |

## 11. AKTS gauge — accepted limitation

The gauge is included at the user's explicit request after the mismatch was
raised.

The file's `(n)` is **local kredi**. Every Madde 14 ceiling is in **AKTS**. These
are different scales, so comparing them is approximate. The gauge is therefore
labelled **advisory** in the UI and never renders a hard "you are over the limit"
verdict.

If an uploaded file does contain an AKTS/ECTS column, §5.3 detects it (integer
column, not equal to the hours column, present on `LEC` rows) and the gauge
switches to exact, dropping the advisory label.

GNO tiers offered: first-year (30), ≤2.49 (31), 2.50–3.49 (37), ≥3.50 (43), ÇAP (45).

## 12. Error handling

Every failure is reported to the user; none are swallowed.

| Failure | Behaviour |
|---|---|
| Not a ZIP / not an XLSX | "This does not look like an .xlsx file" |
| `DecompressionStream` missing | explicit browser-too-old message |
| No worksheet found | names what was searched |
| A required column unidentifiable | names the missing role |
| Section with truncated slots | ⚠ badge, excluded from solving, listed in warnings panel |
| Zero valid schedules | states that no conflict-free combination exists and suggests enabling Madde 18 mode or deselecting a course |
| Node cap reached | "search truncated — results may be incomplete" |
| `localStorage` unavailable | app works, nothing persists |

## 13. Testing

`schedule-core.js` is DOM-free and `require()`-able, tested under Node's built-in
test runner. The reference XLSX is the fixture.

Coverage:

- **XLSX reading** — stored and deflated entries; `x:`-prefixed and unprefixed
  elements; all four cell encodings (`str`, `s`, `inlineStr`, numeric); XML entity
  unescaping; **self-closing empty cells do not swallow the next cell** (regression
  test pinned to `COMP1111-L.3` = `Th2Th3` in the reference file).
- **Slot parsing** — `Th` before `T`; `St` before `S`; hour 10–13 two-digit;
  truncated strings flagged, not silently accepted; trailing punctuation tolerated.
- **Code parsing** — Turkish letters; trailing space; `GSKE-250.2.1`; `-L` / `-PS` kinds.
- **Column detection** — correct roles on the real file despite wrong headers;
  correct roles after columns are shuffled; named failure when a role is absent.
- **Credit rule** — counted once per base course; lab/PS contribute 0; missing `(n)` is 0.
- **Conflicts** — bitmask detection; adjacent-but-not-overlapping is not a conflict.
- **Madde 18** — 2 pairs × 1 hour accepted; 3 pairs rejected; 1 pair × 2 hours rejected.
- **Dedup** — three identical-time lab sections collapse to one result carrying alternates.
- **Scoring** — free-day bonus, gap penalty sign, max-gap hard filter, single-course-day penalty.
- **Solver** — finds the known-best schedule on a small hand-built fixture;
  respects the node cap and reports truncation.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Future files differ in layout | content-sniffing (§5.3), plus named errors on failure |
| Source system truncates long slot strings | detected and surfaced; affected sections excluded |
| Combinatorial blow-up on many multi-section courses | pruning + node cap + truncation notice |
| Credit vs AKTS confusion | advisory labelling (§11) |
| `DecompressionStream` unsupported | explicit message, no silent failure |
