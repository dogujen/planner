# Ders Programı İhtimalleri — Implementation Plan

> Implementation plan, written before any code. Each task is test-first and ends
> with an independently verifiable deliverable. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build an offline, zero-dependency single-page web app that reads the university's lecture XLSX, lets the user pick courses from a searchable chip list, and shows the ten best weekly timetables under tunable preferences.

**Architecture:** Plain `<script src>` files opened straight from `file://` — no bundler, no server, no runtime dependency. All pure logic lives in DOM-free modules under `src/` that end with a CommonJS export shim, so Node's built-in test runner `require()`s the exact same files the browser executes. XLSX reading uses the browser-native `DecompressionStream` (also present in Node 18+) plus a regex XML scanner, so the read path is identical and fully testable in both environments.

**Tech Stack:** Vanilla ES2020 JavaScript, HTML, CSS. `node --test` for tests. No npm dependencies for the app itself.

**Spec:** `docs/design/design.md`

## Global Constraints

- **Zero runtime dependencies.** The app must not import, bundle, or CDN-load any library. `exceljs` and `pdf-parse` in `package.json` belong to the legacy `app.js` and must not be used by `src/`.
- **Must work from `file://`.** Classic `<script src>` only — no ES modules, no `import`/`export` statements, no Web Workers, no `fetch()` of local files.
- **`src/` modules must be DOM-free** except `src/ui.js`. No `document`, `window`, or `localStorage` references in the logic modules.
- **Every logic module ends with the dual-export shim** so both browser and Node can load it (exact form in Task 1, Step 3).
- **Day tokens:** `M, T, W, Th, F, St, Su`. **Hours: 1–13.** Longer tokens must precede their prefixes in every alternation (`Th` before `T`, `St`/`Su` before `S`).
- **Never trust XLSX header text.** Columns are identified by data shape (spec §5.3).
- **Credit is the trailing `(n)` of the title, counted once per base course.** Labs and PS contribute 0.
- **No silent failures.** Every error path in spec §12 must surface a message naming what failed.
- Codebase is ES2020, 2-space indent, semicolons, single quotes, `const`/`let` only.
- **Existing files `app.js`, `lectures.pdf`, `prefixes.json` must not be modified or deleted.**

## File Structure

The spec's §4 names one `schedule-core.js`. This plan splits that pure-logic file into four focused modules — the interfaces and load order are unchanged, and it keeps each file small enough to hold in context while testing.

| File | Responsibility |
|---|---|
| `index.html` | Markup, all CSS, script tags, boot call |
| `src/xlsx-reader.js` | ZIP inflate + sheet XML scan → raw rows |
| `src/course-parser.js` | Column detection, code/slot/credit parsing → course model |
| `src/scoring.js` | Preferences → schedule score + breakdown |
| `src/solver.js` | Conflict masks, DFS search, Madde 18, dedup |
| `src/ui.js` | All DOM: chips, search, preferences, calendars, persistence |
| `test/*.test.js` | Node tests, one per logic module |
| `test/fixtures/` | The reference XLSX |

**Browser load order** (dependencies first): `xlsx-reader` → `course-parser` → `scoring` → `solver` → `ui`.

---

### Task 1: XLSX reader — inflate and scan

**Files:**
- Create: `src/xlsx-reader.js`
- Create: `test/xlsx-reader.test.js`
- Create: `test/fixtures/2026_Guz_Haftalik_Ders_Programi.xlsx` (copy of the reference file)
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `XlsxReader.unzip(bytes: Uint8Array) -> Promise<Record<string, Uint8Array>>`
  - `XlsxReader.parseSharedStrings(xml: string) -> string[]`
  - `XlsxReader.parseSheetXml(xml: string, shared: string[]) -> Array<Record<string,string>>` — one object per row, keyed by column letter
  - `XlsxReader.readWorkbook(bytes: Uint8Array) -> Promise<{rows, sheetPath}>`

- [ ] **Step 1: Copy the fixture and add the test script**

```bash
mkdir -p test/fixtures src
cp "D:/Downloads/2026_Guz_Haftalik_Ders_Programi.xlsx" test/fixtures/
```

In `package.json`, add to `"scripts"` (no path argument — on Windows Node treats
`node --test test/` as a module path and throws; bare `node --test` uses Node's own
`test/**/*.js` discovery):

```json
"test": "node --test"
```

- [ ] **Step 2: Write the failing test**

Create `test/xlsx-reader.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/xlsx-reader.js');

const FIXTURE = path.join(__dirname, 'fixtures', '2026_Guz_Haftalik_Ders_Programi.xlsx');
const bytes = () => new Uint8Array(fs.readFileSync(FIXTURE));

test('unzip returns every entry in the container', async () => {
  const files = await R.unzip(bytes());
  assert.ok(files['xl/worksheets/sheet1.xml'], 'sheet1 missing');
  assert.ok(files['[Content_Types].xml'], 'stored entry missing');
});

test('readWorkbook parses all rows with Turkish text intact', async () => {
  const { rows } = await R.readWorkbook(bytes());
  assert.strictEqual(rows.length, 1270);
  assert.strictEqual(rows[0].A, 'Ders Kodu');
  assert.strictEqual(rows[1].A, 'AHİZ1111.1');
  assert.strictEqual(rows[1].B, 'AMELİYATHANE TEKNOLOJİLERİ (3)');
  assert.strictEqual(rows[1].D, 'Maslak');
});

// Regression: a self-closing empty cell must not swallow the next cell.
// Row 212 is <c r="F212" .../> followed by <c r="G212">Th2Th3</c>.
test('self-closing empty cell does not consume the following cell', async () => {
  const { rows } = await R.readWorkbook(bytes());
  const lab = rows.find((r) => r.A === 'COMP1111-L.3');
  assert.ok(lab, 'COMP1111-L.3 row not found');
  assert.strictEqual(lab.G, 'Th2Th3');
});

test('parseSheetXml handles both namespaced and bare elements', () => {
  const nsRows = R.parseSheetXml(
    '<x:row><x:c r="A1" t="str"><x:v>hi</x:v></x:c></x:row>', []);
  const bareRows = R.parseSheetXml(
    '<row><c r="A1" t="str"><v>hi</v></c></row>', []);
  assert.strictEqual(nsRows[0].A, 'hi');
  assert.strictEqual(bareRows[0].A, 'hi');
});

test('parseSheetXml resolves all four cell encodings', () => {
  const xml = '<row>' +
    '<c r="A1" t="str"><v>literal</v></c>' +
    '<c r="B1" t="s"><v>0</v></c>' +
    '<c r="C1" t="inlineStr"><is><t>inline</t></is></c>' +
    '<c r="D1"><v>42</v></c>' +
    '</row>';
  const rows = R.parseSheetXml(xml, ['shared0']);
  assert.deepStrictEqual(rows[0], { A: 'literal', B: 'shared0', C: 'inline', D: '42' });
});

test('parseSheetXml unescapes XML entities', () => {
  const rows = R.parseSheetXml('<row><c r="A1" t="str"><v>a &amp; b &#65;</v></c></row>', []);
  assert.strictEqual(rows[0].A, 'a & b A');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/xlsx-reader.js'`

- [ ] **Step 4: Implement the reader**

Create `src/xlsx-reader.js`:

```js
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.XlsxReader = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const u16 = (d, o) => d[o] | (d[o + 1] << 8);
  const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'This browser cannot read .xlsx files offline (DecompressionStream is unavailable). ' +
        'Please use a current version of Chrome, Edge, Firefox or Safari.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(bytes) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This does not look like an .xlsx file (no ZIP directory found).');

    const count = u16(bytes, eocd + 10);
    let off = u32(bytes, eocd + 16);
    const out = {};
    for (let k = 0; k < count; k++) {
      if (u32(bytes, off) !== 0x02014b50) throw new Error('This .xlsx file appears to be corrupt.');
      const method = u16(bytes, off + 10);
      const csize = u32(bytes, off + 20);
      const nlen = u16(bytes, off + 28);
      const elen = u16(bytes, off + 30);
      const clen = u16(bytes, off + 32);
      const lho = u32(bytes, off + 42);
      const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nlen));
      const lnlen = u16(bytes, lho + 26);
      const lelen = u16(bytes, lho + 28);
      const start = lho + 30 + lnlen + lelen;
      const raw = bytes.subarray(start, start + csize);
      if (method === 0) out[name] = raw;
      else if (method === 8) out[name] = await inflateRaw(raw);
      else throw new Error('Unsupported compression in .xlsx (method ' + method + ').');
      off += 46 + nlen + elen + clen;
    }
    return out;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unescapeXml(s) {
    return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (m, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m;
    });
  }

  const T_RE = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
  const joinText = (frag) => [...frag.matchAll(T_RE)].map((m) => m[1]).join('');

  function parseSharedStrings(xml) {
    if (!xml) return [];
    return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)]
      .map((m) => unescapeXml(joinText(m[1])));
  }

  // The attribute capture MUST be non-greedy. A greedy [^>]* absorbs the '/' of a
  // self-closing cell, so the '/>' branch never matches and the cell instead eats
  // the NEXT cell's content up to its </c>. See spec 5.2.
  const ROW_RE = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;
  const CELL_RE = /<(?:\w+:)?c\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  const V_RE = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/;

  function parseSheetXml(xml, shared) {
    const rows = [];
    let rowMatch;
    ROW_RE.lastIndex = 0;
    while ((rowMatch = ROW_RE.exec(xml)) !== null) {
      const cells = {};
      let cellMatch;
      CELL_RE.lastIndex = 0;
      while ((cellMatch = CELL_RE.exec(rowMatch[1])) !== null) {
        const attrs = cellMatch[1] || '';
        const body = cellMatch[2] || '';
        const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
        if (!refMatch) continue;
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        let value;
        if (type === 'inlineStr' || /<(?:\w+:)?is\b/.test(body)) {
          value = joinText(body);
        } else {
          const raw = (body.match(V_RE) || [])[1] || '';
          value = type === 's' ? (shared[Number(raw)] || '') : raw;
        }
        cells[refMatch[1]] = unescapeXml(value);
      }
      rows.push(cells);
    }
    return rows;
  }

  async function readWorkbook(bytes) {
    const files = await unzip(bytes);
    const decode = (name) => (files[name] ? new TextDecoder().decode(files[name]) : '');
    const sheetPath = Object.keys(files)
      .filter((n) => /^xl\/worksheets\/.+\.xml$/.test(n))
      .sort()[0];
    if (!sheetPath) {
      throw new Error('No worksheet found in this file (looked for xl/worksheets/*.xml).');
    }
    const shared = parseSharedStrings(decode('xl/sharedStrings.xml'));
    return { rows: parseSheetXml(decode(sheetPath), shared), sheetPath };
  }

  return { unzip, parseSharedStrings, parseSheetXml, readWorkbook };
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 tests, including the `COMP1111-L.3` regression.

- [ ] **Step 6: Commit**

```bash
git add src/xlsx-reader.js test/xlsx-reader.test.js test/fixtures package.json
git commit -m "feat: zero-dependency XLSX reader with self-closing-cell regression test"
```

---

### Task 2: Code, slot and credit parsing

**Files:**
- Create: `src/course-parser.js`
- Create: `test/course-parser.test.js`

**Interfaces:**
- Consumes: nothing (pure string functions).
- Produces:
  - `CourseParser.DAYS: string[]` — `['M','T','W','Th','F','St','Su']`
  - `CourseParser.MAX_HOUR: 13`
  - `CourseParser.parseCode(raw) -> {base, kind, sectionNo} | null` — `kind` is `'LEC' | 'LAB' | 'PS'`
  - `CourseParser.parseSlots(raw) -> {slots: Array<{day, hour}>, truncated: boolean}` — `day` is an index into `DAYS`
  - `CourseParser.parseCredit(title) -> number`

- [ ] **Step 1: Write the failing test**

Create `test/course-parser.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/course-parser.js');

