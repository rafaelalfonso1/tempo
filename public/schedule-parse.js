/* Tempo — flexible schedule text parser (browser + Node).
 *
 * parseShift(text) understands things like:
 *   "8-5"  "5-3"  "8a-5p"  "8:30am - 5:15pm"  "0800-1700"  "22-6"  "10p-6a"  "9 to 6"  "8 a 5"
 *   "off"  "OFF"  "libre"  "x"  "-"
 *   optional break: "8-5 30m"  "8-5 (1h)"  "8-5 brk 45"  "8-5 lunch 60"  "8-5/30"
 * When am/pm is omitted it picks the reading that gives a sensible shift (1–16 h):
 *   "5-3" → 05:00–15:00, "2-11" → 14:00–23:00, "10p-6" → 22:00–06:00 (overnight).
 *
 * parseWeek(text) understands day specs (English or Spanish):
 *   "Mon-Fri 8a-5p; Sat 9-1; Sun off"   "M-F 9-6, Sa 8-12"   "Lun a Vie 8-5, Sab libre"
 *   "weekdays 8-5"  "daily 7-3"  "Mon 5-3, Tue 8-5, Wed-Fri 9-6"
 * Days that aren't mentioned are returned as OFF.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SchedParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const OFF_WORDS = new Set(['off', 'o', 'x', '-', '--', 'libre', 'dayoff', 'day off', 'rest', 'descanso', 'none', 'n/a', 'na', 'free']);
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (min) => { min = ((min % 1440) + 1440) % 1440; return pad(Math.floor(min / 60)) + ':' + pad(min % 60); };

  // A single time token → { min (0-1439 in its own 12h/24h reading), mer: 'a'|'p'|null, h24: bool }
  function parseTime(tok) {
    let t = tok.trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
    if (t === 'noon' || t === 'mediodia' || t === 'mediodía') return { h: 12, m: 0, mer: 'p', h24: false };
    if (t === 'midnight' || t === 'medianoche') return { h: 0, m: 0, mer: 'a', h24: true };
    let mer = null;
    const mm = t.match(/(am|pm|a|p|m)$/);
    if (mm) { mer = mm[1][0] === 'p' ? 'p' : mm[1][0] === 'a' ? 'a' : null; if (mm[1] === 'm') return null; t = t.slice(0, -mm[1].length); }
    let h, m = 0, h24 = false;
    if (/^\d{1,2}$/.test(t)) h = Number(t);
    else if (/^\d{1,2}[:h]\d{2}$/.test(t)) { const [a, b] = t.split(/[:h]/); h = Number(a); m = Number(b); }
    else if (/^\d{3,4}$/.test(t)) { h = Number(t.slice(0, -2)); m = Number(t.slice(-2)); if (t.length === 4 && t[0] === '0') h24 = true; }
    else return null;
    if (m > 59 || h > 24) return null;
    if (h === 24) { h = 0; h24 = true; }
    if (h > 12 || h === 0) h24 = true;
    if (mer && h24 && h > 12) return null; // "17pm"
    return { h, m, mer, h24 };
  }
  // All plausible minute-of-day readings for a token.
  function readings(t, isStart) {
    if (t.h24 && !t.mer) return [t.h * 60 + t.m];
    if (t.mer === 'a') return [(t.h % 12) * 60 + t.m];
    if (t.mer === 'p') return [((t.h % 12) + 12) * 60 + t.m];
    const am = (t.h % 12) * 60 + t.m, pm = am + 720;
    // Bare start times 1–4 are far more likely afternoon starts (e.g. "2-11"); 5–11 morning; 12 noon.
    if (isStart) return t.h === 12 ? [pm, am] : t.h <= 4 ? [pm, am] : [am, pm];
    return [am, pm];
  }

  function parseShift(input) {
    if (input == null) return { empty: true };
    let s = String(input).trim();
    if (!s) return { empty: true };
    const low = s.toLowerCase();
    if (OFF_WORDS.has(low)) return { off: true, hours: 0 };

    // Break: "30m", "45 min", "(1h)", "brk 30", "break 1h", "lunch 60", "/30"
    let breakMin = 0;
    const brRe = [
      /\(?\b(?:break|brk|lunch|almuerzo|b)\s*:?\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)?\)?/i,
      /\(\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|m|min|mins)?\s*\)/i,
      /\s(\d+(?:\.\d+)?)\s*(m|min|mins|minutes)\b/i,
      /\/\s*(\d+)\s*(m|min)?\s*$/i,
    ];
    for (const re of brRe) {
      const m = s.match(re);
      if (m) { const n = Number(m[1]); breakMin = /^h/i.test(m[2] || '') ? Math.round(n * 60) : (!m[2] && n <= 3 ? Math.round(n * 60) : Math.round(n)); s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim(); break; }
    }

    const parts = s.split(/\s*(?:-|–|—|\bto\b|\bhasta\b|\s+a\s+)\s*/i).filter(Boolean);
    if (parts.length !== 2) return { error: 'Use a range like 8-5, 8a-5p or 08:00-17:00 (or "off")' };
    const a = parseTime(parts[0]), b = parseTime(parts[1]);
    if (!a || !b) return { error: `Couldn't read the time "${!a ? parts[0] : parts[1]}"` };
    // If only one side has am/pm and the other is a bare 1–12, let the explicit one hint (e.g. "8-5pm").
    let best = null;
    for (const st of readings(a, true)) for (const en of readings(b, false)) {
      let d = en - st; if (d <= 0) d += 1440;
      const net = d - breakMin;
      if (d < 60 || d > 16 * 60 || net <= 0) continue;
      // prefer: first-listed start reading, then shortest duration
      const score = readings(a, true).indexOf(st) * 10000 + d;
      if (!best || score < best.score) best = { st, en, d, score };
    }
    if (!best) return { error: 'That shift would be shorter than 1 hour or longer than 16 hours' };
    const overnight = best.en <= best.st;
    return { start: hhmm(best.st), end: hhmm(best.en), break_minutes: breakMin, hours: Math.round(((best.d - breakMin) / 60) * 100) / 100, overnight };
  }

  // ---------------- week patterns ----------------
  const DAY_WORDS = [
    [0, ['sun', 'sunday', 'su', 'dom', 'domingo', 'do', 'd']],
    [1, ['mon', 'monday', 'mo', 'm', 'lun', 'lunes', 'lu', 'l']],
    [2, ['tue', 'tues', 'tuesday', 'tu', 't', 'mar', 'martes', 'ma']],
    [3, ['wed', 'wednesday', 'we', 'w', 'mie', 'mié', 'miercoles', 'miércoles', 'mi', 'x']],
    [4, ['thu', 'thur', 'thurs', 'thursday', 'th', 'r', 'jue', 'jueves', 'ju', 'j']],
    [5, ['fri', 'friday', 'fr', 'f', 'vie', 'viernes', 'vi', 'v']],
    [6, ['sat', 'saturday', 'sa', 's', 'sab', 'sáb', 'sabado', 'sábado']],
  ];
  const DAY_MAP = new Map(); DAY_WORDS.forEach(([n, ws]) => ws.forEach((w) => DAY_MAP.set(w, n)));
  const GROUPS = { weekdays: [1, 2, 3, 4, 5], weekday: [1, 2, 3, 4, 5], 'week days': [1, 2, 3, 4, 5], weekends: [0, 6], weekend: [0, 6], daily: [0, 1, 2, 3, 4, 5, 6], everyday: [0, 1, 2, 3, 4, 5, 6], 'every day': [0, 1, 2, 3, 4, 5, 6], all: [0, 1, 2, 3, 4, 5, 6], 'todos los dias': [0, 1, 2, 3, 4, 5, 6], 'fin de semana': [0, 6], 'entre semana': [1, 2, 3, 4, 5] };
  const dayNum = (w) => DAY_MAP.get(w.toLowerCase().replace(/\.$/, ''));
  const range = (a, b) => { const out = [a]; while (a !== b) { a = (a + 1) % 7; out.push(a); } return out; };
  // Long names first so "mon" isn't read as "m" + "on"
  const DAY_ALT = [...DAY_MAP.keys(), ...Object.keys(GROUPS)].sort((x, y) => y.length - x.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const SPEC_RE = new RegExp(`^\\s*((?:(?:${DAY_ALT})\\.?(?:\\s*(?:-|–|to|a|thru|through|,|&|and|y|\\/)\\s*|\\s+)?)+)(?=\\s|:|$)\\s*:?\\s*(.*)$`, 'i');

  function parseDaySpec(spec) {
    const days = new Set();
    let s = spec.toLowerCase().replace(/\s+/g, ' ').trim();
    if (GROUPS[s]) return GROUPS[s];
    // Normalize ranges to "a-b", then split the rest on commas, spaces, &, and, y, /
    s = s.replace(/\s*(?:-|–|\bto\b|\bthru\b|\bthrough\b|\ba\b)\s*/g, '-');
    const tokens = s.split(/[\s,&/]+|\band\b|\by\b/).filter(Boolean);
    for (const tok of tokens) {
      if (GROUPS[tok]) { GROUPS[tok].forEach((d) => days.add(d)); continue; }
      const r = tok.split('-').filter(Boolean);
      if (r.length === 2 && dayNum(r[0]) != null && dayNum(r[1]) != null) range(dayNum(r[0]), dayNum(r[1])).forEach((d) => days.add(d));
      else if (r.length === 1 && dayNum(r[0]) != null) days.add(dayNum(r[0]));
      else return null;
    }
    return [...days];
  }

  // Returns { days: {0..6: shift}, errors: [] }
  function parseWeek(input) {
    const res = { days: {}, errors: [] };
    const text = String(input || '').trim();
    if (!text) return res;
    const hasShift = (t) => /\d/.test(t) || /\b(off|libre|descanso|rest)\b/i.test(t);
    const segs = [];
    for (const part of text.split(/\s*(?:;|\n|\|)\s*/).filter(Boolean)) {
      let cur = '';
      for (const piece of part.split(/\s*,\s*/)) {
        // "mon, wed, fri 8-5" → keep day-only pieces attached to what follows
        if (cur && hasShift(cur)) { segs.push(cur); cur = piece; } else cur = cur ? cur + ', ' + piece : piece;
      }
      if (cur) segs.push(cur);
    }
    let sawSpec = false;
    for (const seg of segs) {
      const m = seg.match(SPEC_RE);
      const days = m ? parseDaySpec(m[1].replace(/[\s:,&/-]+$/, '')) : null;
      if (m && days && days.length) {
        sawSpec = true;
        const sh = parseShift(m[2]);
        if (sh.error || sh.empty) { res.errors.push(`"${seg}": ${sh.error || 'missing shift'}`); continue; }
        days.forEach((d) => { res.days[d] = sh; });
      } else if (!sawSpec && segs.length === 1) {
        // A bare shift with no days means Monday–Friday.
        const sh = parseShift(seg);
        if (sh.error) { res.errors.push(sh.error); continue; }
        [1, 2, 3, 4, 5].forEach((d) => { res.days[d] = sh; });
      } else res.errors.push(`"${seg}": couldn't tell which days this is for`);
    }
    for (let d = 0; d < 7; d++) if (!res.days[d]) res.days[d] = { off: true, hours: 0 };
    return res;
  }

  // Display helpers
  function fmt12(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h < 12 ? 'a' : 'p'; const h12 = h % 12 || 12;
    return h12 + (m ? ':' + pad(m) : '') + ap;
  }
  function label(sh) {
    if (!sh) return '';
    if (sh.off) return 'OFF';
    return `${fmt12(sh.start)}–${fmt12(sh.end)}`;
  }
  function toText(sh) { // round-trippable text for editing
    if (!sh) return '';
    if (sh.off) return 'off';
    return `${fmt12(sh.start)}-${fmt12(sh.end)}${sh.break_minutes ? ' ' + sh.break_minutes + 'm' : ''}`;
  }
  return { parseShift, parseWeek, parseTime, label, toText, fmt12 };
});
