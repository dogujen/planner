'use strict';
/**
 * Ics — bir program girdisini iCalendar (.ics) metnine çevirir.
 *
 * Slot n, uygulamanın saat kuralını izleyerek 8:30 + (n-1)*60'da başlar ve
 * 50 dakika sürer. Etkinlikler, options.start içeren haftanın Pazartesi'sinden
 * başlayarak tek haftalık üretilir (takvim uygulamalarına tek seferlik eklenir).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Ics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const START_HOUR_MIN = 8 * 60 + 30;   // 8:30
  const SLOT_MINUTES = 60;
  const DURATION_MIN = 50;

  const pad2 = (n) => String(n).padStart(2, '0');

  function fmtDate(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function fmtClock(minutesOfDay) {
    return pad2(Math.floor(minutesOfDay / 60)) + pad2(minutesOfDay % 60) + '00';
  }

  function utcStamp(d) {
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
      'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }

  // `date` içeren haftanın Pazartesi'si (yerel saat).
  function weekStart(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }

  function escapeIcs(text) {
    return String(text == null ? '' : text)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  const TRAILING_CREDIT = /\s*\(\d+\)\s*$/;

  // sections: Section[] (slot.day, CourseParser.DAYS indeksi: M=0 … Su=6).
  function buildIcs(sections, options) {
    const opts = Object.assign({ start: new Date() }, options || {});
    const start = weekStart(opts.start);
    const stamp = utcStamp(new Date());

    let out = 'BEGIN:VCALENDAR\r\n' +
      'VERSION:2.0\r\n' +
      'PRODID:-//Ders Planlay\u0131c\u0131//TR\r\n' +
      'CALSCALE:GREGORIAN\r\n' +
      'METHOD:PUBLISH\r\n' +
      'X-WR-CALNAME:Ders Program\u0131\r\n';

    for (const section of sections) {
      for (const slot of section.slots) {
        // weekStart Pazartesi'dir; slot.day 0..6, M..Su'yu birebir örter.
        const date = new Date(start);
        date.setDate(date.getDate() + slot.day);

        const startMin = START_HOUR_MIN + (slot.hour - 1) * SLOT_MINUTES;
        const endMin = startMin + DURATION_MIN;
        const title = section.title ? String(section.title).replace(TRAILING_CREDIT, '').trim() : '';
        const summary = escapeIcs(section.base + (title ? ' - ' + title : ''));
        const location = escapeIcs([section.campus, section.classroom].filter(Boolean).join(' '));
        const uid = [section.base, section.kind, section.sectionNo, slot.day, slot.hour].join('-');

        out += 'BEGIN:VEVENT\r\n' +
          'UID:' + uid + '@ders-planlayici\r\n' +
          'DTSTAMP:' + stamp + '\r\n' +
          'DTSTART:' + fmtDate(date) + 'T' + fmtClock(startMin) + '\r\n' +
          'DTEND:' + fmtDate(date) + 'T' + fmtClock(endMin) + '\r\n' +
          'SUMMARY:' + summary + '\r\n' +
          (location ? 'LOCATION:' + location + '\r\n' : '') +
          'END:VEVENT\r\n';
      }
    }

    return out + 'END:VCALENDAR\r\n';
  }

  return { buildIcs };
});