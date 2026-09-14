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

  const QUOTA_RE = /^-?\d+\s*\/\s*\d+$/;
  const INT_RE = /^\d+$/;

  // Excel column order is not lexicographic ('Z' precedes 'AA') and it is NOT
  // the order the keys happen to appear in: a column that is blank in the first
  // body row is first seen much later and would sort out of place, which in turn
  // mis-picks which text column is campus and which parts are the instructor.
  function compareColumns(a, b) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  }

  function columnLetters(rows) {
    const seen = new Set();
    for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
    return [...seen].sort(compareColumns);
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

  // ---------------------------------------------------------------------------
  // Header-based column detection: if the first row contains recognisable
  // header text, map it directly rather than inferring from data patterns.
  // This avoids the Local Credit / ECTS Credit / Course Hour(s) ambiguity that
  // arises when three integer columns must be ranked by slot-agreement alone.
  // ---------------------------------------------------------------------------
  const HEADER_MATCHERS = [
    { field: 'code',   re: /course\s*code/i },
    { field: 'title',  re: /title|course\s*name/i },
    { field: 'slots',  re: /time\s*slot/i },
    { field: 'quota',  re: /quota/i },
    { field: 'campus', re: /campus/i },
    { field: 'akts',   re: /ects/i },
    { field: 'hours',  re: /course\s*hour/i },
    // Instructor columns are gathered by suffix match below.
  ];

  function detectByHeaders(headerRow, letters) {
    const result = {};
    const instructorParts = [];
    for (const letter of letters) {
      const h = String(headerRow[letter] || '').trim();
      if (!h) continue;
      for (const { field, re } of HEADER_MATCHERS) {
        if (re.test(h) && !(field in result)) {
          result[field] = letter;
          break;
        }
      }
      if (/instructor\s*(name|surname|first|last)?/i.test(h)) {
        instructorParts.push(letter);
      }
    }
    result.instructorParts = instructorParts.slice(0, 2);
    return result;
  }

  function detectColumns(rows) {
    // Skip the header row: its text would otherwise pollute every match rate.
    const body = rows.slice(1);
    const letters = columnLetters(body);

    // --- Attempt header-based detection first ---
    const headerRow = rows[0] || {};
    const headerLetters = columnLetters([headerRow]);
    const fromHeaders = detectByHeaders(headerRow, headerLetters);

    // Check if the header gave us the minimum required fields.
    const headerHasCode  = fromHeaders.code  && matchRate(body, fromHeaders.code,  (v) => parseCode(v) !== null) > 0.4;
    const headerHasSlots = fromHeaders.slots && matchRate(body, fromHeaders.slots, (v) => {
      const p = parseSlots(v);
      return !p.truncated && p.slots.length > 0;
    }) > 0.2;

    if (headerHasCode && headerHasSlots) {
      // Header detection succeeded — fill any missing fields via heuristics.
      const used = new Set(Object.values(fromHeaders).flat());

      if (!fromHeaders.title) {
        fromHeaders.title = bestColumn(body, letters.filter((l) => !used.has(l)),
          (v) => CREDIT_RE.test(v), 0.1)
          || bestColumn(body, letters.filter((l) => !used.has(l)),
            (v) => /[A-Za-zÀ-ÿĞğİıÖöŞşÜüÇç]{4,}/.test(v), 0.5);
        if (fromHeaders.title) used.add(fromHeaders.title);
      }

      if (!fromHeaders.quota) {
        fromHeaders.quota = bestColumn(body, letters.filter((l) => !used.has(l)),
          (v) => QUOTA_RE.test(v), 0.5) || null;
        if (fromHeaders.quota) used.add(fromHeaders.quota);
      }

      // If campus wasn't in headers, fall back to heuristic.
      if (!fromHeaders.campus) {
        for (const letter of letters.filter((l) => !used.has(l))) {
          const values = body.map((r) => r[letter]).filter(Boolean);
          const distinct = new Set(values);
          if (values.length > body.length * 0.5 && distinct.size >= 2 && distinct.size <= 12) {
            fromHeaders.campus = letter;
            used.add(letter);
            break;
          }
        }
      }

      return {
        code:  fromHeaders.code,
        title: fromHeaders.title || null,
        slots: fromHeaders.slots,
        quota: fromHeaders.quota || null,
        hours: fromHeaders.hours || null,
        campus: fromHeaders.campus || null,
        instructorParts: fromHeaders.instructorParts,
        akts: fromHeaders.akts || null,
      };
    }

    // --- Fallback: purely heuristic detection (original logic) ---
    const code = bestColumn(body, letters, (v) => parseCode(v) !== null, 0.5);
    if (!code) {
      const err = new Error(
        'Ders kodu sütunu bulunamadı. "COMP1111.1" veya "COMP1111-L.1" gibi değerler bekleniyordu.');
      err.code = 'NO_CODE_COLUMN';
      throw err;
    }

    const slots = bestColumn(body, letters.filter((l) => l !== code), (v) => {
      const parsed = parseSlots(v);
      return !parsed.truncated && parsed.slots.length > 0;
    }, 0.3);
    if (!slots) {
      const err = new Error(
        'Ders saati sütunu bulunamadı. "T2T3T4" veya "Th2Th3" gibi değerler bekleniyordu.');
      err.code = 'NO_SLOTS_COLUMN';
      throw err;
    }

    const used = [code, slots];
    const rest = letters.filter((l) => !used.includes(l));

    const title = bestColumn(body, rest, (v) => CREDIT_RE.test(v), 0.1)
      || bestColumn(body, rest, (v) => /[A-Za-zÀ-ÿĞğİıÖöŞşÜüÇç]{4,}/.test(v), 0.5);
    if (!title) {
      const err = new Error('Ders adı sütunu bulunamadı.');
      err.code = 'NO_TITLE_COLUMN';
      throw err;
    }
    used.push(title);

    const quota = bestColumn(body, letters.filter((l) => !used.includes(l)),
      (v) => QUOTA_RE.test(v), 0.5);
    if (quota) used.push(quota);

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

    const akts = hours && integerColumns.length > 1 ? integerColumns[1].letter : null;
    if (akts) used.push(akts);

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

    const instructorParts = letters
      .filter((l) => !used.includes(l))
      .filter((l) => matchRate(body, l, (v) => /^[A-ZÀ-ÿĞİÖŞÜÇ][A-Za-zÀ-ÿĞğİıÖöŞşÜüÇç .'-]*$/.test(v)) > 0.6)
      .slice(0, 2);

    return {
      code, title, slots, quota: quota || null, hours,
      campus: campus || null, instructorParts, akts,
    };
  }

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
      // Truncated *and* non-empty: a blank cell is an unscheduled section, which
      // is a different (and unremarkable) thing from a cut-off one.
      const unreadableSlots = slotInfo.truncated && rawSlots !== '';

      if (unreadableSlots) {
        warnings.push({
          code: String(rawCode).trim(),
          warningCode: 'TRUNCATED_SLOTS',
          reason: 'Ders saatleri tam okunamadı ("' + rawSlots + '") — planlamaya dahil edilmedi.',
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
        truncated: unreadableSlots,
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

      const cleanTitle = title.replace(CREDIT_RE, '').trim();
      if (cleanTitle && (!course.title || parsed.kind === 'LEC')) {
        course.title = cleanTitle;
      }
      if (parsed.kind === 'LEC' && section.credit > 0) {
        course.credit = section.credit;
      }
      if (section.akts && !course.akts) {
        course.akts = section.akts;
      }
    }

    const courses = [...byBase.values()].sort((a, b) => a.base.localeCompare(b.base, 'tr'));
    return { courses, warnings };
  }

  return { DAYS, MAX_HOUR, parseCode, parseSlots, parseCredit, detectColumns, slotsToMask, buildCourses };
});
