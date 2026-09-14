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
      const err = new Error(
        'Bu tarayıcı .xlsx dosyalarını çevrimdışı okuyamıyor (DecompressionStream ' +
        'kullanılamıyor). Lütfen Chrome, Edge, Firefox veya Safari\'nin güncel bir ' +
        'sürümünü kullanın.');
      err.code = 'DECOMPRESSION_UNAVAILABLE';
      throw err;
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(bytes) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) {
      const err = new Error('Bu dosya bir .xlsx dosyasına benzemiyor (ZIP dizini bulunamadı).');
      err.code = 'NOT_A_ZIP';
      throw err;
    }

    const count = u16(bytes, eocd + 10);
    let off = u32(bytes, eocd + 16);
    const out = {};
    for (let k = 0; k < count; k++) {
      if (u32(bytes, off) !== 0x02014b50) {
        const err = new Error('Bu .xlsx dosyası bozuk görünüyor.');
        err.code = 'CORRUPT_ZIP';
        throw err;
      }
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
      else {
        const err = new Error(
          '.xlsx dosyasında desteklenmeyen bir sıkıştırma yöntemi var (yöntem ' + method + ').');
        err.code = 'UNSUPPORTED_COMPRESSION';
        throw err;
      }
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
      const err = new Error(
        'Bu dosyada çalışma sayfası bulunamadı (xl/worksheets/*.xml aranmıştı).');
      err.code = 'NO_WORKSHEET';
      throw err;
    }
    const shared = parseSharedStrings(decode('xl/sharedStrings.xml'));
    return { rows: parseSheetXml(decode(sheetPath), shared), sheetPath };
  }

  return { unzip, parseSharedStrings, parseSheetXml, readWorkbook };
});
