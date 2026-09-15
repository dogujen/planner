'use strict';
/**
 * PdfReader — Işık Üniversitesi e-Campus ders programı PDF'ini okur.
 *
 * Döndürülen { rows } formatı XlsxReader.readWorkbook() ile aynıdır:
 * rows[0] başlık satırı, rows[1..] veri satırlarıdır.
 * Her satır { ColumnLetter: string } map'idir.
 *
 * Sütun düzeni (PDF başlık satırından):
 *  A: E-Posta
 *  B: Ders Kodu
 *  C: Başlık
 *  D: Yerel Kredi
 *  E: AKTS Kredisi
 *  F: Kalan / Toplam Kota   (örn. "4 / 37")
 *  G: Kampüs
 *  H: Sınıf(lar)
 *  I: Eğitmen Adı
 *  J: Eğitmen Soyadı
 *  K: Asistan  (her zaman "STAFF")
 *  L: Ders Saati(leri)      (örn. "T7, T8, T9")
 *  M: Fakülte Adı
 *  N: Sınıf Saati Sayısı    (tam sayı)
 *  O: Live Section          (YES / NO)
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PdfReader = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // PDF.js 4.x – bundled via CDN (yüklenmemişse çalışmayı engeller)
  const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
  const WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

  let _pdfjsLib = null;

  async function loadPdfJs() {
    if (_pdfjsLib) return _pdfjsLib;
    const mod = await import(PDFJS_CDN);
    mod.GlobalWorkerOptions.workerSrc = WORKER_CDN;
    _pdfjsLib = mod;
    return _pdfjsLib;
  }

  // Satırı parçalara ayırır. PDF'te her bölüm boşlukla ayrılmış;
  // ancak başlık birden fazla kelimeden oluşabileceği için regex kullanılır.
  const CODE_RE  = /^[A-ZÀ-ÿĞİÖŞÜÇ][A-ZÀ-ÿĞİÖŞÜÇ\d]+\.[\d.]+$/;
  const SLOT_RE  = /^(Th|St|Su|M|T|W|F)\d{1,2},?$/;
  const EMAIL_RE = /^[a-z0-9_.+-]+@[a-z0-9-]+\.[a-z.]{2,}$/i;

  function parseLine(line) {
    const t = line.trim().split(/\s+/);
    if (t.length < 10) return null;

    // 0: e-posta
    if (!EMAIL_RE.test(t[0])) return null;
    const email = t[0];

    // 1: ders kodu
    const codeIdx = 1;
    if (!CODE_RE.test(t[codeIdx])) return null;
    const code = t[codeIdx];

    // STAFF konumunu bul
    const staffIdx = t.indexOf('STAFF', codeIdx + 2);
    if (staffIdx < 0) return null;

    // Başlığın sonundaki "(N)" kredi parantezini bul (başlıktan sonra gelir)
    let creditParenIdx = -1;
    for (let i = codeIdx + 1; i < staffIdx; i++) {
      if (/^\(\d+\)$/.test(t[i])) { creditParenIdx = i; break; }
    }
    if (creditParenIdx < 0) return null;

    const title = t.slice(codeIdx + 1, creditParenIdx + 1).join(' ');
    const localCredit = t[creditParenIdx + 1] || '';
    const akts        = t[creditParenIdx + 2] || '';
    const quotaLeft   = t[creditParenIdx + 3] || '';
    // t[creditParenIdx + 4] === '/'
    const quotaTotal  = t[creditParenIdx + 5] || '';
    const campus      = t[creditParenIdx + 6] || '';

    // Sınıf(lar) ve öğretim üyesi: kampüsten STAFF'e kadar
    // Sınıf kodları [A-Z]\d+ formatındadır; sonrasında instructor gelir.
    const afterCampus = t.slice(creditParenIdx + 7, staffIdx);
    let roomEnd = 0;
    while (roomEnd < afterCampus.length &&
           /^[A-Z]\d/.test(afterCampus[roomEnd].replace(/,$/, ''))) {
      roomEnd++;
    }
    const rooms      = afterCampus.slice(0, roomEnd).map(r => r.replace(/,$/, '')).join(', ');
    const instructor = afterCampus.slice(roomEnd).join(' ');

    // Saatler: STAFF'ten sonra gelen SLOT_RE tokenları
    let slotEnd = staffIdx + 1;
    while (slotEnd < t.length && SLOT_RE.test(t[slotEnd])) slotEnd++;
    const slots = t.slice(staffIdx + 1, slotEnd).map(s => s.replace(/,$/, '')).join(' ');

    // Kalan tokenlar: fakülte + sınıf_sayısı + YES/NO
    const trailing = t.slice(slotEnd);
    const yesNo    = trailing[trailing.length - 1]; // YES | NO
    const classHrs = trailing[trailing.length - 2]; // sayı
    // Fakülte = kalan
    const faculty = trailing.slice(0, trailing.length - 2).join(' ');

    return {
      A: email,
      B: code,
      C: title,
      D: localCredit,
      E: akts,
      F: `${quotaLeft} / ${quotaTotal}`,
      G: campus,
      H: rooms,
      I: instructor.split(' ').slice(0, -1).join(' '),    // ad (son kelime soyad)
      J: instructor.split(' ').slice(-1)[0] || '',        // soyad
      K: 'STAFF',
      L: slots,
      M: faculty,
      N: classHrs,
      O: yesNo,
    };
  }

  // Başlık satırı — CourseParser.detectColumns() için İngilizce header'lar kullanılır.
  // course-parser.js'deki HEADER_MATCHERS regex'lerini karşılar.
  const HEADER_ROW = {
    A: 'Email',
    B: 'Course Code',
    C: 'Title',
    D: 'Local Credit',
    E: 'ECTS Credit',
    F: 'Quota',
    G: 'Campus',
    H: 'Classroom(s)',
    I: 'Instructor Name',
    J: 'Instructor Surname',
    K: 'Assistant',
    L: 'Time Slot',
    M: 'Faculty Name',
    N: 'Course Hours',
    O: 'Live Section',
  };

  async function readPdf(bytes) {
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

    const allLines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();

      // Satırları y koordinatına göre grupla (aynı y = aynı satır)
      const byY = new Map();
      for (const item of content.items) {
        const y = Math.round(item.transform[5]);
        if (!byY.has(y)) byY.set(y, []);
        byY.get(y).push(item);
      }

      // y'ye göre büyükten küçüğe sırala (PDF koordinatları aşağı doğru artar ama origin alta)
      const sortedYs = [...byY.keys()].sort((a, b) => b - a);
      for (const y of sortedYs) {
        const items = byY.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
        const lineText = items.map(i => i.str).join(' ').trim();
        if (lineText) allLines.push(lineText);
      }
    }

    // İlk satır başlık satırı (içinde "Ders Kodu" veya "Course Code" var)
    // Onu atlayıp verileri parse ediyoruz.
    const rows = [HEADER_ROW];
    for (const line of allLines) {
      // Başlık satırını atla
      if (/ders\s*kodu/i.test(line) || /course\s*code/i.test(line)) continue;
      const parsed = parseLine(line);
      if (parsed) rows.push(parsed);
    }

    if (rows.length <= 1) {
      const err = new Error(
        'PDF içinde hiç ders satırı bulunamadı. Işık Üniversitesi e-Campus ders programı PDF\'i olduğundan emin olun.');
      err.code = 'NO_ROWS_IN_PDF';
      throw err;
    }

    return { rows };
  }

  return { readPdf };
});
