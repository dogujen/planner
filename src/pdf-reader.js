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
  const SLOT_RE  = /^(Th|St|Su|M|T|W|F)\d{1,2},?$/;
  const EMAIL_RE = /^[a-z0-9_.+-]+@[a-z0-9-]+\.[a-z.]{2,}$/i;

  function parseLine(lineStr) {
    lineStr = lineStr.trim();
    if (!lineStr || /ders\s*kodu/i.test(lineStr) || /course\s*code/i.test(lineStr)) return null;

    // 1. E-posta (opsiyonel)
    let email = '';
    let rest = lineStr;
    const firstWord = rest.split(/\s+/)[0] || '';
    if (EMAIL_RE.test(firstWord)) {
      email = firstWord;
      rest = rest.slice(email.length).trim();
    }

    // 2. Ders Kodu (örn. AHİZ1111.1, ARCH1102-L.1, BMED2411-PS.1, HUSS1003 .1)
    const codeMatch = rest.match(/^([A-ZÀ-ÿĞİÖŞÜÇ][A-ZÀ-ÿĞİÖŞÜÇ\d\.\-]+\s*\.\s*\d+(?:\.\d+)?)/i);
    if (!codeMatch) return null;

    const rawCode = codeMatch[1];
    const code = rawCode.replace(/\s+/g, ''); // "HUSS1003 .1" -> "HUSS1003.1"
    rest = rest.slice(rawCode.length).trim();

    // 3. Kota bulma: "X / Y" veya "-7 / 40" formatında
    const quotaMatch = rest.match(/(-?\d+)\s*\/\s*(\d+)/);
    if (!quotaMatch) return null;

    const quotaLeft = quotaMatch[1];
    const quotaTotal = quotaMatch[2];
    const quotaStart = quotaMatch.index;
    const quotaEnd = quotaStart + quotaMatch[0].length;

    // Kotadan önceki metin: Başlık + Yerel Kredi + AKTS Kredisi
    const beforeQuota = rest.slice(0, quotaStart).trim();
    const afterQuota = rest.slice(quotaEnd).trim();

    // Kotadan hemen önceki 2 sayıyı (Yerel Kredi, AKTS) çek
    let title = beforeQuota;
    let localCredit = '0';
    let akts = '0';

    const creditsMatch = beforeQuota.match(/\s+(\d+)\s+(\d+)$/);
    if (creditsMatch) {
      localCredit = creditsMatch[1];
      akts = creditsMatch[2];
      title = beforeQuota.slice(0, creditsMatch.index).trim();
    } else {
      const bTokens = beforeQuota.split(/\s+/);
      if (bTokens.length >= 2) {
        akts = bTokens.pop();
        localCredit = bTokens.pop();
        title = bTokens.join(' ');
      }
    }

    // 4. Kotadan sonraki metin: Kampüs + Sınıflar + Eğitmen + STAFF + Ders Saatleri + Fakülte + ...
    const tAfter = afterQuota.split(/\s+/);
    const staffIndices = [];
    tAfter.forEach((tok, i) => { if (tok === 'STAFF') staffIndices.push(i); });
    if (staffIndices.length === 0) return null;

    const campus = tAfter[0] || '';
    const middle = tAfter.slice(1, staffIndices[0]);

    // Sınıflar ve Eğitmen adını ayır
    const roomTokens = [];
    const instTokens = [];
    for (const tok of middle) {
      const tokClean = tok.replace(/,$/, '');
      if (/^[A-Z]\d/i.test(tokClean) || /^(Online|null|OFFICE)$/i.test(tokClean)) {
        roomTokens.push(tokClean);
      } else {
        instTokens.push(tok);
      }
    }
    const rooms = roomTokens.join(', ');
    const instructor = instTokens.join(' ');
    const instParts = instructor.split(/\s+/).filter(Boolean);
    const instFirstName = instParts.slice(0, -1).join(' ');
    const instLastName = instParts.slice(-1)[0] || '';

    // Ders Saatleri (STAFF sonrasındaki slot'lar)
    const lastStaff = staffIndices[staffIndices.length - 1];
    const slotTokens = [];
    let idx = lastStaff + 1;
    while (idx < tAfter.length && SLOT_RE.test(tAfter[idx])) {
      slotTokens.push(tAfter[idx].replace(/,$/, ''));
      idx++;
    }
    const slots = slotTokens.join(' ');

    const trailing = tAfter.slice(idx);
    const yesNo = trailing.length ? trailing[trailing.length - 1] : '';
    const classHrs = trailing.length >= 2 ? trailing[trailing.length - 2] : '';
    const faculty = trailing.length >= 2 ? trailing.slice(0, -2).join(' ') : '';

    return {
      A: email,
      B: code,
      C: title,
      D: localCredit,
      E: akts,
      F: `${quotaLeft} / ${quotaTotal}`,
      G: campus,
      H: rooms,
      I: instFirstName,
      J: instLastName,
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
