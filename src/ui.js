'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  // Grades that mean the student must/can retake the course (not fully passed)
  const FAILED_GRADES     = ['FF', 'FD', 'F', 'NA'];
  const RETAKEABLE_GRADES = ['DD', 'DC']; // conditional pass, can retake to improve GPA

  const state = {
    courses: [], warnings: [], selected: new Set(), prefs: null, akts: false,
    // Controls that are not scoring preferences but still worth remembering.
    ui: { overlap: false, gno: '0' },
    // Map<base, Set<code>>: user-preferred sections per course (key = full section code).
    preferredSections: new Map(),
    // Map<base, Set<code>>: user-locked sections — solver ONLY picks from these.
    lockedSections: new Map(),
    // Map<base, Set<code>>: user-blocked sections — solver EXCLUDES these.
    blockedSections: new Map(),

    // e-Campus User session
    user: {
      loggedIn: false,
      gpa: null,
      totalAkts: null,
      passedCourses: new Map(), // Map<courseBase, gradeString>
      studentAktsMap: new Map(), // Map<courseBase, aktsNumber>
      allowedCourses: new Set(), // Set<courseBaseOrNorm>
      donemler: {},        // raw donemler from API
      offeredCourses: {}, // raw offered_courses from API
    }
  };

  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // Spreadsheet-derived text (course codes, titles, instructor names, etc.) is
  // attacker-controlled: escape it before it is interpolated into innerHTML.
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
  }

  function showError(message) {
    $('error').textContent = message;
    $('error').classList.remove('hidden');
  }

  // Diacritic-insensitive so 'ısı' matches 'İSİ'.
  const fold = (s) => (s || '').toLocaleLowerCase('tr')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ş/g, 's')
    .replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ç/g, 'c');

  // Everything derived from the previously loaded file. Without this a second
  // load would leave the first file's schedules, status line and selection on
  // screen while the chip list showed the new file's courses.
  function resetForNewFile() {
    $('error').classList.add('hidden');
    $('results').innerHTML = '';
    $('status').textContent = '';
    $('search').value = '';
    $('tip').style.display = 'none';
    state.courses = [];
    state.warnings = [];
    state.selected = new Set();
    state.preferredSections = new Map();
    state.lockedSections = new Map();
    state.blockedSections = new Map();
  }

  // Spec §9.1: the drop zone is replaced by a compact summary, not removed —
  // removing it would make loading a second file impossible without a reload.
  function togglePreset(show) {
    const button = $('preset');
    if (button) button.classList.toggle('hidden', !show);
  }

  function renderFileSummary(name) {
    togglePreset(false);
    $('drop').classList.add('loaded');
    $('dropinner').innerHTML =
      '<strong>' + escapeHtml(name) + '</strong>' +
      '<span class="sub">' + state.courses.length + ' ders · ' +
      state.warnings.length + ' uyarı</span>' +
      '<button id="rechoose" type="button">Başka dosya seç</button>';
  }

  function applyPrefsToControls() {
    $('fdw').value = state.prefs.freeDayWeight;
    $('fdwOut').textContent = state.prefs.freeDayWeight;
    $('cmp').value = state.prefs.compactness;
    $('cmpOut').textContent = state.prefs.compactness;
    // Without this line a restored maxGap is lost the moment the user solves:
    // readPrefs() would read the still-empty #maxgap and write back null.
    $('maxgap').value = state.prefs.maxGap == null ? '' : state.prefs.maxGap;
    $('single').checked = state.prefs.avoidSingleCourseDays;
    $('overlap').checked = state.ui.overlap;
    const gno = $('gno');
    if ([...gno.options].some((option) => option.value === state.ui.gno)) gno.value = state.ui.gno;
  }

  async function loadFile(file) {
    const name = file.name;
    const isPdf = name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      await loadBytes(new Uint8Array(await file.arrayBuffer()), name, true);
    } else {
      await loadBytes(new Uint8Array(await file.arrayBuffer()), name, false);
    }
  }

  // The single load path. The file picker and the built-in schedule button both
  // arrive here, so neither can drift away from the other's behaviour.
  // isPdf flag selects the reader; defaults to XLSX.
  async function loadBytes(bytes, name, isPdf = false) {
    resetForNewFile();
    try {
      const { rows } = isPdf
        ? await PdfReader.readPdf(bytes)
        : await XlsxReader.readWorkbook(bytes);
      const cols = CourseParser.detectColumns(rows);
      const built = CourseParser.buildCourses(rows, cols);
      state.courses = built.courses;
      state.warnings = built.warnings;
      state.akts = Boolean(cols.akts);
      state.prefs = Scoring.defaultPrefs();
      applyStudentAktsOverwrites();
      restore();
      loadFromUrl();   // apply ?alınanders= param if present
      renderFileSummary(name);
      $('app').classList.remove('hidden');
      renderWarnings();
      renderChips();
      renderTray();
      applyPrefsToControls();
      renderSummary();
      renderFreeDays();
    } catch (err) {
      showError(err.message || String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // URL paylaşımı: ?alınanders=BASE1,BASE2.sectionPref
  // ---------------------------------------------------------------------------
  function buildShareUrl() {
    const parts = [];
    for (const base of state.selected) {
      const prefs = state.preferredSections.get(base);
      const prefList = prefs && prefs.size > 0 ? [...prefs] : [];
      if (prefList.length > 0) {
        parts.push(base + '.' + prefList[0]);
      } else {
        parts.push(base);
      }
    }
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('alınanders', parts.join(','));
    return url.toString();
  }

  function loadFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('alınanders') || params.get('al%C4%B1nanders') || '';
      if (!raw) return;
      for (const token of raw.split(',')) {
        const trimmed = token.trim();
        if (!trimmed) continue;
        // Format: BASE or BASE.sectionNo
        const dotIdx = trimmed.lastIndexOf('.');
        const hasSection = dotIdx > 0 && /^\d+$/.test(trimmed.slice(dotIdx + 1));
        const base = hasSection ? trimmed.slice(0, dotIdx) : trimmed;
        const sectionNo = hasSection ? trimmed.slice(dotIdx + 1) : null;
        const course = state.courses.find((c) => c.base.toUpperCase() === base.toUpperCase());
        if (!course) continue;
        state.selected.add(course.base);
        if (sectionNo) {
          const set = state.preferredSections.get(course.base) || new Set();
          set.add(sectionNo);
          state.preferredSections.set(course.base, set);
        }
      }
    } catch (e) { /* malformed URL — ignore */ }
  }

  function renderWarnings() {
    const box = $('warnings');
    if (box) box.classList.add('hidden');
    if (state.warnings.length > 0) {
      console.warn('[e-Campus Planlayıcı] ' + state.warnings.length + ' ders şubesi tam okunamadı ve planlamaya dahil edilmedi:', state.warnings);
    }
  }

  function aktsOrCredit(course) {
    if (course.akts != null && course.akts > 0) return course.akts + ' AKTS';
    if (course.credit > 0) return course.credit + ' Kredi';
    return '—';
  }

  function chipLabel(course) {
    const hasLab = course.groups.LAB && course.groups.LAB.length > 0;
    const hasPs  = course.groups.PS  && course.groups.PS.length > 0;
    let badges = '';
    if (hasLab) badges += ' <span class="kind-badge lab-badge">LAB</span>';
    if (hasPs)  badges += ' <span class="kind-badge ps-badge">PS</span>';

    const grade = getPassedGrade(course.base);
    const isRetakeable = grade && RETAKEABLE_GRADES.includes(grade.toUpperCase());
    const gradeBadge = grade
      ? ' <span class="grade-badge' + (isRetakeable ? ' grade-badge-retake' : '') + '" title="' + (isRetakeable ? 'Tekrar al\u0131nabilir' : 'Ge\u00e7ti\u011finiz Not') + '">' + escapeHtml(grade) + '</span>'
      : '';

    const head = '<span class="chip-head"><strong>' + escapeHtml(course.base) + '</strong>' +
      gradeBadge +
      badges +
      '<span class="cr"> · ' + escapeHtml(aktsOrCredit(course)) + '</span></span>';
    const title = course.title
      ? '<span class="chip-title">' + escapeHtml(course.title) + '</span>'
      : '';
    return head + title;
  }

  function renderChips() {
    $('tip').style.display = 'none';
    const query = fold($('search').value.trim());
    const matches = state.courses.filter((course) => {
      if (state.user.loggedIn && !isCurriculumCourse(course.base)) {
        return false;
      }
      const allInst = [
        ...(course.groups.LEC || []),
        ...(course.groups.LAB || []),
        ...(course.groups.PS  || []),
      ].map((s) => s.instructor).join(' ');
      const aktsVal = course.akts != null && course.akts > 0 ? course.akts : (course.credit > 0 ? course.credit : null);
      const aktsText = aktsVal != null ? `${aktsVal} akts ${aktsVal}akts ${aktsVal} ects ${aktsVal}ects ${aktsVal} kredi ${aktsVal}kredi ${aktsVal} cr` : '';
      const hay = fold(course.base + ' ' + course.title + ' ' + allInst + ' ' + aktsText);
      return hay.includes(query);
    });

    // Separate available (unpassed) courses vs passed courses so available courses appear first
    const available = [];
    const passed = [];
    for (const course of matches) {
      if (isPassedCourse(course.base)) {
        passed.push(course);
      } else {
        available.push(course);
      }
    }
    const sortedMatches = [...available, ...passed];

    const box = $('chips');
    box.innerHTML = '';
    for (const course of sortedMatches.slice(0, 400)) {
      const isPassed = isPassedCourse(course.base);
      const label = document.createElement('label');
      label.className = 'chip' + (isPassed ? ' passed-chip' : '');
      label.dataset.base = course.base;

      const input = document.createElement('input');
      input.type = 'checkbox';
      if (isPassed) {
        input.disabled = true;
        input.checked = false;
        state.selected.delete(course.base);
      } else {
        // includes both untaken AND retakeable (DD/DC) courses
        input.checked = state.selected.has(course.base);
        input.addEventListener('change', () => {
          if (input.checked) state.selected.add(course.base);
          else state.selected.delete(course.base);
          persist();
          renderTray();
          renderSummary();
        });
      }

      const span = document.createElement('span');
      span.innerHTML = chipLabel(course);
      label.appendChild(input);
      label.appendChild(span);
      box.appendChild(label);
    }
    if (sortedMatches.length === 0) {
      box.innerHTML = '<p class="sub">Eşleşen ders yok.</p>';
    } else if (sortedMatches.length > 400) {
      const note = document.createElement('p');
      note.className = 'sub';
      note.textContent = sortedMatches.length + ' dersten ilk 400 tanesi gösteriliyor — aramayı daraltın.';
      box.appendChild(note);
    }
  }

  function deselect(base) {
    state.selected.delete(base);
    persist();
    // The chip for this course may be filtered out of view, so re-render the
    // whole list rather than trying to untick one specific checkbox.
    renderChips();
    renderTray();
    renderSummary();
  }

  // Spec §9.5. The chip list is capped at 400 entries and filtered by the search
  // box, so without this tray a selected course can scroll out of existence and
  // become impossible to remove.
  function renderTray() {
    const box = $('tray');
    box.innerHTML = '';
    const chosen = state.courses.filter((c) => state.selected.has(c.base));
    if (chosen.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'sub';
      empty.textContent = 'Henüz ders seçmedin.';
      box.appendChild(empty);
      return;
    }

    const head = document.createElement('span');
    head.className = 'sub';
    head.style.width = '100%';
    head.textContent = 'Seçilen dersler (' + chosen.length + '):';
    box.appendChild(head);

    for (const course of chosen) {
      const preferred = state.preferredSections.get(course.base);
      const locked    = state.lockedSections.get(course.base);
      const blocked   = state.blockedSections.get(course.base);
      const hasPref   = preferred && preferred.size > 0;
      const hasLock   = locked    && locked.size > 0;
      const hasBlock  = blocked   && blocked.size > 0;

      let statusBadge = '';
      if (hasLock) statusBadge += ' 🔒';
      if (hasBlock) statusBadge += ' 🚫';
      if (hasPref) statusBadge += ' ★';

      const pick = document.createElement('div');
      pick.className = 'pick' + (hasLock ? ' pick-locked' : '') + (hasBlock ? ' pick-blocked' : '');
      pick.dataset.base = course.base;
      pick.tabIndex = 0;

      const info = document.createElement('div');
      info.className = 'pick-info';

      const codeLine = document.createElement('div');
      codeLine.className = 'pick-code';
      codeLine.textContent = course.base + ' ';

      if (statusBadge) {
        const badgeSpan = document.createElement('span');
        badgeSpan.className = 'pick-badge';
        badgeSpan.textContent = statusBadge;
        codeLine.appendChild(badgeSpan);
      }

      const aktsSpan = document.createElement('span');
      aktsSpan.className = 'pick-akts';
      aktsSpan.textContent = '· ' + aktsOrCredit(course);
      codeLine.appendChild(aktsSpan);
      info.appendChild(codeLine);

      if (course.title) {
        const titleLine = document.createElement('div');
        titleLine.className = 'pick-title';
        titleLine.textContent = course.title;
        titleLine.title = course.title;
        info.appendChild(titleLine);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Çıkar';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        deselect(course.base);
      });

      pick.appendChild(info);
      pick.appendChild(remove);
      box.appendChild(pick);
    }
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Section preference & lock tooltip
  // preferredSections and lockedSections use full section code (s.code) as key.
  // ---------------------------------------------------------------------------

  function getPreferred(base) {
    if (!state.preferredSections.has(base)) state.preferredSections.set(base, new Set());
    return state.preferredSections.get(base);
  }

  function getLocked(base) {
    if (!state.lockedSections.has(base)) state.lockedSections.set(base, new Set());
    return state.lockedSections.get(base);
  }

  function getBlocked(base) {
    if (!state.blockedSections.has(base)) state.blockedSections.set(base, new Set());
    return state.blockedSections.get(base);
  }

  function togglePreference(base, code) {
    const set = getPreferred(base);
    if (set.has(code)) set.delete(code);
    else {
      set.add(code);
      getBlocked(base).delete(code);
    }
    persist();
  }

  function toggleLock(base, code) {
    const set = getLocked(base);
    if (set.has(code)) set.delete(code);
    else {
      set.add(code);
      getBlocked(base).delete(code);
    }
    persist();
  }

  function toggleBlock(base, code) {
    const set = getBlocked(base);
    if (set.has(code)) set.delete(code);
    else {
      set.add(code);
      getPreferred(base).delete(code);
      getLocked(base).delete(code);
    }
    persist();
  }

  const KIND_LABEL = { LEC: 'Ders', LAB: 'Lab', PS: 'Problem Seansı' };

  function buildTooltipContent(course) {
    const preferred = getPreferred(course.base);
    const locked    = getLocked(course.base);
    const blocked   = getBlocked(course.base);

    const dayNames = { M: 'Pzt', T: 'Sal', W: 'Çar', Th: 'Per', F: 'Cum', St: 'Cmt', Su: 'Paz' };
    const slotStr = (s) => s.slots.map((sl) => (dayNames[CourseParser.DAYS[sl.day]] || CourseParser.DAYS[sl.day]) + sl.hour).join(' ');

    // Group by kind so LEC/PS/LAB sections are displayed separately.
    const groups = [
      { kind: 'LEC', sections: course.groups.LEC },
      { kind: 'LAB', sections: course.groups.LAB },
      { kind: 'PS',  sections: course.groups.PS  },
    ].filter((g) => g.sections.length > 0);

    let sectionRows = '';
    for (const { kind, sections } of groups) {
      if (groups.length > 1) {
        sectionRows += '<div class="tip-kind-label">' + escapeHtml(KIND_LABEL[kind] || kind) + '</div>';
      }
      for (const s of sections) {
        const isPref    = preferred.has(s.code);
        const isLocked  = locked.has(s.code);
        const isBlocked = blocked.has(s.code);
        const star      = isPref   ? '★' : '☆';
        const lockIcon  = isLocked ? '🔒' : '🔓';
        const blockIcon = '🚫';
        const slots = slotStr(s);
        const rowClass = 'tip-row' +
          (isPref ? ' tip-pref' : '') +
          (isLocked ? ' tip-locked' : '') +
          (isBlocked ? ' tip-blocked' : '');
        sectionRows +=
          '<div class="' + rowClass + '" data-base="' + escapeHtml(course.base) +
          '" data-code="' + escapeHtml(s.code) + '">' +
          '<span class="tip-star" data-action="star" title="Bu şubeyi öne çıkar">' + star + '</span>' +
          '<span class="tip-lock" data-action="lock" title="Bu şubeyi zorunlu kıl">' + lockIcon + '</span>' +
          '<span class="tip-block" data-action="block" title="Bu hocayı/şubeyi engelle">' + blockIcon + '</span>' +
          '<span class="tip-code">' + escapeHtml(s.sectionNo) + '</span>' +
          (s.instructor ? '<span class="tip-inst"> ' + escapeHtml(s.instructor) + '</span>' : '') +
          (slots ? '<span class="tip-slot"> ' + escapeHtml(slots) + '</span>' : '') +
          '</div>';
      }
    }

    const first = (course.groups.LEC[0] || course.groups.LAB[0] || course.groups.PS[0]);
    const quota = first && first.quota
      ? first.quota.left + ' / ' + first.quota.total + ' kontenjan'
      : '';
    const hasLocked  = locked.size > 0;
    const hasBlocked = blocked.size > 0;
    let hint = '<div class="tip-hint">☆ tercih · 🔓 zorunlu · 🚫 engelle</div>';
    if (hasLocked) {
      hint = '<div class="tip-hint tip-hint-locked">🔒 Kilit aktif — sadece seçili şubeler deneniyor</div>';
    } else if (hasBlocked) {
      hint = '<div class="tip-hint tip-hint-blocked">🚫 Engelleme aktif — engellenen şubeler atlanıyor</div>';
    }

    return '<b>' + escapeHtml(course.title || course.base) + '</b>' +
      (first && first.campus ? '<span class="tip-sub"> · ' + escapeHtml(first.campus) + '</span>' : '') +
      (quota ? '<span class="tip-sub"> · ' + escapeHtml(quota) + '</span>' : '') +
      hint +
      '<div class="tip-sections">' + sectionRows + '</div>';
  }

  function tooltipFor(course) {
    return buildTooltipContent(course);
  }

  function wireTooltip() {
    const tip = $('tip');
    let activeChip = null;
    let hideTimer = null;

    function positionTip(elem) {
      const box = elem.getBoundingClientRect();
      const tipBox = tip.getBoundingClientRect();
      tip.style.left = Math.max(0, Math.min(box.left, window.innerWidth - 340)) + 'px';
      const fitsBelow = box.bottom + 8 + tipBox.height <= window.innerHeight;
      tip.style.top = fitsBelow
        ? (box.bottom + 8) + 'px'
        : Math.max(0, box.top - 8 - tipBox.height) + 'px';
    }

    function showTip(elem) {
      const base = elem.dataset.base;
      if (!base) return;
      const course = state.courses.find((c) => c.base === base);
      if (!course) return;
      activeChip = elem;
      tip.innerHTML = tooltipFor(course);
      tip.style.display = 'block';
      // Position after render so dimensions are known.
      positionTip(elem);
    }

    function hideTip() {
      tip.style.display = 'none';
      activeChip = null;
    }

    function scheduleHide() {
      hideTimer = setTimeout(hideTip, 120);
    }

    function cancelHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    // Bind hover and focus to both chip list (#chips) and selected tray (#tray)
    const containers = [$('chips'), $('tray')].filter(Boolean);
    for (const container of containers) {
      for (const name of ['mouseover', 'focusin']) {
        container.addEventListener(name, (event) => {
          const item = event.target.closest('.chip, .pick');
          if (item) { cancelHide(); showTip(item); }
        });
      }
      for (const name of ['mouseout', 'focusout']) {
        container.addEventListener(name, (event) => {
          if (event.target.closest('.chip, .pick')) scheduleHide();
        });
      }
    }

    // Keep tip visible when mouse enters it.
    tip.addEventListener('mouseenter', cancelHide);
    tip.addEventListener('mouseleave', scheduleHide);

    // Handle section-preference, lock and block clicks inside the tooltip.
    tip.addEventListener('click', (event) => {
      const row = event.target.closest('.tip-row');
      if (!row) return;
      const { base, code } = row.dataset;
      const action = event.target.dataset.action;
      if (action === 'lock') {
        toggleLock(base, code);
      } else if (action === 'block') {
        toggleBlock(base, code);
      } else {
        // Click anywhere else on row (or star icon) = toggle preference star.
        togglePreference(base, code);
      }
      // Re-render tray to sync badges on selected items
      renderTray();
      // Re-render tooltip content in place (keep visible).
      const course = state.courses.find((c) => c.base === base);
      if (course) {
        tip.innerHTML = tooltipFor(course);
        if (activeChip) positionTip(activeChip);
      }
    });
  }

  function renderSummary() {
    const chosen = state.courses.filter((c) => state.selected.has(c.base));
    $('count').textContent = chosen.length;

    const statSpan = $('credits').nextElementSibling;
    if (state.akts) {
      const totalAkts = chosen.reduce((sum, c) => sum + (c.akts || 0), 0);
      $('credits').textContent = totalAkts;
      if (statSpan) statSpan.textContent = 'AKTS seçildi';
    } else {
      const credits = chosen.reduce((sum, c) => sum + c.credit, 0);
      $('credits').textContent = credits;
      if (statSpan) statSpan.textContent = 'kredi seçildi';
    }

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
      localStorage.setItem('dpi.ui', JSON.stringify(state.ui));
      const prefArr = [...state.preferredSections.entries()]
        .map(([base, set]) => [base, [...set]])
        .filter(([, arr]) => arr.length > 0);
      localStorage.setItem('dpi.preferred', JSON.stringify(prefArr));
      const lockArr = [...state.lockedSections.entries()]
        .map(([base, set]) => [base, [...set]])
        .filter(([, arr]) => arr.length > 0);
      localStorage.setItem('dpi.locked', JSON.stringify(lockArr));
      const blockArr = [...state.blockedSections.entries()]
        .map(([base, set]) => [base, [...set]])
        .filter(([, arr]) => arr.length > 0);
      localStorage.setItem('dpi.blocked', JSON.stringify(blockArr));
    } catch (err) { /* private window or blocked storage: run without memory */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem('dpi.selected') || '[]');
      state.selected = new Set(saved.filter(
        (base) => state.courses.some((c) => c.base === base)));
      const prefs = JSON.parse(localStorage.getItem('dpi.prefs') || 'null');
      if (prefs) state.prefs = Object.assign(Scoring.defaultPrefs(), prefs);
      const ui = JSON.parse(localStorage.getItem('dpi.ui') || 'null');
      if (ui) {
        state.ui = {
          overlap: Boolean(ui.overlap),
          gno: String(ui.gno == null ? '0' : ui.gno),
        };
      }
      const prefArr = JSON.parse(localStorage.getItem('dpi.preferred') || '[]');
      state.preferredSections = new Map(prefArr.map(([base, arr]) => [base, new Set(arr)]));
      const lockArr = JSON.parse(localStorage.getItem('dpi.locked') || '[]');
      state.lockedSections = new Map(lockArr.map(([base, arr]) => [base, new Set(arr)]));
      const blockArr = JSON.parse(localStorage.getItem('dpi.blocked') || '[]');
      state.blockedSections = new Map(blockArr.map(([base, arr]) => [base, new Set(arr)]));
    } catch (err) { state.selected = new Set(); }
  }

  function wire() {
    const drop = $('drop');
    drop.addEventListener('click', () => $('file').click());

    // Built-in e-Campus.xlsx preset: fetch from the same origin (works under
    // http:// but NOT under file://; for file:// the user must open the file).
    const preset = $('preset');
    if (preset) {
      preset.addEventListener('click', async () => {
        preset.disabled = true;
        preset.querySelector('span').textContent = 'Yükleniyor…';
        try {
          const res = await fetch('e-Campus.xlsx');
          if (!res.ok) throw new Error('Dosya alınamadı: ' + res.status);
          const buf = await res.arrayBuffer();
          await loadBytes(new Uint8Array(buf), 'e-Campus.xlsx', false);
        } catch (err) {
          showError('Hazır ders programı açılamadı: ' + (err.message || String(err)));
          preset.querySelector('span').textContent = 'e-Campus XLSX Programını kullan';
        } finally {
          preset.disabled = false;
        }
      });
    }

    // PDF preset: fetch from same origin (e-campus-8.pdf is bundled alongside index.html).
    const presetPdf = $('preset-pdf');
    if (presetPdf) {
      presetPdf.addEventListener('click', async () => {
        presetPdf.disabled = true;
        const spanEl = presetPdf.querySelector('span');
        const originalText = spanEl.textContent;
        spanEl.textContent = 'İndiriliyor…';
        try {
          const res = await fetch('e-campus-8.pdf');
          if (!res.ok) throw new Error('Dosya alınamadı: ' + res.status);
          const buf = await res.arrayBuffer();
          await loadBytes(new Uint8Array(buf), 'e-campus-8.pdf', true);
          // Reset text after successful load
          spanEl.textContent = originalText;
        } catch (err) {
          showError(
            'e-Campus PDF açılamadı: ' + (err.message || String(err)) +
            '. PDF\'i manuel olarak indirip buraya bırakabilirsiniz.'
          );
          spanEl.textContent = originalText;
        } finally {
          presetPdf.disabled = false;
        }
      });
    }

    // Share button: copy share URL to clipboard.
    const shareBtn = $('share');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => {
        const url = buildShareUrl();
        navigator.clipboard.writeText(url).then(() => {
          const orig = shareBtn.textContent;
          shareBtn.textContent = '✓ Kopyalandı';
          setTimeout(() => { shareBtn.textContent = orig; }, 2000);
        }).catch(() => {
          // Fallback: prompt
          prompt('Bu bağlantıyı kopyala:', url);
        });
      });
    }

    $('file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      // Clear it so picking the SAME file twice still fires a change event.
      e.target.value = '';
      if (file) loadFile(file);
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
      else showError('Bir dosya bırakmalısınız (ör. .xlsx veya .pdf) — sürüklenen içerik dosya değil.');
    });
    $('search').addEventListener('input', renderChips);
    $('gno').addEventListener('change', () => {
      state.ui.gno = $('gno').value;
      renderSummary();
      persist();
    });
    $('overlap').addEventListener('change', () => {
      state.ui.overlap = $('overlap').checked;
      persist();
    });
    wireTooltip();
    initTheme();
    initUserLogin();
    $('fdw').addEventListener('input', () => { $('fdwOut').textContent = $('fdw').value; });
    $('cmp').addEventListener('input', () => { $('cmpOut').textContent = $('cmp').value; });
    $('go').addEventListener('click', run);
  }

  // ---------------------------------------------------------------------------
  // e-Campus Login API Integration
  // ---------------------------------------------------------------------------
  function updateUserUi() {
    const loginBtn = $('login-btn');
    const userPill = $('user-pill');
    const userInfoText = $('user-info-text');

    if (state.user.loggedIn) {
      if (loginBtn) loginBtn.classList.add('hidden');
      if (userPill) {
        userPill.classList.remove('hidden');
        if (userInfoText) {
          const gpaStr = state.user.gpa != null ? 'GNO: ' + state.user.gpa : '';
          const aktsStr = state.user.totalAkts != null ? ' (' + state.user.totalAkts + ' AKTS)' : '';
          userInfoText.textContent = '👤 ' + gpaStr + aktsStr;
        }
      }
    } else {
      if (loginBtn) loginBtn.classList.remove('hidden');
      if (userPill) userPill.classList.add('hidden');
    }
  }

  const normCode = (s) => String(s || '').replace(/[\s\-_\.]/g, '').toUpperCase();

  function getEquivalentCodes(codeStr) {
    const s = String(codeStr || '').trim();
    const match = /^([A-Za-z]+)\s*(\d+)$/.exec(s);
    if (!match) return [s, normCode(s)];
    const prefix = match[1].toUpperCase();
    const numStr = match[2];
    const results = new Set([s, prefix + numStr, normCode(s)]);

    // Common department prefix aliases
    const PREFIX_ALIASES = {
      'CS': ['COMP', 'CSE'],
      'COMP': ['CS', 'CSE'],
      'CSE': ['CS', 'COMP'],
      'IE': ['IND'],
      'IND': ['IE'],
      'EE': ['EEE', 'ELEC'],
      'EEE': ['EE', 'ELEC'],
      'ELEC': ['EE', 'EEE'],
      'ME': ['MECH'],
      'MECH': ['ME'],
    };
    if (PREFIX_ALIASES[prefix]) {
      for (const altPrefix of PREFIX_ALIASES[prefix]) {
        results.add(altPrefix + numStr);
        results.add(normCode(altPrefix + numStr));
      }
    }

    // Handle 3-digit <-> 4-digit conversion (e.g. CS101 <-> CS1001, MATH101 <-> MATH1001)
    if (/^\d{3}$/.test(numStr)) {
      const d1 = numStr[0];
      const d23 = numStr.slice(1);
      results.add(prefix + d1 + '00' + d23);
      results.add(prefix + d1 + '0' + d23);
      results.add(normCode(prefix + d1 + '00' + d23));
    } else if (/^\d{4}$/.test(numStr)) {
      const m4 = /^(\d)00?(\d{2})$/.exec(numStr);
      if (m4) {
        results.add(prefix + m4[1] + m4[2]);
        results.add(normCode(prefix + m4[1] + m4[2]));
      }
    }

    // Handle 100X <-> 111X patterns (e.g. MATH1002 <-> MATH1112, PHYS1004 <-> PHYS1114)
    const m1000 = /^1[01]\d(\d)$/.exec(numStr);
    if (m1000) {
      const lastDigit = m1000[1];
      results.add(prefix + '100' + lastDigit);
      results.add(prefix + '111' + lastDigit);
      results.add(prefix + '10' + lastDigit);
      results.add(prefix + '11' + lastDigit);
    }

    // Handle CORE0A0B <-> CORE0A1B patterns (e.g. CORE0118 <-> CORE0108)
    const mCore = /^CORE0?([1-5])([01])(\d)$/i.exec(s);
    if (mCore) {
      const group = mCore[1];
      const lastDigit = mCore[3];
      results.add('CORE0' + group + '0' + lastDigit);
      results.add('CORE0' + group + '1' + lastDigit);
      results.add('CORE' + group + '0' + lastDigit);
      results.add('CORE' + group + '1' + lastDigit);
    }

    // General rule: toggle any single 0<->1 digit in the number.
    for (let i = 0; i < numStr.length; i++) {
      const c = numStr[i];
      if (c === '0' || c === '1') {
        const toggled = numStr.slice(0, i) + (c === '0' ? '1' : '0') + numStr.slice(i + 1);
        results.add(prefix + toggled);
      }
    }

    return Array.from(results);
  }

  function isCurriculumCourse(base) {
    if (!state.user.loggedIn) return true;
    if (!state.user.allowedCourses || state.user.allowedCourses.size === 0) return true;
    const variants = getEquivalentCodes(base);
    for (const v of variants) {
      if (state.user.allowedCourses.has(v) || state.user.allowedCourses.has(normCode(v))) {
        return true;
      }
    }
    return false;
  }

  function isPassedCourse(base) {
    if (!state.user.loggedIn) return false;
    const variants = getEquivalentCodes(base);
    for (const v of variants) {
      const norm = normCode(v);
      const grade = state.user.passedCourses.get(norm) || state.user.passedCourses.get(v);
      if (grade) {
        // DD/DC are in passedCourses for badge display, but NOT locked — student can retake
        if (RETAKEABLE_GRADES.includes(grade.toUpperCase())) return false;
        return true;
      }
    }
    return false;
  }

  function getPassedGrade(base) {
    if (!state.user.loggedIn) return null;
    const variants = getEquivalentCodes(base);
    for (const v of variants) {
      const norm = normCode(v);
      if (state.user.passedCourses.has(norm)) return state.user.passedCourses.get(norm);
      if (state.user.passedCourses.has(v)) return state.user.passedCourses.get(v);
    }
    return null;
  }

  function getStudentAkts(base) {
    if (!state.user.loggedIn) return null;
    const variants = getEquivalentCodes(base);
    for (const v of variants) {
      const norm = normCode(v);
      if (state.user.studentAktsMap.has(norm)) return state.user.studentAktsMap.get(norm);
      if (state.user.studentAktsMap.has(v)) return state.user.studentAktsMap.get(v);
    }
    return null;
  }

  function applyStudentAktsOverwrites() {
    if (!state.courses || state.courses.length === 0) return;
    for (const course of state.courses) {
      const studentAkts = getStudentAkts(course.base);
      if (studentAkts != null) {
        course.akts = studentAkts;
        for (const kind of ['LEC', 'LAB', 'PS']) {
          if (course.groups && course.groups[kind]) {
            for (const s of course.groups[kind]) {
              s.akts = studentAkts;
            }
          }
        }
      } else if (course.originalAkts != null) {
        course.akts = course.originalAkts;
        for (const kind of ['LEC', 'LAB', 'PS']) {
          if (course.groups && course.groups[kind]) {
            for (const s of course.groups[kind]) {
              if (s.originalAkts != null) s.akts = s.originalAkts;
            }
          }
        }
      }
    }
  }

  function isElectivePool(key, offeredList) {
    if (/-(GE|AE|ELECTIVE|ELE|SE)/i.test(key)) return true;
    if (!offeredList || offeredList.length <= 2) return false;
    const prefixes = new Set(offeredList.map((item) => (item.code || '').replace(/[\d\s]/g, '')));
    return prefixes.size > 2;
  }

  // Add a code and ALL its equivalents (CORE0108 ↔ CORE0118, MATH1111 ↔ MATH1001, etc.)
  // to the allowedCourses set so lookups are a simple O(1) .has() check.
  function addAllowedCode(code) {
    const variants = getEquivalentCodes(code);
    for (const v of variants) {
      state.user.allowedCourses.add(v);
      state.user.allowedCourses.add(normCode(v));
    }
  }

  function handleLoginSuccess(data) {
    state.user.loggedIn = true;
    const studentInfo = data.student_info || data;
    state.user.gpa = studentInfo.gpa != null ? studentInfo.gpa : null;
    state.user.totalAkts = studentInfo.total_akts != null ? studentInfo.total_akts : null;
    state.user.passedCourses.clear();
    state.user.studentAktsMap.clear();
    state.user.allowedCourses.clear();

    const donemler = studentInfo.donemler || {};
    const offeredCourses = data.offered_courses || {};
    state.user.donemler = donemler;
    state.user.offeredCourses = offeredCourses;

    // 1. Collect all curriculum course codes + their equivalents
    for (const semName in donemler) {
      const semCourses = donemler[semName];
      for (const code in semCourses) {
        addAllowedCode(code.trim());
      }
    }

    // 2. Collect all offered / equivalent / elective course codes + their equivalents
    for (const key in offeredCourses) {
      addAllowedCode(key.trim());
      const list = offeredCourses[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.code) addAllowedCode(item.code.trim());
        }
      }
    }

    // 3. Process ECTS overwrites and passed course grades
    for (const semName in donemler) {
      const semCourses = donemler[semName];
      for (const code in semCourses) {
        const info = semCourses[code];
        if (Array.isArray(info)) {
          const curriculumKey = code.trim();
          const normCurr = normCode(curriculumKey);
          const offeredList = offeredCourses[curriculumKey] || [];
          const isPool = isElectivePool(curriculumKey, offeredList);

          // Build set of course codes mapped to this curriculum slot
          const mappedCodes = new Set([curriculumKey, normCurr]);
          if (Array.isArray(offeredList)) {
            for (const item of offeredList) {
              if (item && item.code) {
                const altCode = item.code.trim();
                mappedCodes.add(altCode);
                mappedCodes.add(normCode(altCode));
              }
            }
          }

          // info[0] is the department-specific ECTS for the student
          if (info[0] != null) {
            const aktsVal = Number(info[0]);
            if (!isNaN(aktsVal) && aktsVal > 0) {
              for (const c of mappedCodes) {
                state.user.studentAktsMap.set(c, aktsVal);
              }
            }
          }

          // info[1] is the letter grade
          const grade = info[1];
          const gradeUp = typeof grade === 'string' ? grade.trim().toUpperCase() : '';
          // DD and DC are conditional passes — student CAN retake to improve GPA.
          // We store them in passedCourses so the grade badge shows, but we do NOT
          // treat them the same as fully-passed courses (they stay selectable).
          const isFailed     = FAILED_GRADES.includes(gradeUp);
          const isRetakeable = RETAKEABLE_GRADES.includes(gradeUp);
          if (gradeUp && !isFailed) {
            const cleanGrade = grade.trim();
            if (isPool) {
              state.user.passedCourses.set(curriculumKey, cleanGrade);
              state.user.passedCourses.set(normCurr, cleanGrade);
            } else {
              for (const c of mappedCodes) {
                state.user.passedCourses.set(c, cleanGrade);
              }
            }
          }
        }
      }
    }

    try {
      localStorage.setItem('planner_ecampus_user', JSON.stringify({
        gpa: state.user.gpa,
        totalAkts: state.user.totalAkts,
        passedCourses: Array.from(state.user.passedCourses.entries()),
        studentAktsMap: Array.from(state.user.studentAktsMap.entries()),
        allowedCourses: Array.from(state.user.allowedCourses),
        donemler: state.user.donemler,
        offeredCourses: state.user.offeredCourses,
      }));
    } catch (e) {}

    // Deselect any passed or non-curriculum course
    for (const course of state.courses) {
      if (isPassedCourse(course.base) || !isCurriculumCourse(course.base)) {
        state.selected.delete(course.base);
      }
    }
    for (const passedBase of state.user.passedCourses.keys()) {
      state.selected.delete(passedBase);
    }

    applyStudentAktsOverwrites();
    updateUserUi();
    renderChips();
    renderTray();
    renderSummary();
  }

  function logoutUser() {
    state.user.loggedIn = false;
    state.user.gpa = null;
    state.user.totalAkts = null;
    state.user.passedCourses.clear();
    state.user.studentAktsMap.clear();
    state.user.allowedCourses.clear();

    try {
      localStorage.removeItem('planner_ecampus_user');
    } catch (e) {}

    applyStudentAktsOverwrites();
    updateUserUi();
    renderChips();
    renderTray();
    renderSummary();
  }

  function restoreUserSession() {
    try {
      const raw = localStorage.getItem('planner_ecampus_user');
      if (raw) {
        const parsed = JSON.parse(raw);
        // If this is an old session without allowedCourses, discard it so the
        // user gets prompted to log in again with the full new data structure.
        if (!parsed.allowedCourses || parsed.allowedCourses.length === 0) {
          localStorage.removeItem('planner_ecampus_user');
          return;
        }
        state.user.loggedIn = true;
        state.user.gpa = parsed.gpa;
        state.user.totalAkts = parsed.totalAkts;
        state.user.passedCourses = new Map(parsed.passedCourses || []);
        state.user.studentAktsMap = new Map(parsed.studentAktsMap || []);
        state.user.allowedCourses = new Set(parsed.allowedCourses || []);
        state.user.donemler = parsed.donemler || {};
        state.user.offeredCourses = parsed.offeredCourses || {};
        applyStudentAktsOverwrites();
        updateUserUi();
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // CCR (Curriculum Course Requirements) popup & Option Selector
  // ---------------------------------------------------------------------------
  function getAvailableOptionsForSlot(code) {
    const offeredCourses = state.user.offeredCourses || {};
    const normSlot = normCode(code);
    const optionCodes = new Set();

    // Check offeredCourses[code] and offeredCourses[normSlot]
    const offeredList = offeredCourses[code] || offeredCourses[normSlot] || [];
    if (Array.isArray(offeredList)) {
      for (const item of offeredList) {
        if (item && item.code) optionCodes.add(normCode(item.code));
      }
    }

    // Check all equivalent variants of code
    const variants = getEquivalentCodes(code);
    for (const v of variants) {
      optionCodes.add(normCode(v));
      const list = offeredCourses[v] || offeredCourses[normCode(v)];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.code) optionCodes.add(normCode(item.code));
        }
      }
    }

    // Find all loaded courses in state.courses matching any of optionCodes
    const matches = state.courses.filter((c) => {
      const cVariants = getEquivalentCodes(c.base);
      return cVariants.some((v) => optionCodes.has(normCode(v)));
    });

    return matches;
  }

  function renderCcrOptionsModal(slotCode) {
    const optModal = $('ccr-opt-modal');
    const optTitle = $('ccr-opt-title');
    const optBody  = $('ccr-opt-body');
    if (!optModal || !optBody) return;

    const options = getAvailableOptionsForSlot(slotCode);
    if (optTitle) optTitle.textContent = slotCode + ' — Ders Seçenekleri';

    if (options.length === 0) {
      optBody.innerHTML = '<p class="sub" style="padding:12px">Açılan ders programında uygun opsiyon bulunamadı.</p>';
      optModal.classList.remove('hidden');
      return;
    }

    let html = '';
    for (const course of options) {
      const isSel = state.selected.has(course.base);
      const rowClass = 'ccr-opt-row' + (isSel ? ' ccr-selected' : '');
      const btnClass = 'ccr-add' + (isSel ? ' ccr-add-active' : '');
      const btnIcon  = isSel ? '✓' : '＋';

      html += '<div class="' + rowClass + '">';
      html += '  <div class="ccr-opt-info">';
      html += '    <div class="ccr-opt-code">' + escapeHtml(course.base) + ' <span class="cr">· ' + escapeHtml(aktsOrCredit(course)) + '</span></div>';
      if (course.title) {
        html += '    <div class="ccr-opt-title">' + escapeHtml(course.title) + '</div>';
      }
      html += '  </div>';
      html += '  <button class="' + btnClass + ' ccr-opt-add" data-base="' + escapeHtml(course.base) + '" data-slotcode="' + escapeHtml(slotCode) + '">' + btnIcon + '</button>';
      html += '</div>';
    }

    optBody.innerHTML = html;
    optModal.classList.remove('hidden');
  }

  function renderCcrModal() {
    const modal = $('ccr-modal');
    const body = $('ccr-body');
    if (!modal || !body) return;

    // Read donemler directly from state (populated at login / session restore)
    const donemler = state.user.donemler || {};
    if (Object.keys(donemler).length === 0) {
      body.innerHTML = '<p class="sub" style="padding:16px">Müfredat bilgisi yüklenemedi. Tekrar giriş yapmayı deneyin.</p>';
      modal.classList.remove('hidden');
      return;
    }

    let html = '';
    for (const semName in donemler) {
      const semCourses = donemler[semName];
      html += '<div class="ccr-sem"><div class="ccr-sem-title">' + escapeHtml(semName) + '</div>';
      html += '<div class="ccr-rows">';
      for (const code in semCourses) {
        const info = semCourses[code];
        const grade = Array.isArray(info) ? info[1] : false;
        const akts = Array.isArray(info) ? info[0] : '?';
        const gradeUp = typeof grade === 'string' ? grade.trim().toUpperCase() : '';
        // Fully passed = has a non-fail, non-retakeable grade
        const isPassed = gradeUp !== '' && !FAILED_GRADES.includes(gradeUp) && !RETAKEABLE_GRADES.includes(gradeUp);
        const isRetakeable = RETAKEABLE_GRADES.includes(gradeUp);

        const options = getAvailableOptionsForSlot(code);
        const selectedInSlot = options.filter((c) => state.selected.has(c.base));
        const isSelected = selectedInSlot.length > 0;
        const rowClass = 'ccr-row' + (isPassed ? ' ccr-passed' : '') + (isSelected ? ' ccr-selected' : '');

        html += '<div class="' + rowClass + '">';
        html += '<span class="ccr-code">' + escapeHtml(code) + '</span>';
        if (isPassed) {
          html += '<span class="ccr-grade">' + escapeHtml(grade) + '</span>';
        }
        html += '<span class="ccr-akts">' + escapeHtml(String(akts)) + ' AKTS</span>';
        if (isPassed) {
          // fully passed — no + button
        } else if (options.length === 1) {
          const matchedCourse = options[0];
          const isSingleSelected = state.selected.has(matchedCourse.base);
          if (isRetakeable && grade) {
            html += '<span class="ccr-grade ccr-grade-retake" title="Tekrar alınabilir">' + escapeHtml(grade) + '</span>';
          }
          if (isSingleSelected) {
            html += '<button class="ccr-add ccr-add-active" data-base="' + escapeHtml(matchedCourse.base) + '" title="Listeden çıkar">✓</button>';
          } else {
            html += '<button class="ccr-add" data-base="' + escapeHtml(matchedCourse.base) + '" title="Listeye ekle">＋</button>';
          }
        } else if (options.length > 1) {
          if (isRetakeable && grade) {
            html += '<span class="ccr-grade ccr-grade-retake" title="Tekrar alınabilir">' + escapeHtml(grade) + '</span>';
          }
          if (isSelected) {
            html += '<button class="ccr-add ccr-add-active ccr-add-multi" data-slotcode="' + escapeHtml(code) + '" title="Ders seçeneklerini gör / değiştir">✓ (' + selectedInSlot.length + ')</button>';
          } else {
            html += '<button class="ccr-add ccr-add-multi" data-slotcode="' + escapeHtml(code) + '" title="Ders seçeneklerini gör (' + options.length + ' Opsiyon)">＋ (' + options.length + ')</button>';
          }
        } else {
          // not in schedule
          html += '<span class="ccr-no-schedule" title="Bu ders program dosyasında bulunamadı">—</span>';
        }
        html += '</div>';
      }
      html += '</div></div>';
    }

    body.innerHTML = html;
    modal.classList.remove('hidden');
  }

  function initUserLogin() {
    const loginBtn = $('login-btn');
    const modal = $('login-modal');
    const modalClose = $('modal-close');
    const loginForm = $('login-form');
    const logoutBtn = $('logout-btn');
    const loginErr = $('login-err');
    const loginSubmitBtn = $('login-submit-btn');
    const ccrModal = $('ccr-modal');
    const ccrClose = $('ccr-modal-close');
    const ccrBtn = $('ccr-btn');
    const ccrOptModal = $('ccr-opt-modal');
    const ccrOptClose = $('ccr-opt-modal-close');
    const ccrOptBody = $('ccr-opt-body');

    if (loginBtn && modal) {
      loginBtn.addEventListener('click', () => {
        if (state.user.loggedIn) {
          renderCcrModal();
        } else {
          modal.classList.remove('hidden');
          if (loginErr) loginErr.classList.add('hidden');
        }
      });
    }
    // Dedicated "📋 Müfredat" button inside the user-pill
    if (ccrBtn) {
      ccrBtn.addEventListener('click', () => renderCcrModal());
    }
    if (modalClose && modal) {
      modalClose.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }
    if (ccrClose && ccrModal) {
      ccrClose.addEventListener('click', () => {
        ccrModal.classList.add('hidden');
      });
    }
    if (ccrOptClose && ccrOptModal) {
      ccrOptClose.addEventListener('click', () => {
        ccrOptModal.classList.add('hidden');
      });
    }
    if (ccrModal) {
      ccrModal.addEventListener('click', (e) => {
        if (e.target === ccrModal) ccrModal.classList.add('hidden');
      });
    }
    if (ccrOptModal) {
      ccrOptModal.addEventListener('click', (e) => {
        if (e.target === ccrOptModal) ccrOptModal.classList.add('hidden');
      });
    }
    // CCR + / ✓ toggle & multi-option picker listener
    const ccrBody = $('ccr-body');
    if (ccrBody) {
      ccrBody.addEventListener('click', (e) => {
        const multiBtn = e.target.closest('.ccr-add-multi');
        if (multiBtn) {
          const slotCode = multiBtn.dataset.slotcode;
          if (slotCode) renderCcrOptionsModal(slotCode);
          return;
        }

        const btn = e.target.closest('.ccr-add');
        if (!btn) return;
        const base = btn.dataset.base;
        if (!base) return;
        if (state.selected.has(base)) {
          state.selected.delete(base);
          btn.textContent = '＋';
          btn.classList.remove('ccr-add-active');
          btn.closest('.ccr-row').classList.remove('ccr-selected');
        } else {
          state.selected.add(base);
          btn.textContent = '✓';
          btn.classList.add('ccr-add-active');
          btn.closest('.ccr-row').classList.add('ccr-selected');
        }
        persist();
        renderTray();
        renderChips();
        renderSummary();
      });
    }

    // Option Picker item toggle listener inside ccr-opt-body
    if (ccrOptBody) {
      ccrOptBody.addEventListener('click', (e) => {
        const btn = e.target.closest('.ccr-opt-add');
        if (!btn) return;
        const base = btn.dataset.base;
        const slotCode = btn.dataset.slotcode;
        if (!base) return;

        if (state.selected.has(base)) {
          state.selected.delete(base);
        } else {
          state.selected.add(base);
        }
        persist();
        renderTray();
        renderChips();
        renderSummary();
        if (slotCode) renderCcrOptionsModal(slotCode);
        renderCcrModal();
      });
    }
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', logoutUser);
    }
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('login-email').value.trim();
        const pass = $('login-pass').value.trim();
        if (!email || !pass) return;

        if (loginSubmitBtn) {
          loginSubmitBtn.disabled = true;
          loginSubmitBtn.textContent = 'Giriş Yapılıyor…';
        }
        if (loginErr) loginErr.classList.add('hidden');

        try {
          const url = 'https://ecampusdb.dogukervan.me/?' + new URLSearchParams({
            ECampusUsername: email,
            ECampusPassword: pass,
            ECampusLanguageId: '2'
          });
          const res = await fetch(url);
          const data = await res.json();
          if (data.error) {
            throw new Error(data.error);
          }
          handleLoginSuccess(data);
          if (modal) modal.classList.add('hidden');
          $('login-pass').value = '';
        } catch (err) {
          if (loginErr) {
            loginErr.textContent = err.message || 'Giriş başarısız.';
            loginErr.classList.remove('hidden');
          }
        } finally {
          if (loginSubmitBtn) {
            loginSubmitBtn.disabled = false;
            loginSubmitBtn.textContent = 'Giriş Yap';
          }
        }
      });
    }

    restoreUserSession();
  }

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

  const PALETTE_LIGHT = ['#dbeafe', '#dcfce7', '#fef3c7', '#fae8ff', '#ffe4e6',
                         '#e0e7ff', '#ccfbf1', '#ffedd5'];
  const PALETTE_DARK  = ['#1e3a8a', '#064e3b', '#78350f', '#4c1d95', '#831843',
                         '#312e81', '#134e4a', '#7c2d12'];

  function colourFor(base) {
    let hash = 0;
    for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
    const isDark = document.body.classList.contains('dark-theme');
    const palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;
    return palette[hash % palette.length];
  }

  // ---------------------------------------------------------------------------
  // Saat etiketi: 8:30'dan başlayıp 50dk ders + 10dk ara
  // ---------------------------------------------------------------------------
  function hourLabel(n) {
    // Hour n starts at 8:30 + (n-1)*60 minutes
    const startMin = 8 * 60 + 30 + (n - 1) * 60;
    const endMin   = startMin + 50;
    const fmt = (m) => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
    return n + ' · ' + fmt(startMin) + '–' + fmt(endMin);
  }

  // ---------------------------------------------------------------------------
  // Takvim: satırlar = günler, sütunlar = saatler
  // ---------------------------------------------------------------------------
  const DAY_TR = { M: 'Pzt', T: 'Sal', W: 'Çar', Th: 'Per', F: 'Cum', St: 'Cmt', Su: 'Paz' };

  function calendarFor(entry) {
    const usedDays = new Set();
    for (const section of entry.sections) {
      for (const slot of section.slots) usedDays.add(slot.day);
    }
    // Show weekdays always; show Sat/Sun only if used.
    const days = CourseParser.DAYS
      .map((code, index) => ({ code, index }))
      .filter((d) => d.index < 5 || usedDays.has(d.index));

    // Always show hours 1..MAX_HOUR so gaps between classes are clearly visible.
    const MIN_HOUR = 1;
    const MAX_H = CourseParser.MAX_HOUR;

    // day:hour → list of sections occupying that slot.
    const grid = new Map();
    for (const section of entry.sections) {
      for (const slot of section.slots) {
        const key = slot.day + ':' + slot.hour;
        const list = grid.get(key);
        if (list) list.push(section); else grid.set(key, [section]);
      }
    }

    const signature = (list) => (list ? list.map((s) => s.code).sort().join('+') : '');

    // Build table: rows = days, cols = hours
    let html = '<div class="scroll"><table class="cal"><thead><tr><th class="cal-day-hd"></th>';
    for (let h = MIN_HOUR; h <= MAX_H; h++) {
      html += '<th class="cal-hour-hd">' + escapeHtml(hourLabel(h)) + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (const day of days) {
      const dayLabel = DAY_TR[day.code] || day.code;
      html += '<tr><th class="cal-day-cell">' + escapeHtml(dayLabel) + '</th>';

      // skip[hour] > 0 means this column was already covered by a colspan cell.
      const skip = {};
      for (let h = MIN_HOUR; h <= MAX_H; h++) skip[h] = 0;

      for (let h = MIN_HOUR; h <= MAX_H; h++) {
        if (skip[h] > 0) { skip[h]--; continue; }

        const list = grid.get(day.index + ':' + h);
        if (!list) { html += '<td class="cal-empty"></td>'; continue; }

        const sig = signature(list);
        let span = 1;
        while (h + span <= MAX_H &&
               signature(grid.get(day.index + ':' + (h + span))) === sig) span++;
        for (let s = 1; s < span; s++) skip[h + s] = 1;

        if (list.length > 1) {
          // Clash cell: show codes
          const codes = list.map((s) => escapeHtml(s.code)).join(' / ');
          html += '<td class="busy clash" colspan="' + span + '" title="' +
            escapeHtml('Çakışma: ' + list.map((s) => s.code).join(' / ')) + '">' +
            codes + '</td>';
        } else {
          const s = list[0];
          // Title: strip trailing credit in parens, e.g. "CALC (3)" → "CALC"
          const title = escapeHtml((s.title || s.base).replace(/\s*\(\d+\)\s*$/, ''));
          const kindTag = s.kind === 'LAB' ? ' <span class="cal-kind lab-kind">[LAB]</span>' :
                          s.kind === 'PS'  ? ' <span class="cal-kind ps-kind">[PS]</span>' : '';
          const codeTag = '<div class="cal-code">' + escapeHtml(s.code) + kindTag + '</div>';
          const inst = s.instructor ? '<div class="cal-inst">' + escapeHtml(s.instructor) + '</div>' : '';
          html += '<td class="busy" colspan="' + span + '" style="background:' +
            colourFor(s.base) + '">' +
            codeTag +
            '<div class="cal-title">' + title + '</div>' + inst + '</td>';
        }
      }

      html += '</tr>';
    }

    return html + '</tbody></table></div>';
  }

  // A course code shown in its calendar colour, so the culprit named here is
  // the same colour the user has been looking at in the timetables.
  function codeTag(base) {
    return '<span class="tag" style="background:' + colourFor(base) + '">' +
      escapeHtml(base) + '</span>';
  }

  // Turn a failed search into an explanation. Naming the pair that clashes and
  // the hours it clashes on is the difference between "it did not work" and
  // "drop this one course".
  function renderDiagnosis(diagnosis) {
    if (!diagnosis) {
      return '<div class="card err">Çakışmayan hiçbir kombinasyon bulunamadı.</div>';
    }

    let html = '<div class="card err"><strong>Çakışmayan hiçbir kombinasyon bulunamadı.</strong>';

    if (diagnosis.blockingPairs.length > 0) {
      html += '<p>Şu dersler birbiriyle çakıştığı için birlikte alınamaz:</p><ul>';
      for (const pair of diagnosis.blockingPairs) {
        html += '<li>' + codeTag(pair.bases[0]) + ' ile ' + codeTag(pair.bases[1]) +
          ' — ortak saatler: <strong>' + pair.cells.map(escapeHtml).join(', ') + '</strong></li>';
      }
      html += '</ul>';
    } else if (diagnosis.higherOrder) {
      html += '<p>Derslerin hiçbir ikilisi tek başına çakışmıyor, ama hepsi bir arada ' +
        'haftaya sığmıyor. Bu yüzden tek bir suçlu ders yok — birini çıkarman gerekiyor.</p>';
    }

    if (diagnosis.dropCandidates.length > 0) {
      html += '<p>Şu derslerden birini çıkarırsan geri kalanlar için program bulunur: ' +
        diagnosis.dropCandidates.map(codeTag).join(' ') + '</p>';
    } else if (!diagnosis.truncated && diagnosis.blockingPairs.length > 0) {
      html += '<p>Tek bir dersi çıkarmak yetmiyor; en az iki ders değiştirmen gerekiyor.</p>';
    }

    if (diagnosis.truncated) {
      html += '<p>Arama sınıra takıldığı için bu inceleme eksik olabilir. ' +
        'Daha az ders seçersen daha kesin bir sonuç alırsın.</p>';
    }

    html += '<p class="sub">Madde 18/2 seçeneğini açmak da yardımcı olabilir: ' +
      'en fazla iki dersin birer saati çakışabilir (danışman onayı gerekir).</p>';
    return html + '</div>';
  }

  function renderResults(output, chosen) {
    const box = $('results');
    box.innerHTML = '';

    const skipped = output.skipped || [];

    // ---------------------------------------------------------------------------
    // HARD ERROR: a course with locked sections ended up in `skipped`.
    // The solver found valid schedules for the OTHER courses but the locked
    // section could not be placed (it has no valid meeting times in the file).
    // Show an error and refuse to display the partial schedules — the user
    // said "this instructor or nothing at all".
    // ---------------------------------------------------------------------------
    const lockedAndSkipped = skipped.filter(
      (base) => state.lockedSections.has(base) && state.lockedSections.get(base).size > 0
    );
    if (lockedAndSkipped.length > 0) {
      box.innerHTML = '<div class="card err"><strong>🔒 Kilit hatası: kilitli şube zamanlanamadı</strong>' +
        '<p>Aşağıdaki derslerin kilitli şubeleri ders programında geçerli bir saat icerimıyor ' +
        '(kesilmiş veya boş), bu yüzden hiçbir programa yerleştirilemedi:<br>' +
        '<strong>' + lockedAndSkipped.map(escapeHtml).join(', ') + '</strong></p>' +
        '<p>Kilidi kaldırın veya farklı bir şube kilitleyin.</p></div>';
      return;
    }

    // ---------------------------------------------------------------------------
    // HARD ERROR: locked sections exist but the solver found 0 valid schedules.
    // This means the locked section(s) conflict with other selected courses.
    // ---------------------------------------------------------------------------
    if (output.results.length === 0 && output.lockConflict) {
      const conflictBases = output.lockConflictBases || [];
      box.innerHTML = '<div class="card err"><strong>🔒 Kilit hatası: kilitli şube çakışıyor</strong>' +
        '<p>Aşağıdaki derslerin kilitli şubeleri seçili diğer derslerle çakıştığı için hiçbir geçerli program üretilemedi:<br>' +
        '<strong>' + conflictBases.map(escapeHtml).join(', ') + '</strong></p>' +
        '<p>Kilidi kaldırın, çakışan dersi çıkarın ya da Madde 18 seçeneğini etkinleştirin.</p></div>';
      return;
    }

    // Soft skipped warning (no lock involved).
    const softSkipped = skipped.filter(
      (base) => !(state.lockedSections.has(base) && state.lockedSections.get(base).size > 0)
    );
    if (softSkipped.length > 0) {
      box.innerHTML += '<div class="card warn"><strong>Şu dersler programa eklenemedi: ' +
        softSkipped.map(escapeHtml).join(', ') + '</strong><br>' +
        'Bu derslerin ders saatleri dosyadan okunamadı, bu yüzden yerleştirilemediler. ' +
        'Saatlerini resmi ders programından kendin kontrol etmelisin.</div>';
    }

    // Show the truncation notice regardless of whether any results were found.
    if (output.truncated) {
      box.innerHTML += '<div class="card warn">Arama sınıra takıldı — sonuçlar eksik olabilir. ' +
        'Daha az ders seçersen tam sonuç alırsın.</div>';
    }

    if (output.results.length === 0) {
      const nothingToPlan = chosen.length > 0 && skipped.length === chosen.length;
      box.innerHTML += nothingToPlan
        ? '<div class="card err">Seçtiğin derslerin hiçbirinin ders saati okunamadı, ' +
          'bu yüzden program üretilemedi. Bu bir çakışma sorunu değil: dosyadaki saat ' +
          'bilgileri eksik. Ders saatlerini içeren tam bir dosya yüklemeyi deneyebilirsin.</div>'
        : renderDiagnosis(output.diagnosis);
      return;
    }

    output.results.forEach((entry, index) => {
      const card = document.createElement('div');
      card.className = 'sched';
      const breakdown = entry.breakdown
        // The label is built from persisted prefs (a restored freeDays entry
        // lands in it verbatim), so it is not trusted markup.
        .map((item) => escapeHtml(item.label) + ' ' + (item.points > 0 ? '+' : '') + item.points)
        .join(' · ') || 'nötr';
      const badge = entry.overlapHours > 0
        ? '<span class="badge">' + entry.overlapHours +
          ' saat çakışma — danışman onayı gerekir</span>'
        : '';
      const alternates = entry.alternates.length
        ? '<details class="alt-details"><summary>Alternatif şubeler (' +
          entry.alternates.length + ')</summary><p class="sub" style="margin:6px 0 0">' +
          entry.alternates.map((codes) => codes.map(escapeHtml).join(', ')).join(' | ') +
          '</p></details>'
        : '';
      card.innerHTML = '<header><h3>#' + (index + 1) + '</h3>' +
        '<span class="sub">puan ' + entry.score + '/100</span>' + badge + '</header>' +
        calendarFor(entry) +
        '<p class="sub">' + breakdown + '</p>' + alternates;
      box.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Section önceliklendirme, kilitleme ve engelleme
  // ---------------------------------------------------------------------------
  function applyPreferences(courses) {
    return courses.map((course) => {
      const preferred = state.preferredSections.get(course.base);  // Set<code>
      const locked    = state.lockedSections.get(course.base);     // Set<code>
      const blocked   = state.blockedSections.get(course.base);    // Set<code>
      const hasPrefs   = preferred && preferred.size > 0;
      const hasLocked  = locked    && locked.size > 0;
      const hasBlocked = blocked   && blocked.size > 0;
      if (!hasPrefs && !hasLocked && !hasBlocked) return course;

      // Helper: apply to one kind group.
      function processGroup(sections) {
        let pool = sections;
        if (hasBlocked) {
          pool = pool.filter((s) => !blocked.has(s.code));
        }
        if (hasLocked) {
          // Hard filter: only locked sections are allowed for this kind.
          const kindLocked = pool.filter((s) => locked.has(s.code));
          if (kindLocked.length > 0) return kindLocked;
        }
        if (hasPrefs) {
          // Soft preference: reorder so preferred sections come first.
          return pool.slice().sort((a, b) => {
            const ap = preferred.has(a.code) ? 0 : 1;
            const bp = preferred.has(b.code) ? 0 : 1;
            return ap - bp;
          });
        }
        return pool;
      }

      return Object.assign({}, course, {
        groups: {
          LEC: processGroup(course.groups.LEC),
          LAB: processGroup(course.groups.LAB),
          PS:  processGroup(course.groups.PS),
        },
      });
    });
  }

  function run() {
    const chosen = state.courses.filter((c) => state.selected.has(c.base));
    if (chosen.length === 0) { $('status').textContent = 'Önce ders seç.'; return; }
    $('status').textContent = 'Hesaplanıyor…';
    setTimeout(() => {
      const started = Date.now();
      const prefs = readPrefs();
      const allowOverlap = $('overlap').checked;
      const chosenWithPrefs = applyPreferences(chosen);
      const output = Solver.solve(chosenWithPrefs, prefs, { limit: 10, allowOverlap: allowOverlap });

      // Detect locked courses that ended up in the solver's skipped list.
      // These have valid slots but got skipped because the solver couldn't place
      // them with any other course — but that is handled in renderResults as a
      // hard error (lockConflict).
      // ALSO detect the separate case: 0 results because the locked section
      // DOES have valid options but conflicts with everything during search.
      if (output.results.length === 0) {
        const skipped = output.skipped || [];
        // Courses that have locks AND went to skipped (file-level 0 options):
        // these are caught inside renderResults via lockedAndSkipped.
        // Courses that have locks but were NOT skipped (they had options but
        // all options conflicted during search):
        const lockedNotSkipped = chosen.filter(
          (c) => state.lockedSections.has(c.base) &&
                 state.lockedSections.get(c.base).size > 0 &&
                 !skipped.includes(c.base)
        );
        if (lockedNotSkipped.length > 0) {
          output.lockConflict = true;
          output.lockConflictBases = lockedNotSkipped.map((c) => c.base);
        } else {
          output.diagnosis = Solver.diagnose(chosenWithPrefs, prefs, { allowOverlap: allowOverlap });
        }
      }

      $('status').textContent = output.considered + ' kombinasyon tarandı · ' +
        (Date.now() - started) + ' ms';
      renderResults(output, chosen);
    }, 0);
  }

  function initTheme() {
    const toggleBtn = $('theme-toggle');
    const icon = $('theme-icon');
    if (!toggleBtn || !icon) return;

    const saved = localStorage.getItem('dpi.theme');
    if (saved === 'dark') {
      document.body.classList.add('dark-theme');
      icon.textContent = '☀️';
    } else {
      document.body.classList.remove('dark-theme');
      icon.textContent = '🌙';
    }

    toggleBtn.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('dark-theme');
      icon.textContent = isDark ? '☀️' : '🌙';
      try {
        localStorage.setItem('dpi.theme', isDark ? 'dark' : 'light');
      } catch (e) {}
      // Re-run solver/results if courses are currently selected so colors update
      if (state.selected && state.selected.size > 0 && $('results').children.length > 0) {
        run();
      }
    });
  }

  wire();
  window.UI = { state, renderChips, renderTray, renderSummary };
})();
