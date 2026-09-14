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

  const DEFAULT_PREFS = Object.freeze({
    freeDays: Object.freeze(['F']),
    freeDayWeight: 200,
    compactness: 0.5,
    maxGap: null,
    avoidSingleCourseDays: true,
    singleCourseDayPenalty: 100,
  });

  // Always clone from this rather than DEFAULT_PREFS directly: DEFAULT_PREFS is
  // frozen (including its freeDays array), so any caller that mutates a naive
  // Object.assign({}, DEFAULT_PREFS) copy would be mutating the SAME freeDays
  // array as the frozen defaults, corrupting every future read of them.
  function defaultPrefs() {
    return Object.assign({}, DEFAULT_PREFS, { freeDays: DEFAULT_PREFS.freeDays.slice() });
  }

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
        breakdown.push({
          code: 'FREE_DAY', label: dayCode + ' günü boş', points: settings.freeDayWeight,
        });
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
      breakdown.push({ code: 'GAP_HOURS', label: totalGapHours + ' saat boşluk', points });
    }

    if (settings.avoidSingleCourseDays) {
      let lonelyDays = 0;
      for (let day = 0; day < DAYS.length; day++) {
        if (perDayBases[day].size === 1) lonelyDays++;
      }
      if (lonelyDays > 0) {
        const points = -lonelyDays * settings.singleCourseDayPenalty;
        score += points;
        breakdown.push({
          code: 'SINGLE_COURSE_DAYS', label: lonelyDays + ' gün tek derslik', points,
        });
      }
    }

    return { score, breakdown, rejected: false };
  }

  return { DEFAULT_PREFS, defaultPrefs, dayHours, scoreSchedule };
});
