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
  // A course whose every section is dropped would otherwise vanish from the
  // timetable unannounced, so its base code is reported back in `skipped`.
  function buildGroups(courses) {
    const groups = [];
    const skipped = [];
    for (const course of courses) {
      let usable = 0;
      for (const kind of ['LEC', 'LAB', 'PS']) {
        const options = course.groups[kind].filter(
          (s) => !s.truncated && !s.unscheduled && s.slots.length > 0);
        if (options.length > 0) { groups.push({ base: course.base, kind, options }); usable++; }
      }
      if (usable === 0) skipped.push(course.base);
    }
    // Fewest options first: conflicts surface early and prune more.
    groups.sort((a, b) => a.options.length - b.options.length);
    return { groups, skipped };
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
    const { groups, skipped } = buildGroups(courses);
    // Retained results are compacted back to `limit` whenever they exceed this,
    // so peak memory is a small constant multiple of the requested result count
    // no matter how many leaves the search visits.
    const COMPACT_AT = Math.max(opts.limit * 4, 1);

    const occupancy = new Uint16Array(DAYS.length);
    const owner = new Int16Array(DAYS.length * (MAX_HOUR + 1)).fill(-1);
    const chosen = [];
    const pairHours = new Map();

    const bySignature = new Map();
    const results = [];
    let explored = 0;
    let considered = 0;
    let truncated = false;
    // Worst rawScore currently retained. Only meaningful once `results` holds at
    // least `limit` entries; until then nothing can be ruled out.
    let floor = -Infinity;

    function overlapTotal() {
      let total = 0;
      for (const hours of pairHours.values()) total += hours;
      return total;
    }

    // Madde 18/2 counts COURSES, not groups. Keying the pair on the group depth
    // would let a lecture "legally" overlap its own lab (two different depths,
    // one course), so the key is built from the base course codes instead.
    function pairKey(a, b) {
      return a < b ? a + '|' + b : b + '|' + a;
    }

    // Returns the list of (day, hour, previousOwner) triples this section collides
    // with, or null when the collision is not permissible.
    function collisionsFor(section) {
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
        const previousBase = chosen[previous].base;
        // A course can never overlap itself: no allowance covers a student being
        // in their own lecture and their own lab at the same hour.
        if (previousBase === section.base) return null;
        const key = pairKey(previousBase, section.base);
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
        const key = pairKey(chosen[previous].base, section.base);
        pairHours.set(key, (pairHours.get(key) || 0) + 1);
      }
    }

    function restore(savedMask, savedOwner, savedPairs) {
      occupancy.set(savedMask);
      owner.set(savedOwner);
      pairHours.clear();
      for (const [key, value] of savedPairs) pairHours.set(key, value);
    }

    const rank = (a, b) => (b.rawScore - a.rawScore) || (a.overlapHours - b.overlapHours);

    function worstRetained() {
      let min = Infinity;
      for (const entry of results) if (entry.rawScore < min) min = entry.rawScore;
      return min;
    }

    // Throw away everything that provably cannot reach the top `limit`, then
    // rebuild the signature index from the survivors so it cannot outgrow them.
    function compact() {
      results.sort(rank);
      results.length = Math.min(results.length, opts.limit);
      bySignature.clear();
      for (const entry of results) bySignature.set(entry.signature, entry);
      floor = worstRetained();
    }

    function record() {
      considered++;
      const evaluation = Scoring.scoreSchedule(chosen, prefs);
      if (evaluation.rejected) return;

      const signature = signatureOf(chosen);
      const existing = bySignature.get(signature);
      if (existing) {
        // Same timetable, different section numbers: keep it as an alternative.
        // This runs even below the floor — a known timetable that is already
        // retained must still be able to collect its interchangeable sections.
        const codes = existing.sections.map((s) => s.code).join(',');
        const candidate = chosen.map((s) => s.code).join(',');
        if (codes !== candidate && existing.alternates.length < 20) {
          existing.alternates.push(chosen.map((s) => s.code));
        }
        return;
      }

      // Once `limit` results are held, a strictly worse score is ranked behind
      // all of them and can never make the final cut, so it is never retained.
      // Equal scores are kept: they may still win on the overlap tie-break.
      if (results.length >= opts.limit && evaluation.score < floor) return;

      const entry = {
        sections: chosen.slice(),
        signature,
        rawScore: evaluation.score,
        score: evaluation.score,
        breakdown: evaluation.breakdown,
        overlapHours: overlapTotal(),
        alternates: [],
      };
      bySignature.set(signature, entry);
      results.push(entry);

      if (results.length > COMPACT_AT) compact();
      else if (results.length >= opts.limit) floor = worstRetained();
    }

    function search(depth) {
      if (truncated) return;
      if (depth === groups.length) { record(); return; }

      for (const section of groups[depth].options) {
        if (++explored > opts.nodeCap) { truncated = true; return; }

        const hits = collisionsFor(section);
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
    results.sort(rank);
    // How many entries were still being held when the search ended. Bounded by
    // COMPACT_AT no matter how many leaves were visited; reported so the memory
    // guarantee is observable (and testable) rather than merely intended.
    const retained = results.length;
    const top = results.slice(0, opts.limit);

    const best = top.length ? top[0].rawScore : 0;
    const worst = top.length ? top[top.length - 1].rawScore : 0;
    for (const entry of top) {
      entry.score = best === worst ? 100 : Math.round(((entry.rawScore - worst) / (best - worst)) * 100);
    }

    return { results: top, truncated, explored, considered, skipped, retained };
  }

  // A search wide enough to answer "is this satisfiable at all" without letting
  // the diagnosis itself become the slow part.
  const DIAGNOSE_NODE_CAP = 200000;

  const cellLabel = (slot) => DAYS[slot.day] + slot.hour;

  // Every hour where some section of `a` lands on some section of `b`. For a
  // pair that cannot co-exist, this is the set of hours the clash is made of.
  function clashingCells(a, b) {
    const groupsOf = (course) => ['LEC', 'LAB', 'PS']
      .map((kind) => course.groups[kind])
      .filter((options) => options.length > 0);
    const cells = new Map();
    for (const groupA of groupsOf(a)) {
      for (const sectionA of groupA) {
        for (const groupB of groupsOf(b)) {
          for (const sectionB of groupB) {
            for (const slotA of sectionA.slots) {
              for (const slotB of sectionB.slots) {
                if (slotA.day === slotB.day && slotA.hour === slotB.hour) {
                  cells.set(slotA.day * 100 + slotA.hour, cellLabel(slotA));
                }
              }
            }
          }
        }
      }
    }
    return [...cells.entries()].sort((x, y) => x[0] - y[0]).map((entry) => entry[1]);
  }

  // Why does this selection have no conflict-free arrangement? "No combination
  // found" names the symptom; this names the courses responsible.
  function diagnose(courses, prefs, options) {
    const opts = Object.assign({ nodeCap: DIAGNOSE_NODE_CAP, allowOverlap: false },
      options || {});
    // Every probe runs in the same mode as the search being explained, or the
    // diagnosis would blame a pair the user's own settings actually permit.
    const probe = { limit: 1, nodeCap: opts.nodeCap, allowOverlap: opts.allowOverlap };

    const full = solve(courses, prefs, probe);
    const skipped = full.skipped;
    const usable = courses.filter((course) => !skipped.includes(course.base));

    const report = {
      solvable: full.results.length > 0,
      truncated: full.truncated,
      skipped,
      blockingPairs: [],
      dropCandidates: [],
      higherOrder: false,
    };
    if (report.solvable) return report;

    // Two courses that cannot co-exist on their own can never co-exist inside a
    // larger selection either, so this is the sharpest thing we can say.
    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        if (solve([usable[i], usable[j]], prefs, probe).results.length === 0) {
          report.blockingPairs.push({
            bases: [usable[i].base, usable[j].base],
            cells: clashingCells(usable[i], usable[j]),
          });
        }
      }
    }

    // Which single course, removed, would let the rest fit? Skipped when the
    // first search already hit the cap: this costs one full search per course,
    // and compounding an already-slow case would freeze the page.
    if (!report.truncated && usable.length > 2) {
      for (let i = 0; i < usable.length; i++) {
        const rest = usable.filter((_, index) => index !== i);
        if (solve(rest, prefs, probe).results.length > 0) {
          report.dropCandidates.push(usable[i].base);
        }
      }
    }

    // No pair is impossible on its own, yet together they do not fit: the clash
    // only exists in combination, so no single pair can be blamed for it.
    report.higherOrder = report.blockingPairs.length === 0 && !report.truncated;
    return report;
  }

  return { solve, diagnose, MAX_OVERLAP_PAIRS, MAX_HOURS_PER_PAIR };
});