test('parseCode splits base, kind and section', () => {
  assert.deepStrictEqual(P.parseCode('COMP1111.2'), { base: 'COMP1111', kind: 'LEC', sectionNo: '2' });
  assert.deepStrictEqual(P.parseCode('COMP1111-L.1'), { base: 'COMP1111', kind: 'LAB', sectionNo: '1' });
  assert.deepStrictEqual(P.parseCode('ARCH2210-PS.1'), { base: 'ARCH2210', kind: 'PS', sectionNo: '1' });
});

test('parseCode handles Turkish letters and dirty codes', () => {
  assert.strictEqual(P.parseCode('AHİZ2132.1').base, 'AHİZ2132');
  assert.strictEqual(P.parseCode('HUSS1003 .1').base, 'HUSS1003');   // trailing space
  assert.strictEqual(P.parseCode('GSKE-250.2.1').base, 'GSKE-250');  // extra dot
  assert.strictEqual(P.parseCode('GSKE-250.2.1').sectionNo, '2.1');
});

test('parseCode returns null for unparseable input', () => {
  assert.strictEqual(P.parseCode(''), null);
  assert.strictEqual(P.parseCode('NOSECTION'), null);
});

test('parseSlots reads day/hour pairs, longest token first', () => {
  assert.deepStrictEqual(P.parseSlots('T2T3T4').slots,
    [{ day: 1, hour: 2 }, { day: 1, hour: 3 }, { day: 1, hour: 4 }]);
  // 'Th' must not parse as 'T' + stray 'h'
  assert.deepStrictEqual(P.parseSlots('Th2Th3').slots, [{ day: 3, hour: 2 }, { day: 3, hour: 3 }]);
  assert.deepStrictEqual(P.parseSlots('St1').slots, [{ day: 5, hour: 1 }]);
});

test('parseSlots reads two-digit hours', () => {
  assert.deepStrictEqual(P.parseSlots('T10T11T12').slots,
    [{ day: 1, hour: 10 }, { day: 1, hour: 11 }, { day: 1, hour: 12 }]);
});

test('parseSlots tolerates trailing punctuation', () => {
  const r = P.parseSlots('M11M12Th11Th12.');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.slots.length, 4);
});

test('parseSlots flags truncated strings instead of accepting them', () => {
  // Real row: the leading 'M' was cut off by the source system at 23 chars.
  const r = P.parseSlots('1M2M3T5T6W1W2W3Th5Th6F1');
  assert.strictEqual(r.truncated, true);
});

test('parseSlots treats empty input as unscheduled, not truncated', () => {
  assert.deepStrictEqual(P.parseSlots(''), { slots: [], truncated: false });
});

