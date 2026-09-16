'use strict';
/**
 * ScheduleReader — e-Campus API'sinden gelen JSON `schedule` dizisini,
 * CourseParser'ın anladığı `rows` formatına çevirir.
 *
 * Döndürülen { rows } formatı XlsxReader.readWorkbook() / PdfReader.readPdf()
 * ile aynıdır: rows[0] başlık satırı, rows[1..] veri satırlarıdır.
 * Her satır { ColumnLetter: string } map'idir. Başlık satırı, course-parser'ın
 * HEADER_MATCHERS eşleşmeleriyle birebir çakışacak İngilizce başlıklar taşır,
 * böylece detectColumns istatistiksel tahmine hiç girmeden sütunları net bulur.
 *
 * API elemanı:
 *   { code, title, credit, akts, instructor, campus, classroom, time_slot }
 *   örn. time_slot: " T7, T8, T9", klasör: " A413 A320, ..."
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ScheduleReader = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HEADER_ROW = {
    A: 'Email', B: 'Course Code', C: 'Title', D: 'Local Credit',
    E: 'ECTS Credit', F: 'Quota', G: 'Campus', H: 'Classroom(s)',
    I: 'Instructor Name', J: 'Instructor Surname', K: 'Assistant',
    L: 'Time Slot', M: 'Faculty Name', N: 'Course Hours', O: 'Live Section',
  };

  const SLOT_TOKENS = /(?:Th|St|Su|M|T|W|F)\d{1,2}/g;
  const trim = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  // API başlığında kredi parantezi yoktur; buildCourses krediyi başlık
  // sonundaki "(n)"'den okur, bu yüzden kredi burada başlığa eklenir.
  function titleWithCredit(title, credit) {
    const c = String(credit == null ? '' : credit).trim();
    if (/^\d+$/.test(c) && Number(c) > 0) return title + ' (' + c + ')';
    return title;
  }

  function rowsFromSchedule(schedule) {
    const rows = [HEADER_ROW];
    for (const item of schedule || []) {
      const rawCode = trim(item.code);
      if (!rawCode) continue;

      const title = trim(item.title);
      const slots = trim(item.time_slot);
      const instructor = trim(item.instructor);
      const parts = instructor.split(/\s+/).filter(Boolean);
      const lastName = parts.length > 1 ? parts[parts.length - 1] : '';
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : instructor;
      const className = trim(item.classroom);
      const classHours = String((slots.match(SLOT_TOKENS) || []).length);

      rows.push({
        A: '', B: rawCode, C: titleWithCredit(title, item.credit),
        D: trim(item.credit), E: trim(item.akts), F: '',
        G: trim(item.campus), H: className,
        I: firstName, J: lastName, K: 'STAFF',
        L: slots, M: '', N: classHours, O: '',
      });
    }
    return { rows };
  }

  return { rowsFromSchedule };
});