test('parseCredit reads the trailing parenthesis only', () => {
  assert.strictEqual(P.parseCredit('Programlama Temelleri (4)'), 4);
  assert.strictEqual(P.parseCredit('Yapı Teknolojileri I (3)'), 3);
  assert.strictEqual(P.parseCredit('Programlama Temelleri'), 0);   // lab row
  assert.strictEqual(P.parseCredit('SEKTÖR STAJI'), 0);
  assert.strictEqual(P.parseCredit('Global 20.Yüzyıl Sanatı (3)'), 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/course-parser.test.js`
Expected: FAIL — `Cannot find module '../src/course-parser.js'`

- [ ] **Step 3: Implement the parsers**

Create `src/course-parser.js`:

```js
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CourseParser = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const DAYS = ['M', 'T', 'W', 'Th', 'F', 'St', 'Su'];
  const MAX_HOUR = 13;

  // Longer tokens first, or 'Th4' mis-parses as 'T' followed by junk.
  const SLOT_RE = /(Th|St|Su|M|T|W|F)(\d{1,2})/g;
  const CODE_RE = /^(.+?)(?:-(L|PS))?\.(\d+(?:\.\d+)?)$/u;
  const CREDIT_RE = /\((\d+)\)\s*$/;

  function parseCode(raw) {
    if (!raw) return null;
    const match = CODE_RE.exec(String(raw).trim());
    if (!match) return null;
    const kind = match[2] === 'L' ? 'LAB' : match[2] === 'PS' ? 'PS' : 'LEC';
    return { base: match[1].trim(), kind, sectionNo: match[3] };
  }

  function parseSlots(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { slots: [], truncated: false };

    const slots = [];
    let consumed = 0;
    let match;
    SLOT_RE.lastIndex = 0;
    while ((match = SLOT_RE.exec(text)) !== null) {
      const hour = parseInt(match[2], 10);
      if (hour < 1 || hour > MAX_HOUR) continue;
      slots.push({ day: DAYS.indexOf(match[1]), hour });
      consumed += match[0].length;
    }

    // Anything left over once punctuation is discounted means the source string
    // was cut mid-token; scheduling it would use meeting times we cannot know.
    const meaningful = text.replace(/[^A-Za-z0-9]/g, '').length;
    return { slots, truncated: slots.length === 0 || consumed !== meaningful };
  }

  function parseCredit(title) {
    const match = CREDIT_RE.exec(String(title == null ? '' : title).trim());
    return match ? parseInt(match[1], 10) : 0;
  }

  return { DAYS, MAX_HOUR, parseCode, parseSlots, parseCredit };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/course-parser.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/course-parser.js test/course-parser.test.js
git commit -m "feat: Turkish-safe code, slot and credit parsing with truncation detection"
```

---

### Task 3: Column detection by data shape

**Files:**
- Modify: `src/course-parser.js` (append `detectColumns`)
- Modify: `test/course-parser.test.js` (append tests)

**Interfaces:**
- Consumes: `parseCode`, `parseSlots` from Task 2.
- Produces: `CourseParser.detectColumns(rows) -> {code, title, slots, hours, quota, campus, instructor, akts}` — values are column letters, or `null` for optional roles. Throws `Error` naming the missing role when `code`, `title` or `slots` cannot be found.

- [ ] **Step 1: Write the failing test**

Append to `test/course-parser.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/xlsx-reader.js');
const FIXTURE = path.join(__dirname, 'fixtures', '2026_Guz_Haftalik_Ders_Programi.xlsx');

test('detectColumns finds the right roles despite mislabeled headers', async () => {
  const { rows } = await R.readWorkbook(new Uint8Array(fs.readFileSync(FIXTURE)));
  const cols = P.detectColumns(rows);
  assert.strictEqual(cols.code, 'A');
  assert.strictEqual(cols.title, 'B');
  assert.strictEqual(cols.quota, 'C');
  assert.strictEqual(cols.campus, 'D');
  assert.strictEqual(cols.slots, 'G');   // header wrongly says 'Ders Saati'
  assert.strictEqual(cols.hours, 'I');   // header wrongly says 'Ders Saati(leri)'
  assert.strictEqual(cols.akts, null);   // this file has no AKTS column
});

test('detectColumns survives shuffled columns', () => {
  const rows = [
    { Z: 'Ders Kodu', Y: 'Başlık', X: 'Saat' },
    { Z: 'COMP1111.1', Y: 'Programlama Temelleri (4)', X: 'T2T3T4' },
    { Z: 'COMP1111.2', Y: 'Programlama Temelleri (4)', X: 'T1T2T3' },
    { Z: 'MATH1111.1', Y: 'Kalkülüs (4)', X: 'M1M2M3' },
  ];
  const cols = P.detectColumns(rows);
  assert.strictEqual(cols.code, 'Z');
  assert.strictEqual(cols.title, 'Y');
  assert.strictEqual(cols.slots, 'X');
});

test('detectColumns names the role it could not find', () => {
  const rows = [{ A: 'h' }, { A: 'no codes here' }, { A: 'still none' }];
  assert.throws(() => P.detectColumns(rows), /code/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/course-parser.test.js`
Expected: FAIL — `P.detectColumns is not a function`

- [ ] **Step 3: Implement detection**

In `src/course-parser.js`, add before the `return` statement:

```js
  const QUOTA_RE = /^\d+\s*\/\s*\d+$/;
  const INT_RE = /^\d+$/;

  function columnLetters(rows) {
    const seen = new Set();
    for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
    return [...seen];
  }

  // Fraction of non-empty values in this column that satisfy `predicate`.
  function matchRate(rows, letter, predicate) {
    let total = 0;
    let hits = 0;
    for (const row of rows) {
      const value = row[letter];
      if (value == null || value === '') continue;
      total++;
      if (predicate(value)) hits++;
    }
    return total === 0 ? 0 : hits / total;
  }

  function bestColumn(rows, letters, predicate, threshold) {
    let best = null;
    let bestRate = threshold;
    for (const letter of letters) {
      const rate = matchRate(rows, letter, predicate);
      if (rate > bestRate) { bestRate = rate; best = letter; }
    }
    return best;
  }

  function detectColumns(rows) {
    // Skip the header row: its text would otherwise pollute every match rate.
    const body = rows.slice(1);
    const letters = columnLetters(body);

    const code = bestColumn(body, letters, (v) => parseCode(v) !== null, 0.5);
    if (!code) {
      throw new Error(
        'Could not find the course-code column. Expected values like "COMP1111.1" or "COMP1111-L.1".');
    }

    const slots = bestColumn(body, letters.filter((l) => l !== code),
      (v) => !parseSlots(v).truncated && parseSlots(v).slots.length > 0, 0.3);
    if (!slots) {
      throw new Error(
        'Could not find the class-hours column. Expected values like "T2T3T4" or "Th2Th3".');
    }

    const used = [code, slots];
    const rest = letters.filter((l) => !used.includes(l));

    const title = bestColumn(body, rest, (v) => CREDIT_RE.test(v), 0.1)
      || bestColumn(body, rest, (v) => /[A-Za-zÀ-ÿĞğİıÖöŞşÜüÇç]{4,}/.test(v), 0.5);
    if (!title) {
      throw new Error('Could not find the course-title column.');
    }
    used.push(title);

    const quota = bestColumn(body, letters.filter((l) => !used.includes(l)),
      (v) => QUOTA_RE.test(v), 0.5);
    if (quota) used.push(quota);

    // Contact hours vs AKTS: both are integer columns, so "is an integer" cannot
    // tell them apart. Contact hours is the one that tracks the slot count.
    //
    // Do NOT use a fixed agreement threshold. In the reference file column I
    // agrees with the slot count on only 89% of rows — 101 rows legitimately
    // disagree because the hours figure includes untimetabled practicum time
    // (AHİZ1111.1 reports 4 hours for 3 scheduled slots). Any threshold above
    // 0.89 misidentifies the real hours column; any threshold low enough to
    // admit it is an arbitrary number that a different file would break.
    // Ranking sidesteps the guess: the best-tracking integer column is hours,
    // and a second integer column alongside it is AKTS.
    const slotAgreementRate = (letter) => {
      const comparable = body.filter((r) => r[letter] && r[slots]);
      if (comparable.length === 0) return 0;
      const agreeing = comparable.filter((r) => {
        const parsed = parseSlots(r[slots]);
        return parsed.truncated || Number(r[letter]) === parsed.slots.length;
      });
      return agreeing.length / comparable.length;
    };

    const integerColumns = letters
      .filter((l) => !used.includes(l))
      .filter((l) => matchRate(body, l, (v) => INT_RE.test(v)) > 0.8)
      .map((l) => ({ letter: l, rate: slotAgreementRate(l) }))
      .sort((a, b) => b.rate - a.rate);

    const hours = integerColumns.length > 0 && integerColumns[0].rate > 0.5
      ? integerColumns[0].letter
      : null;
    if (hours) used.push(hours);

    // AKTS is only meaningful as a SECOND integer column beside a real hours
    // column. Without that anchor, a lone unrelated integer column would be
    // mislabelled AKTS and silently drive the load gauge.
    const akts = hours && integerColumns.length > 1 ? integerColumns[1].letter : null;
    if (akts) used.push(akts);

    // Campus is a text column with only a handful of distinct values, so it is
    // judged on the column as a whole rather than per-value.
    let campus = null;
    for (const letter of letters.filter((l) => !used.includes(l))) {
      const values = body.map((r) => r[letter]).filter(Boolean);
      const distinct = new Set(values);
      if (values.length > body.length * 0.5 && distinct.size >= 2 && distinct.size <= 12) {
        campus = letter;
        break;
      }
    }
    if (campus) used.push(campus);

    const instructor = bestColumn(body, letters.filter((l) => !used.includes(l)),
      (v) => /^[A-ZÀ-ÿĞİÖŞÜÇ][A-Za-zÀ-ÿĞğİıÖöŞşÜüÇç .'-]*$/.test(v), 0.6);

    return {
      code, title, slots, quota: quota || null, hours,
      campus: campus || null, instructor: instructor || null, akts,
    };
  }
```

Add `detectColumns` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/course-parser.test.js`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/course-parser.js test/course-parser.test.js
git commit -m "feat: identify XLSX columns by data shape, not header text"
```

---

### Task 4: Build the course model

**Files:**
- Modify: `src/course-parser.js` (append `buildCourses`, `slotsToMask`)
- Modify: `test/course-parser.test.js` (append tests)

**Interfaces:**
- Consumes: `parseCode`, `parseSlots`, `parseCredit`, `detectColumns`.
- Produces:
  - `CourseParser.slotsToMask(slots) -> Uint16Array(7)` — bit `hour-1` set per day
  - `CourseParser.buildCourses(rows, cols) -> {courses, warnings}` where
    `courses` is `Array<{base, title, credit, groups: {LEC, LAB, PS}}>` sorted by `base`,
    and `warnings` is `Array<{code, reason}>`

- [ ] **Step 1: Write the failing test**

Append to `test/course-parser.test.js`:

```js
test('slotsToMask sets one bit per day/hour', () => {
  const mask = P.slotsToMask([{ day: 1, hour: 1 }, { day: 1, hour: 3 }, { day: 3, hour: 2 }]);
  assert.strictEqual(mask[1], 0b101);
  assert.strictEqual(mask[3], 0b010);
  assert.strictEqual(mask[0], 0);
});

test('buildCourses groups sections by base and kind', async () => {
  const { rows } = await R.readWorkbook(new Uint8Array(fs.readFileSync(FIXTURE)));
  const { courses } = P.buildCourses(rows, P.detectColumns(rows));
  const comp = courses.find((c) => c.base === 'COMP1111');
  assert.strictEqual(comp.groups.LEC.length, 2);
  assert.strictEqual(comp.groups.LAB.length, 3);
  assert.strictEqual(comp.groups.PS.length, 0);
});

test('credit comes from the parent row and is counted once per course', async () => {
  const { rows } = await R.readWorkbook(new Uint8Array(fs.readFileSync(FIXTURE)));
  const { courses } = P.buildCourses(rows, P.detectColumns(rows));
  const comp = courses.find((c) => c.base === 'COMP1111');
  assert.strictEqual(comp.credit, 4);                       // from 'Programlama Temelleri (4)'
  assert.strictEqual(comp.groups.LAB[0].credit, 0);         // lab contributes nothing
  const staj = courses.find((c) => c.base === 'AHİZ2939');
  assert.strictEqual(staj.credit, 0);                       // internship, no (n)
});

test('buildCourses reports truncated sections as warnings', async () => {
  const { rows } = await R.readWorkbook(new Uint8Array(fs.readFileSync(FIXTURE)));
  const { warnings } = P.buildCourses(rows, P.detectColumns(rows));
  assert.ok(warnings.some((w) => w.code.startsWith('PREP1111')),
    'expected PREP1111 to be flagged as truncated');
});

test('buildCourses parses the whole reference file without throwing', async () => {
  const { rows } = await R.readWorkbook(new Uint8Array(fs.readFileSync(FIXTURE)));
  const { courses } = P.buildCourses(rows, P.detectColumns(rows));
  // 799 base courses: every one of the 1269 rows parses under the Task 2 regex,
  // including the odd GSKE-250.2.1 and 'HUSS1003 .1' forms.
  assert.strictEqual(courses.length, 799);
  assert.ok(courses.every((c) => c.groups.LEC.length > 0), 'every course needs a lecture group');
  const math = courses.find((c) => c.base === 'MATH1001');
  assert.strictEqual(math.groups.LEC.length, 3);
  assert.strictEqual(math.groups.PS.length, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/course-parser.test.js`
Expected: FAIL — `P.slotsToMask is not a function`

- [ ] **Step 3: Implement the model builder**

In `src/course-parser.js`, add before the `return` statement:

```js
  function slotsToMask(slots) {
    const mask = new Uint16Array(DAYS.length);
    for (const slot of slots) mask[slot.day] |= (1 << (slot.hour - 1));
    return mask;
  }

  function parseQuota(raw) {
    const match = QUOTA_RE.exec(String(raw == null ? '' : raw).trim());
    if (!match) return null;
    const parts = String(raw).split('/');
    return { left: parseInt(parts[0], 10), total: parseInt(parts[1], 10) };
  }

  function buildCourses(rows, cols) {
    const byBase = new Map();
    const warnings = [];

    for (const row of rows.slice(1)) {
      const rawCode = row[cols.code];
      const parsed = parseCode(rawCode);
      if (!parsed) continue;

      const title = (row[cols.title] || '').trim();
      const slotInfo = parseSlots(row[cols.slots]);
      const rawSlots = (row[cols.slots] || '').trim();

      if (slotInfo.truncated && rawSlots !== '') {
        warnings.push({
          code: String(rawCode).trim(),
          reason: 'Class hours could not be read in full ("' + rawSlots + '") — excluded from planning.',
        });
      }

      const section = {
        code: String(rawCode).trim(),
        base: parsed.base,
        kind: parsed.kind,
        sectionNo: parsed.sectionNo,
        title,
        credit: parseCredit(title),
        slots: slotInfo.slots,
        mask: slotsToMask(slotInfo.slots),
        hours: cols.hours ? Number(row[cols.hours] || 0) : slotInfo.slots.length,
        akts: cols.akts ? Number(row[cols.akts] || 0) : null,
        campus: cols.campus ? (row[cols.campus] || '') : '',
        instructor: (cols.instructorParts || [])
          .map((letter) => (row[letter] || '').trim()).filter(Boolean).join(' '),
        quota: cols.quota ? parseQuota(row[cols.quota]) : null,
        truncated: slotInfo.truncated && rawSlots !== '',
        unscheduled: rawSlots === '',
      };

      if (!byBase.has(parsed.base)) {
        byBase.set(parsed.base, {
          base: parsed.base, title: '', credit: 0, akts: null,
          groups: { LEC: [], LAB: [], PS: [] },
        });
      }
      const course = byBase.get(parsed.base);
      course.groups[parsed.kind].push(section);

      // Title and credit come from the parent lecture row only, so a lab never
      // contributes a second credit for the same course.
      if (parsed.kind === 'LEC') {
        if (section.credit > 0 || !course.title) course.title = title.replace(CREDIT_RE, '').trim();
        if (section.credit > 0) course.credit = section.credit;
        if (section.akts) course.akts = section.akts;
      }
    }

    const courses = [...byBase.values()].sort((a, b) => a.base.localeCompare(b.base, 'tr'));
    return { courses, warnings };
  }
```

Add `slotsToMask` and `buildCourses` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/course-parser.test.js`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/course-parser.js test/course-parser.test.js
git commit -m "feat: build course model with credit counted once per base course"
```

---

### Task 5: Scoring

**Files:**
- Create: `src/scoring.js`
- Create: `test/scoring.test.js`

**Interfaces:**
- Consumes: `CourseParser.DAYS`, `CourseParser.MAX_HOUR`.
- Produces:
  - `Scoring.DEFAULT_PREFS` — object described below
  - `Scoring.dayHours(sections) -> Array<number[]>` — sorted hour list per day index
  - `Scoring.scoreSchedule(sections, prefs) -> {score, breakdown, rejected}` where
    `breakdown` is `Array<{label: string, points: number}>`

`DEFAULT_PREFS`, carried over from the constants in `app.js`:

```js
{ freeDays: ['F'], freeDayWeight: 200, compactness: 0.5, maxGap: null,
  avoidSingleCourseDays: true, singleCourseDayPenalty: 100 }
```

- [ ] **Step 1: Write the failing test**

Create `test/scoring.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/scoring.js');
const P = require('../src/course-parser.js');

// Helper: a section occupying the given slots, e.g. sec('COMP1111', [[0,1],[0,2]])
function sec(base, pairs) {
  const slots = pairs.map(([day, hour]) => ({ day, hour }));
  return { base, code: base + '.1', slots, mask: P.slotsToMask(slots) };
}

const prefs = (over) => Object.assign({}, S.DEFAULT_PREFS, over);

test('a requested free day that stays empty earns the weight', () => {
  const monOnly = [sec('A', [[0, 1], [0, 2]]), sec('B', [[0, 3], [0, 4]])];
  const withFriday = [sec('A', [[0, 1], [0, 2]]), sec('B', [[4, 3], [4, 4]])];
  const p = prefs({ freeDays: ['F'], freeDayWeight: 200, avoidSingleCourseDays: false });
  assert.strictEqual(S.scoreSchedule(monOnly, p).score, 200);
  assert.strictEqual(S.scoreSchedule(withFriday, p).score, 0);
});

test('gap hours are penalised in proportion to compactness', () => {
  // Monday hours 1 and 5 -> a 3-hour gap.
  const gappy = [sec('A', [[0, 1]]), sec('B', [[0, 5]])];
  const p = prefs({ freeDays: [], compactness: 1, avoidSingleCourseDays: false });
  const result = S.scoreSchedule(gappy, p);
  assert.ok(result.score < 0, 'expected a penalty, got ' + result.score);
  const relaxed = S.scoreSchedule(gappy, prefs({
    freeDays: [], compactness: 0, avoidSingleCourseDays: false }));
  assert.strictEqual(relaxed.score, 0);
});

test('a negative compactness rewards gaps instead', () => {
  const gappy = [sec('A', [[0, 1]]), sec('B', [[0, 5]])];
  const p = prefs({ freeDays: [], compactness: -1, avoidSingleCourseDays: false });
  assert.ok(S.scoreSchedule(gappy, p).score > 0);
});

test('maxGap rejects a schedule outright', () => {
  const gappy = [sec('A', [[0, 1]]), sec('B', [[0, 6]])];   // 4-hour gap
  assert.strictEqual(S.scoreSchedule(gappy, prefs({ maxGap: 2 })).rejected, true);
  assert.strictEqual(S.scoreSchedule(gappy, prefs({ maxGap: 9 })).rejected, false);
});

test('a day holding one distinct course is penalised when enabled', () => {
  const lonely = [sec('A', [[0, 1], [0, 2]])];
  const on = prefs({ freeDays: [], avoidSingleCourseDays: true, singleCourseDayPenalty: 100 });
  const off = prefs({ freeDays: [], avoidSingleCourseDays: false });
  assert.strictEqual(S.scoreSchedule(lonely, on).score, -100);
  assert.strictEqual(S.scoreSchedule(lonely, off).score, 0);
});

test('a lecture and its own lab on one day is still a single-course day', () => {
  const pair = [sec('A', [[0, 1]]), sec('A', [[0, 2]])];   // same base
  const p = prefs({ freeDays: [], avoidSingleCourseDays: true, singleCourseDayPenalty: 100 });
  assert.strictEqual(S.scoreSchedule(pair, p).score, -100);
});

test('the breakdown explains every point awarded', () => {
  const s = [sec('A', [[0, 1]]), sec('B', [[0, 5]])];
  const result = S.scoreSchedule(s, prefs({ freeDays: ['F'] }));
  const total = result.breakdown.reduce((sum, item) => sum + item.points, 0);
  assert.strictEqual(total, result.score);
  assert.ok(result.breakdown.every((item) => typeof item.label === 'string' && item.label.length > 0));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/scoring.test.js`
Expected: FAIL — `Cannot find module '../src/scoring.js'`

- [ ] **Step 3: Implement scoring**

Create `src/scoring.js`:

```js
'use strict';
(function (root, factory) {
  const parser = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./course-parser.js')
    : root.CourseParser;
  const api = factory(parser);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Scoring = api; }
})(typeof self !== 'undefined' ? self : this, function (CourseParser) {
  const DAYS = CourseParser.DAYS;

  const DEFAULT_PREFS = {
    freeDays: ['F'],
    freeDayWeight: 200,
    compactness: 0.5,
    maxGap: null,
    avoidSingleCourseDays: true,
    singleCourseDayPenalty: 100,
  };

  const GAP_UNIT = 20;   // points per gap hour at compactness 1

  function dayHours(sections) {
    const perDay = DAYS.map(() => []);
    for (const section of sections) {
      for (const slot of section.slots) perDay[slot.day].push(slot.hour);
    }
    return perDay.map((hours) => hours.slice().sort((a, b) => a - b));
  }

  function dayBases(sections) {
    const perDay = DAYS.map(() => new Set());
    for (const section of sections) {
      for (const slot of section.slots) perDay[slot.day].add(section.base);
    }
    return perDay;
  }

  function gapsFor(hours) {
    const gaps = [];
    for (let i = 0; i < hours.length - 1; i++) {
      const gap = hours[i + 1] - hours[i] - 1;
      if (gap > 0) gaps.push(gap);
    }
    return gaps;
  }

  function scoreSchedule(sections, prefs) {
    const settings = Object.assign({}, DEFAULT_PREFS, prefs || {});
    const perDayHours = dayHours(sections);
    const perDayBases = dayBases(sections);
    const breakdown = [];
    let score = 0;

    for (const dayCode of settings.freeDays) {
      const index = DAYS.indexOf(dayCode);
      if (index >= 0 && perDayHours[index].length === 0) {
        score += settings.freeDayWeight;
        breakdown.push({ label: dayCode + ' kept free', points: settings.freeDayWeight });
      }
    }

    let totalGapHours = 0;
    for (let day = 0; day < DAYS.length; day++) {
      for (const gap of gapsFor(perDayHours[day])) {
        if (settings.maxGap !== null && gap > settings.maxGap) {
          return { score: 0, breakdown: [], rejected: true };
        }
        totalGapHours += gap;
      }
    }

    if (totalGapHours > 0 && settings.compactness !== 0) {
      const points = Math.round(-settings.compactness * GAP_UNIT * totalGapHours);
      score += points;
      breakdown.push({ label: totalGapHours + ' gap hour(s)', points });
    }

    if (settings.avoidSingleCourseDays) {
      let lonelyDays = 0;
      for (let day = 0; day < DAYS.length; day++) {
        if (perDayBases[day].size === 1) lonelyDays++;
      }
      if (lonelyDays > 0) {
        const points = -lonelyDays * settings.singleCourseDayPenalty;
        score += points;
        breakdown.push({ label: lonelyDays + ' day(s) with a single course', points });
      }
    }

    return { score, breakdown, rejected: false };
  }

  return { DEFAULT_PREFS, dayHours, scoreSchedule };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/scoring.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/scoring.js test/scoring.test.js
git commit -m "feat: preference scoring with per-rule breakdown"
```

---

### Task 6: Solver — search, Madde 18, dedup

**Files:**
- Create: `src/solver.js`
- Create: `test/solver.test.js`

**Interfaces:**
- Consumes: `CourseParser.DAYS`, `Scoring.scoreSchedule`.
- Produces: `Solver.solve(courses, prefs, options) -> {results, truncated, explored, considered}` where
  `results` is `Array<{sections, score, rawScore, breakdown, overlapHours, alternates}>`,
  sorted best-first and capped at `options.limit` (default 10).
  `options` is `{limit = 10, allowOverlap = false, nodeCap = 2000000}`.

- [ ] **Step 1: Write the failing test**

Create `test/solver.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Solver = require('../src/solver.js');
const S = require('../src/scoring.js');
const P = require('../src/course-parser.js');

function sec(code, base, kind, pairs) {
  const slots = pairs.map(([day, hour]) => ({ day, hour }));
  return { code, base, kind, slots, mask: P.slotsToMask(slots), truncated: false, unscheduled: false };
}
function course(base, groups) {
  return { base, title: base, credit: 3,
    groups: Object.assign({ LEC: [], LAB: [], PS: [] }, groups) };
}
const prefs = (over) => Object.assign({}, S.DEFAULT_PREFS,
  { freeDays: [], compactness: 0, avoidSingleCourseDays: false }, over);

test('solve returns only conflict-free schedules by default', () => {
  const a = course('A', { LEC: [sec('A.1', 'A', 'LEC', [[0, 1]]), sec('A.2', 'A', 'LEC', [[0, 2]])] });
  const b = course('B', { LEC: [sec('B.1', 'B', 'LEC', [[0, 1]])] });
  const { results } = Solver.solve([a, b], prefs(), { limit: 10 });
  assert.strictEqual(results.length, 1);
  assert.deepStrictEqual(results[0].sections.map((s) => s.code).sort(), ['A.2', 'B.1']);
});

test('adjacent hours are not a conflict', () => {
  const a = course('A', { LEC: [sec('A.1', 'A', 'LEC', [[0, 1]])] });
  const b = course('B', { LEC: [sec('B.1', 'B', 'LEC', [[0, 2]])] });
  assert.strictEqual(Solver.solve([a, b], prefs(), {}).results.length, 1);
});

test('every non-empty group must contribute exactly one section', () => {
  const a = course('A', {
    LEC: [sec('A.1', 'A', 'LEC', [[0, 1]])],
    LAB: [sec('A-L.1', 'A', 'LAB', [[1, 1]])],
  });
  const { results } = Solver.solve([a], prefs(), {});
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].sections.length, 2);
});

test('time-identical sections collapse into one result with alternates', () => {
  // Three labs all meeting at Th2 — the real COMP1111 case.
  const a = course('A', {
    LEC: [sec('A.1', 'A', 'LEC', [[0, 1]])],
    LAB: [sec('A-L.1', 'A', 'LAB', [[3, 2]]),
          sec('A-L.2', 'A', 'LAB', [[3, 2]]),
          sec('A-L.3', 'A', 'LAB', [[3, 2]])],
  });
  const { results } = Solver.solve([a], prefs(), {});
  assert.strictEqual(results.length, 1, 'expected one distinct timetable');
  assert.strictEqual(results[0].alternates.length, 2, 'expected two interchangeable labs');
});

test('Madde 18 mode accepts two pairs overlapping one hour each', () => {
  const a = course('A', { LEC: [sec('A.1', 'A', 'LEC', [[0, 1]])] });
  const b = course('B', { LEC: [sec('B.1', 'B', 'LEC', [[0, 1]])] });   // 1h with A
  const c = course('C', { LEC: [sec('C.1', 'C', 'LEC', [[1, 1]])] });
  const d = course('D', { LEC: [sec('D.1', 'D', 'LEC', [[1, 1]])] });   // 1h with C
  assert.strictEqual(Solver.solve([a, b, c, d], prefs(), { allowOverlap: false }).results.length, 0);
  const relaxed = Solver.solve([a, b, c, d], prefs(), { allowOverlap: true });
  assert.strictEqual(relaxed.results.length, 1);
  assert.strictEqual(relaxed.results[0].overlapHours, 2);
});

test('Madde 18 mode rejects a third overlapping pair', () => {
  const mk = (n, day) => course(n, { LEC: [sec(n + '.1', n, 'LEC', [[day, 1]])] });
  const courses = [mk('A', 0), mk('B', 0), mk('C', 1), mk('D', 1), mk('E', 2), mk('F', 2)];
  assert.strictEqual(Solver.solve(courses, prefs(), { allowOverlap: true }).results.length, 0);
});

test('Madde 18 mode rejects a single pair overlapping two hours', () => {
  const a = course('A', { LEC: [sec('A.1', 'A', 'LEC', [[0, 1], [0, 2]])] });
  const b = course('B', { LEC: [sec('B.1', 'B', 'LEC', [[0, 1], [0, 2]])] });
  assert.strictEqual(Solver.solve([a, b], prefs(), { allowOverlap: true }).results.length, 0);
});

test('results are ordered best-first', () => {
  const a = course('A', {
    LEC: [sec('A.1', 'A', 'LEC', [[0, 1]]), sec('A.2', 'A', 'LEC', [[4, 1]])] });
  const p = prefs({ freeDays: ['F'], freeDayWeight: 200 });
  const { results } = Solver.solve([a], p, {});
  assert.strictEqual(results[0].sections[0].code, 'A.1', 'the Friday-free option should win');
  assert.ok(results[0].rawScore >= results[1].rawScore);
});

test('the node cap stops the search and reports truncation', () => {
  const many = [];
  for (let i = 0; i < 12; i++) {
    const options = [];
    for (let j = 1; j <= 6; j++) options.push(sec('C' + i + '.' + j, 'C' + i, 'LEC', [[i % 5, j]]));
    many.push(course('C' + i, { LEC: options }));
  }
  const out = Solver.solve(many, prefs(), { nodeCap: 500 });
  assert.strictEqual(out.truncated, true);
  assert.ok(out.explored <= 600);
});

// The truncated section carries real-looking slots, so only the `truncated`
// flag can be what excludes it — an empty slot list would pass this test for
// the wrong reason.
test('a truncated section is excluded even when it has slots', () => {
  const bad = sec('A.1', 'A', 'LEC', [[0, 1]]);
  bad.truncated = true;
  const good = sec('A.2', 'A', 'LEC', [[0, 2]]);
  const { results } = Solver.solve([course('A', { LEC: [bad, good] })], prefs(), {});
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].sections[0].code, 'A.2');
});

test('an unscheduled section is excluded from the search', () => {
  const bad = sec('A.1', 'A', 'LEC', [[0, 1]]);
  bad.unscheduled = true;
  const good = sec('A.2', 'A', 'LEC', [[0, 2]]);
  const { results } = Solver.solve([course('A', { LEC: [bad, good] })], prefs(), {});
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].sections[0].code, 'A.2');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/solver.test.js`
Expected: FAIL — `Cannot find module '../src/solver.js'`

- [ ] **Step 3: Implement the solver**

Create `src/solver.js`:

```js
'use strict';
(function (root, factory) {
  const isNode = typeof require !== 'undefined' && typeof module !== 'undefined';
  const parser = isNode ? require('./course-parser.js') : root.CourseParser;
  const scoring = isNode ? require('./scoring.js') : root.Scoring;
  const api = factory(parser, scoring);
  if (isNode) module.exports = api;
  else { root.Solver = api; }
})(typeof self !== 'undefined' ? self : this, function (CourseParser, Scoring) {
  const DAYS = CourseParser.DAYS;
  const MAX_HOUR = CourseParser.MAX_HOUR;

  const MAX_OVERLAP_PAIRS = 2;      // Madde 18/2: at most two courses...
  const MAX_HOURS_PER_PAIR = 1;     // ...overlapping by one hour each

  // A group is a mandatory pick-one. Sections we cannot place are dropped here,
  // so a truncated row never contributes unknown meeting times to a timetable.
  function buildGroups(courses) {
    const groups = [];
    for (const course of courses) {
      for (const kind of ['LEC', 'LAB', 'PS']) {
        const options = course.groups[kind].filter(
          (s) => !s.truncated && !s.unscheduled && s.slots.length > 0);
        if (options.length > 0) groups.push({ base: course.base, kind, options });
      }
    }
    // Fewest options first: conflicts surface early and prune more.
    return groups.sort((a, b) => a.options.length - b.options.length);
  }

  function signatureOf(sections) {
    const parts = [];
    for (const section of sections) {
      for (const slot of section.slots) parts.push(section.base + '@' + slot.day + ':' + slot.hour);
    }
    return parts.sort().join('|');
  }

  function solve(courses, prefs, options) {
    const opts = Object.assign({ limit: 10, allowOverlap: false, nodeCap: 2000000 }, options || {});
    const groups = buildGroups(courses);

    const occupancy = new Uint16Array(DAYS.length);
    const owner = new Int16Array(DAYS.length * (MAX_HOUR + 1)).fill(-1);
    const chosen = [];
    const pairHours = new Map();

    const bySignature = new Map();
    const results = [];
    let explored = 0;
    let considered = 0;
    let truncated = false;

    function overlapTotal() {
      let total = 0;
      for (const hours of pairHours.values()) total += hours;
      return total;
    }

    // Returns the list of (day, hour, previousOwner) triples this section collides
    // with, or null when the collision is not permissible.
    function collisionsFor(section, index) {
      const hits = [];
      for (const slot of section.slots) {
        if ((occupancy[slot.day] & (1 << (slot.hour - 1))) === 0) continue;
        if (!opts.allowOverlap) return null;
        hits.push(slot);
      }
      if (hits.length === 0) return hits;

      const trial = new Map(pairHours);
      for (const slot of hits) {
        const previous = owner[slot.day * (MAX_HOUR + 1) + slot.hour];
        if (previous < 0) return null;
        const key = previous < index ? previous + '-' + index : index + '-' + previous;
        const next = (trial.get(key) || 0) + 1;
        if (next > MAX_HOURS_PER_PAIR) return null;
        trial.set(key, next);
      }
      if (trial.size > MAX_OVERLAP_PAIRS) return null;
      return hits;
    }

    function place(section, index, hits) {
      for (const slot of section.slots) {
        occupancy[slot.day] |= (1 << (slot.hour - 1));
        const cell = slot.day * (MAX_HOUR + 1) + slot.hour;
        if (owner[cell] < 0) owner[cell] = index;
      }
      for (const slot of hits) {
        const previous = owner[slot.day * (MAX_HOUR + 1) + slot.hour];
        const key = previous < index ? previous + '-' + index : index + '-' + previous;
        pairHours.set(key, (pairHours.get(key) || 0) + 1);
      }
    }

    function restore(savedMask, savedOwner, savedPairs) {
      occupancy.set(savedMask);
      owner.set(savedOwner);
      pairHours.clear();
      for (const [key, value] of savedPairs) pairHours.set(key, value);
    }

    function record() {
      considered++;
      const evaluation = Scoring.scoreSchedule(chosen, prefs);
      if (evaluation.rejected) return;

      const signature = signatureOf(chosen);
      const existing = bySignature.get(signature);
      if (existing) {
        // Same timetable, different section numbers: keep it as an alternative.
        const codes = existing.sections.map((s) => s.code).join(',');
        const candidate = chosen.map((s) => s.code).join(',');
        if (codes !== candidate && existing.alternates.length < 20) {
          existing.alternates.push(chosen.map((s) => s.code));
        }
        return;
      }

      const entry = {
        sections: chosen.slice(),
        rawScore: evaluation.score,
        score: evaluation.score,
        breakdown: evaluation.breakdown,
        overlapHours: overlapTotal(),
        alternates: [],
      };
      bySignature.set(signature, entry);
      results.push(entry);
    }

    function search(depth) {
      if (truncated) return;
      if (depth === groups.length) { record(); return; }

      for (const section of groups[depth].options) {
        if (++explored > opts.nodeCap) { truncated = true; return; }

        const hits = collisionsFor(section, depth);
        if (hits === null) continue;

        const savedMask = occupancy.slice();
        const savedOwner = owner.slice();
        const savedPairs = [...pairHours.entries()];

        place(section, depth, hits);
        chosen.push(section);
        search(depth + 1);
        chosen.pop();
        restore(savedMask, savedOwner, savedPairs);

        if (truncated) return;
      }
    }

    if (groups.length > 0) search(0);

    // Clean schedules outrank equally-scoring ones that lean on Madde 18.
    results.sort((a, b) => (b.rawScore - a.rawScore) || (a.overlapHours - b.overlapHours));
    const top = results.slice(0, opts.limit);

    const best = top.length ? top[0].rawScore : 0;
    const worst = top.length ? top[top.length - 1].rawScore : 0;
    for (const entry of top) {
      entry.score = best === worst ? 100 : Math.round(((entry.rawScore - worst) / (best - worst)) * 100);
    }

    return { results: top, truncated, explored, considered };
  }

  return { solve, MAX_OVERLAP_PAIRS, MAX_HOURS_PER_PAIR };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/solver.test.js`
Expected: PASS — 10 tests.

- [ ] **Step 5: Add an end-to-end test against the real file**

Append to `test/solver.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/xlsx-reader.js');

test('end to end: real file, real courses, conflict-free results', async () => {
  const bytes = new Uint8Array(fs.readFileSync(
    path.join(__dirname, 'fixtures', '2026_Guz_Haftalik_Ders_Programi.xlsx')));
  const { rows } = await R.readWorkbook(bytes);
  const { courses } = P.buildCourses(rows, P.detectColumns(rows));
  // These three genuinely co-exist, and COMP1111 contributes three identical-time
  // lab sections, so this also exercises the dedup path on real data.
  const picked = ['COMP1111', 'ARCH2210', 'ARCH2214']
    .map((base) => courses.find((c) => c.base === base));
  assert.ok(picked.every(Boolean), 'fixture courses missing');

  const { results } = Solver.solve(picked, S.DEFAULT_PREFS, { limit: 10 });
  assert.strictEqual(results.length, 2, 'expected two distinct timetables');
  // COMP1111-L.1/.2/.3 all meet at Th2-Th3, so each result keeps one and carries
  // the other two as interchangeable alternates rather than as duplicate results.
  assert.strictEqual(results[0].alternates.length, 2);
  for (const entry of results) {
    assert.strictEqual(entry.overlapHours, 0, 'strict mode must not use the overlap allowance');
  }

  for (const entry of results) {
    const seen = new Set();
    for (const section of entry.sections) {
      for (const slot of section.slots) {
        const key = slot.day + ':' + slot.hour;
        assert.ok(!seen.has(key), 'conflict at ' + key + ' in a strict-mode result');
        seen.add(key);
      }
    }
  }
});
```

Also append this companion test, which pins a real impossible combination:

```js
// A real course set with NO conflict-free arrangement — the 'no results' path
// users will actually hit. COMP1111's three lab sections all meet at Th2-Th3,
// and COMP1113's only lecture occupies Th1-Th3, so the two can never co-exist.
test('end to end: a genuinely impossible course set returns no schedules', async () => {
  const bytes = new Uint8Array(fs.readFileSync(
    path.join(__dirname, 'fixtures', '2026_Guz_Haftalik_Ders_Programi.xlsx')));
  const { rows } = await R.readWorkbook(bytes);
  const { courses } = P.buildCourses(rows, P.detectColumns(rows));
  const picked = ['COMP1111', 'COMP1113'].map((base) => courses.find((c) => c.base === base));

  assert.strictEqual(Solver.solve(picked, S.DEFAULT_PREFS, {}).results.length, 0);
  // Not even the Madde 18 allowance rescues it: the clash is 2 hours on one pair,
  // over the one-hour-per-pair limit.
  assert.strictEqual(
    Solver.solve(picked, S.DEFAULT_PREFS, { allowOverlap: true }).results.length, 0);
});
```

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add src/solver.js test/solver.test.js
git commit -m "feat: pruning bitmask solver with Madde 18 tolerance and dedup"
```

---

### Task 7: UI shell — load, chips, search, credit bar

**Files:**
- Create: `index.html`
- Create: `src/ui.js`

**Interfaces:**
- Consumes: `XlsxReader.readWorkbook`, `CourseParser.detectColumns`, `CourseParser.buildCourses`, `Scoring.DEFAULT_PREFS`.
- Produces: `UI.state` — `{courses, warnings, selected: Set<string>, prefs}`; `UI.render()`.

- [ ] **Step 1: Create the page shell**

Create `index.html`:

```html
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ders Programı İhtimalleri</title>
<style>
  :root {
    --bg: #f7f8fa; --card: #ffffff; --ink: #1c2024; --muted: #6b7280;
    --line: #e3e6ea; --accent: #2563eb; --accent-soft: #eaf1ff;
    --warn: #b45309; --warn-soft: #fff7ed;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
         background: var(--bg); color: var(--ink); }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
          padding: 16px; margin-bottom: 16px; }

  #drop { border: 2px dashed var(--line); border-radius: 10px; padding: 32px; text-align: center;
          background: var(--card); cursor: pointer; }
  #drop.over { border-color: var(--accent); background: var(--accent-soft); }

  .bar { position: sticky; top: 0; z-index: 5; background: var(--card);
         border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px;
         margin-bottom: 16px; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  .stat b { font-size: 20px; } .stat span { color: var(--muted); }

  #search { width: 100%; padding: 10px 12px; border: 1px solid var(--line);
            border-radius: 8px; font: inherit; }

  /* Content-sized chips in a wrapping row, so rows stay ragged rather than gridded. */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px;
           max-height: 340px; overflow-y: auto; }
  .chip { position: relative; }
  .chip input { position: absolute; opacity: 0; width: 0; height: 0; }
  .chip span { display: inline-block; padding: 6px 12px; border: 1px solid var(--line);
               border-radius: 999px; background: var(--card); cursor: pointer;
               white-space: nowrap; user-select: none; }
  .chip input:checked + span { background: var(--accent); border-color: var(--accent); color: #fff; }
  .chip input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chip .cr { opacity: .65; margin-left: 6px; }

  #tip { position: fixed; z-index: 50; max-width: 320px; padding: 8px 10px; border-radius: 8px;
         background: #111827; color: #fff; font-size: 12px; line-height: 1.45;
         pointer-events: none; display: none; }
  #tip b { display: block; margin-bottom: 4px; }

  .warn { background: var(--warn-soft); border-color: #fed7aa; color: var(--warn); }
  .err  { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Ders Programı İhtimalleri</h1>
  <p class="sub">Ders programı XLSX dosyanı yükle, derslerini seç, en iyi haftalık programları gör.
    Dosya bilgisayarından çıkmaz.</p>

  <div id="drop">
    <strong>XLSX dosyasını buraya sürükle</strong><br>
    <span class="sub">veya tıklayarak seç</span>
    <input id="file" type="file" accept=".xlsx" hidden>
  </div>

  <div id="error" class="card err hidden"></div>
  <div id="warnings" class="card warn hidden"></div>

  <div id="app" class="hidden">
    <div class="bar">
      <div class="stat"><b id="credits">0</b> <span>kredi seçildi</span></div>
      <div class="stat"><b id="count">0</b> <span>ders</span></div>
      <div class="stat">
        <select id="gno">
          <option value="0">GNO seç…</option>
          <option value="30">1. sınıf — 30 AKTS</option>
          <option value="31">GNO ≤ 2.49 — 31 AKTS</option>
          <option value="37">GNO 2.50–3.49 — 37 AKTS</option>
          <option value="43">GNO ≥ 3.50 — 43 AKTS</option>
          <option value="45">ÇAP — 45 AKTS</option>
        </select>
        <span id="gauge" class="sub"></span>
      </div>
    </div>

    <div class="card">
      <input id="search" type="search" placeholder="Ders kodu, ad veya öğretim üyesi ara…">
      <div id="chips" class="chips"></div>
    </div>
  </div>
</main>
<div id="tip" role="tooltip"></div>

<script src="src/xlsx-reader.js"></script>
<script src="src/course-parser.js"></script>
<script src="src/scoring.js"></script>
<script src="src/solver.js"></script>
<script src="src/ui.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement load, chips, search and the credit bar**

Create `src/ui.js`:

```js
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { courses: [], warnings: [], selected: new Set(), prefs: null, akts: false };

  function showError(message) {
    $('error').textContent = message;
    $('error').classList.remove('hidden');
  }

  // Diacritic-insensitive so 'ısı' matches 'İSİ'.
  const fold = (s) => (s || '').toLocaleLowerCase('tr')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ş/g, 's')
    .replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ç/g, 'c');

  async function loadFile(file) {
    $('error').classList.add('hidden');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { rows } = await XlsxReader.readWorkbook(bytes);
      const cols = CourseParser.detectColumns(rows);
      const built = CourseParser.buildCourses(rows, cols);
      state.courses = built.courses;
      state.warnings = built.warnings;
      state.akts = Boolean(cols.akts);
      state.prefs = Object.assign({}, Scoring.DEFAULT_PREFS);
      restore();
      $('drop').classList.add('hidden');
      $('app').classList.remove('hidden');
      renderWarnings();
      renderChips();
      renderSummary();
    } catch (err) {
      showError(err.message || String(err));
    }
  }

  function renderWarnings() {
    const box = $('warnings');
    if (state.warnings.length === 0) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const list = state.warnings.slice(0, 12)
      .map((w) => '<li><code>' + w.code + '</code> — ' + w.reason + '</li>').join('');
    const more = state.warnings.length > 12
      ? '<li>…ve ' + (state.warnings.length - 12) + ' tane daha</li>' : '';
    box.innerHTML = '<strong>' + state.warnings.length +
      ' bölüm tam okunamadı ve planlamaya dahil edilmedi:</strong><ul>' + list + more + '</ul>';
  }

  function chipLabel(course) {
    const credit = course.credit > 0 ? course.credit : '—';
    return course.base + '<span class="cr">' + credit + '</span>';
  }

  function renderChips() {
    const query = fold($('search').value.trim());
    const matches = state.courses.filter((course) => {
      if (!query) return true;
      const hay = fold(course.base + ' ' + course.title + ' ' +
        course.groups.LEC.map((s) => s.instructor).join(' '));
      return hay.includes(query);
    });

    const box = $('chips');
    box.innerHTML = '';
    for (const course of matches.slice(0, 400)) {
      const label = document.createElement('label');
      label.className = 'chip';
      label.dataset.base = course.base;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.selected.has(course.base);
      input.addEventListener('change', () => {
        if (input.checked) state.selected.add(course.base);
        else state.selected.delete(course.base);
        persist();
        renderSummary();
      });
      const span = document.createElement('span');
      span.innerHTML = chipLabel(course);
      label.appendChild(input);
      label.appendChild(span);
      box.appendChild(label);
    }
    if (matches.length === 0) {
      box.innerHTML = '<p class="sub">Eşleşen ders yok.</p>';
    }
  }

  function tooltipFor(course) {
    const sections = course.groups.LEC.concat(course.groups.LAB, course.groups.PS);
    const first = sections[0] || {};
    const times = sections.map((s) => s.code + ': ' +
      s.slots.map((sl) => CourseParser.DAYS[sl.day] + sl.hour).join(' ')).slice(0, 6).join('\n');
    const quota = first.quota ? first.quota.left + ' / ' + first.quota.total + ' kontenjan' : '';
    return '<b>' + (course.title || course.base) + '</b>' +
      (first.instructor ? first.instructor + ' · ' : '') + (first.campus || '') +
      (quota ? ' · ' + quota : '') +
      '<br>' + sections.length + ' bölüm<br><pre style="margin:4px 0 0;font:inherit">' +
      times + '</pre>';
  }

  function wireTooltip() {
    const tip = $('tip');
    $('chips').addEventListener('mouseover', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      const course = state.courses.find((c) => c.base === chip.dataset.base);
      if (!course) return;
      tip.innerHTML = tooltipFor(course);
      tip.style.display = 'block';
      const box = chip.getBoundingClientRect();
      tip.style.left = Math.min(box.left, window.innerWidth - 340) + 'px';
      tip.style.top = (box.bottom + 8) + 'px';
    });
    $('chips').addEventListener('mouseout', (event) => {
      if (!event.target.closest('.chip')) return;
      tip.style.display = 'none';
    });
  }

  function renderSummary() {
    const chosen = state.courses.filter((c) => state.selected.has(c.base));
    const credits = chosen.reduce((sum, c) => sum + c.credit, 0);
    $('credits').textContent = credits;
    $('count').textContent = chosen.length;

    const ceiling = Number($('gno').value);
    const gauge = $('gauge');
    if (!ceiling) { gauge.textContent = ''; return; }
    if (state.akts) {
      const total = chosen.reduce((sum, c) => sum + (c.akts || 0), 0);
      gauge.textContent = total + ' / ' + ceiling + ' AKTS';
    } else {
      // The file carries local kredi, not AKTS, so this comparison is indicative only.
      gauge.textContent = 'sınır ' + ceiling + ' AKTS — bu dosyada AKTS yok, ' +
        'kredi ile karşılaştırma yaklaşıktır';
    }
  }

  function persist() {
    try {
      localStorage.setItem('dpi.selected', JSON.stringify([...state.selected]));
      localStorage.setItem('dpi.prefs', JSON.stringify(state.prefs));
    } catch (err) { /* private window or blocked storage: run without memory */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem('dpi.selected') || '[]');
      state.selected = new Set(saved.filter(
        (base) => state.courses.some((c) => c.base === base)));
      const prefs = JSON.parse(localStorage.getItem('dpi.prefs') || 'null');
      if (prefs) state.prefs = Object.assign({}, Scoring.DEFAULT_PREFS, prefs);
    } catch (err) { state.selected = new Set(); }
  }

  function wire() {
    const drop = $('drop');
    drop.addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    $('search').addEventListener('input', renderChips);
    $('gno').addEventListener('change', renderSummary);
    wireTooltip();
  }

  wire();
  window.UI = { state, renderChips, renderSummary };
})();
```

- [ ] **Step 3: Verify manually in a browser**

Open `index.html` directly (double-click, or `start index.html`). Then check:

1. Drop `D:/Downloads/2026_Guz_Haftalik_Ders_Programi.xlsx` onto the drop zone.
2. Chips appear, wrapping in ragged rows, each showing code + credit only.
3. A warnings panel lists the truncated `PREP` sections.
4. Hovering a chip shows the full title, instructor, campus and meeting times.
5. Typing `programlama` filters to the COMP courses; typing `ısı` matches Turkish titles.
6. Checking chips raises the credit total; `COMP1111` adds 4, not 8 (lab not double-counted).
7. Reload the page and re-drop the file — the previous selection is restored.

- [ ] **Step 4: Commit**

```bash
git add index.html src/ui.js
git commit -m "feat: file load, searchable chip list, credit and AKTS summary bar"
```

---

### Task 8: Preferences, results calendar, print

**Files:**
- Modify: `index.html` (add preferences and results markup + CSS)
- Modify: `src/ui.js` (add preference wiring and calendar rendering)

**Interfaces:**
- Consumes: `Solver.solve`, `Scoring.DEFAULT_PREFS`, `CourseParser.DAYS`, `CourseParser.MAX_HOUR`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the markup**

In `index.html`, insert immediately before `</div>` that closes `<div id="app">`:

```html
    <div class="card">
      <strong>Tercihler</strong>
      <div class="prefs">
        <div>
          <label>Boş kalsın istediğin günler</label>
          <div id="freedays" class="days"></div>
          <label>Boş gün önemi <output id="fdwOut">200</output></label>
          <input id="fdw" type="range" min="0" max="500" step="25" value="200">
        </div>
        <div>
          <label>Sıkışık ↔ aralıklı <output id="cmpOut">0.5</output></label>
          <input id="cmp" type="range" min="-1" max="1" step="0.1" value="0.5">
          <label>En fazla boşluk (saat, boş = sınırsız)</label>
          <input id="maxgap" type="number" min="0" max="12" placeholder="sınırsız">
        </div>
        <div>
          <label><input id="single" type="checkbox" checked>
            Tek derslik günlerden kaçın</label>
          <label><input id="overlap" type="checkbox">
            Madde 18/2: en fazla 2 ders 1'er saat çakışabilsin</label>
        </div>
      </div>
      <button id="go" class="primary">En iyi 10 programı hesapla</button>
      <span id="status" class="sub"></span>
    </div>

    <div id="results"></div>
```

Add to the `<style>` block:

```css
  .prefs { display: flex; flex-wrap: wrap; gap: 24px; margin: 12px 0 16px; }
  .prefs > div { min-width: 240px; flex: 1; }
  .prefs label { display: block; margin: 8px 0 4px; color: var(--muted); font-size: 13px; }
  .prefs input[type=range] { width: 100%; }
  .days { display: flex; gap: 6px; flex-wrap: wrap; }
  .days button { padding: 5px 10px; border: 1px solid var(--line); background: var(--card);
                 border-radius: 999px; cursor: pointer; font: inherit; }
  .days button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary { padding: 10px 16px; border: 0; border-radius: 8px; background: var(--accent);
                   color: #fff; font: inherit; font-weight: 600; cursor: pointer; }

  .sched { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
           padding: 16px; margin-bottom: 16px; break-inside: avoid; }
  .sched header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .sched h3 { margin: 0; font-size: 16px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px;
           background: var(--warn-soft); color: var(--warn); border: 1px solid #fed7aa; }
  .cal { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .cal th, .cal td { border: 1px solid var(--line); padding: 3px; height: 26px;
                     font-size: 12px; text-align: center; }
  .cal th:first-child, .cal td:first-child { width: 44px; color: var(--muted); }
  .cal td.busy { font-weight: 600; }
  .scroll { overflow-x: auto; }
  @media print {
    #drop, .bar, .prefs, #go, #search, .chips, #warnings { display: none !important; }
    .sched { border-color: #999; }
  }
```

- [ ] **Step 2: Wire the preferences and render results**

In `src/ui.js`, add these functions before the final `wire();` call:

```js
  function renderFreeDays() {
    const box = $('freedays');
    box.innerHTML = '';
    for (const day of CourseParser.DAYS.slice(0, 6)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = day;
      button.className = state.prefs.freeDays.includes(day) ? 'on' : '';
      button.addEventListener('click', () => {
        const at = state.prefs.freeDays.indexOf(day);
        if (at >= 0) state.prefs.freeDays.splice(at, 1);
        else state.prefs.freeDays.push(day);
        button.classList.toggle('on');
        persist();
      });
      box.appendChild(button);
    }
  }

  function readPrefs() {
    state.prefs.freeDayWeight = Number($('fdw').value);
    state.prefs.compactness = Number($('cmp').value);
    const gap = $('maxgap').value;
    state.prefs.maxGap = gap === '' ? null : Number(gap);
    state.prefs.avoidSingleCourseDays = $('single').checked;
    persist();
    return state.prefs;
  }

  const PALETTE = ['#dbeafe', '#dcfce7', '#fef3c7', '#fae8ff', '#ffe4e6',
                   '#e0e7ff', '#ccfbf1', '#ffedd5'];
  function colourFor(base) {
    let hash = 0;
    for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }

  function calendarFor(entry) {
    const used = new Set();
    for (const section of entry.sections) {
      for (const slot of section.slots) used.add(slot.day);
    }
    const days = CourseParser.DAYS
      .map((code, index) => ({ code, index }))
      .filter((d) => d.index < 5 || used.has(d.index));

    const grid = new Map();
    for (const section of entry.sections) {
      for (const slot of section.slots) grid.set(slot.day + ':' + slot.hour, section);
    }

    let html = '<div class="scroll"><table class="cal"><thead><tr><th></th>';
    for (const day of days) html += '<th>' + day.code + '</th>';
    html += '</tr></thead><tbody>';
    for (let hour = 1; hour <= CourseParser.MAX_HOUR; hour++) {
      html += '<tr><th>' + hour + '</th>';
      for (const day of days) {
        const section = grid.get(day.index + ':' + hour);
        html += section
          ? '<td class="busy" style="background:' + colourFor(section.base) + '">' +
            section.code + '</td>'
          : '<td></td>';
      }
      html += '</tr>';
    }
    return html + '</tbody></table></div>';
  }

  function renderResults(output) {
    const box = $('results');
    box.innerHTML = '';

    if (output.results.length === 0) {
      box.innerHTML = '<div class="card err">Çakışmayan hiçbir kombinasyon bulunamadı. ' +
        'Madde 18/2 seçeneğini açmayı ya da bir dersi çıkarmayı deneyebilirsin.</div>';
      return;
    }
    if (output.truncated) {
      box.innerHTML = '<div class="card warn">Arama sınıra takıldı — sonuçlar eksik olabilir. ' +
        'Daha az ders seçersen tam sonuç alırsın.</div>';
    }

    output.results.forEach((entry, index) => {
      const card = document.createElement('div');
      card.className = 'sched';
      const breakdown = entry.breakdown
        .map((item) => item.label + ' ' + (item.points > 0 ? '+' : '') + item.points)
        .join(' · ') || 'nötr';
      const badge = entry.overlapHours > 0
        ? '<span class="badge">' + entry.overlapHours +
          ' saat çakışma — danışman onayı gerekir</span>'
        : '';
      const alternates = entry.alternates.length
        ? '<p class="sub">Aynı saatlerde alternatif şubeler: ' +
          entry.alternates.map((codes) => codes.join(', ')).join(' | ') + '</p>'
        : '';
      card.innerHTML = '<header><h3>#' + (index + 1) + '</h3>' +
        '<span class="sub">puan ' + entry.score + '/100</span>' + badge + '</header>' +
        calendarFor(entry) +
        '<p class="sub">' + breakdown + '</p>' + alternates;
      box.appendChild(card);
    });
  }

  function run() {
    const chosen = state.courses.filter((c) => state.selected.has(c.base));
    if (chosen.length === 0) { $('status').textContent = 'Önce ders seç.'; return; }
    $('status').textContent = 'Hesaplanıyor…';
    // Yield once so the status text paints before the solver blocks the thread.
    setTimeout(() => {
      const started = Date.now();
      const output = Solver.solve(chosen, readPrefs(), {
        limit: 10, allowOverlap: $('overlap').checked,
      });
      $('status').textContent = output.considered + ' kombinasyon tarandı · ' +
        (Date.now() - started) + ' ms';
      renderResults(output);
    }, 0);
  }
```

Then extend `wire()` by adding, before its closing brace:

```js
    $('fdw').addEventListener('input', () => { $('fdwOut').textContent = $('fdw').value; });
    $('cmp').addEventListener('input', () => { $('cmpOut').textContent = $('cmp').value; });
    $('go').addEventListener('click', run);
```

And in `loadFile`, after `renderSummary();`, add:

```js
      renderFreeDays();
      $('fdw').value = state.prefs.freeDayWeight;
      $('fdwOut').textContent = state.prefs.freeDayWeight;
      $('cmp').value = state.prefs.compactness;
      $('cmpOut').textContent = state.prefs.compactness;
      $('single').checked = state.prefs.avoidSingleCourseDays;
```

- [ ] **Step 3: Verify manually in a browser**

Open `index.html`, load the XLSX, then confirm:

1. Select `COMP1111`, `COMP1113` and `MATH1001` and press the calculate button.
   (`MATH1001` has three lectures and three PS sections, two of which both meet at
   `F2` — so it exercises PS grouping and the dedup path at once.)
2. Up to ten calendar cards appear, ranked, each with a score and a plain-language breakdown.
3. No card shows two courses in the same cell.
4. Toggling `F` as a free day and recalculating moves Friday-free schedules to the top.
5. Setting max gap to `1` removes schedules with long gaps.
6. Enabling the Madde 18 checkbox on a selection that yields zero results produces badged results.
7. Cards show colour-coded courses, and a course keeps its colour across all cards.
8. `Ctrl+P` shows only the schedule cards.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites still green.

- [ ] **Step 5: Commit**

```bash
git add index.html src/ui.js
git commit -m "feat: preference controls, ranked weekly calendars and print layout"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §5.1 unzip → Task 1; §5.2 sheet scan (including the non-greedy regression) → Task 1; §5.3 column detection → Task 3; §5.4/§5.5 code and slot parsing → Task 2; §6 model and the count-credit-once rule → Task 4; §7.1 pruning search, §7.2 node cap, §7.3 Madde 18, §7.4 dedup-at-insertion → Task 6; §8 scoring → Task 5; §9 UI, chips, tooltips, persistence, print → Tasks 7–8; §10 rules → Tasks 6 and 8; §11 AKTS gauge → Task 7 `renderSummary`; §12 error handling → Task 1 (reader messages), Task 3 (named role failures), Tasks 7–8 (display); §13 testing → Tasks 1–6.

**Deliberate deviations from the spec.** Two, both recorded above: the single `schedule-core.js` of §4 is split into four focused modules with unchanged interfaces; and §5.2's `DOMParser` is replaced by a regex scanner so the sheet parser is testable in Node without adding jsdom. The spec was already amended for the second.

**Type consistency.** `parseSlots` returns `{slots, truncated}` in Tasks 2, 3, 4. `slots` entries are `{day: number, hour: number}` with `day` an index into `DAYS` everywhere. `scoreSchedule` returns `{score, breakdown, rejected}` in Tasks 5 and 6. `solve` returns `{results, truncated, explored, considered}`, consumed with exactly those names in Task 8. `detectColumns` returns the same eight keys produced in Task 3 and read in Task 4 and Task 7.

**Known rough edge to watch during execution.** Task 3's `detectColumns` runs `bestColumn` twice with identical predicates to separate the contact-hours column from an optional AKTS column; on the reference file the second call correctly finds nothing, but if a future file has two integer columns the assignment order decides which is which. Verify against the fixture assertion `cols.akts === null` before trusting it on other files.
