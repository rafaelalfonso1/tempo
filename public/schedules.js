/* Tempo — Schedule management. Loaded before app.js; uses its helpers at call time. */
'use strict';

const SP = () => window.SchedParse;
const SCHED = { selected: new Set() };
const weekOrder = () => [0, 1, 2, 3, 4, 5, 6].map((i) => (i + S.meta.week_start_day) % 7);
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const shiftCell = (sh, month) => {
  if (!sh) return '<span class="hcell none">–</span>';
  if (sh.off) return '<span class="sched-off">OFF</span>';
  return month ? `<span class="hcell">${fmtH(sh.hours).replace(/\.00$/, '')}</span>`
    : `<span class="sched-shift">${esc(SP().label(sh))}</span><span class="hrs-mini">${fmtH(sh.hours)}h${sh.break_minutes ? ` · ${sh.break_minutes}m brk` : ''}</span>`;
};

async function viewSchedules(searchOnly) {
  const main = $('#main');
  if (!searchOnly || S.data?.kind !== 'schedule') {
    const tb = matrixToolbar((s) => viewSchedules(s));
    main.innerHTML = `<h1>Schedules</h1>
      <p class="sub">Click a cell and type a shift any way you like: <code>8-5</code>, <code>5a-3p</code>, <code>08:00-17:00</code>, <code>22-6</code>, <code>8-5 30m</code>, <code>off</code>. Click an agent's name, or select several, to set a weekly pattern with a different shift for each day.</p>
      ${tb.html}
      <div class="toolbar">
        <button class="btn primary" id="sc-week">Set weekly schedule…</button>
        <button class="btn" id="sc-paste">Paste from Excel…</button>
        <button class="btn" id="sc-export">Export CSV</button>
        <span class="muted" id="sc-selinfo"></span>
      </div>
      <div class="panel"><div class="table-wrap" id="grid"></div></div>
      <div class="legend"><span><span class="dot" style="position:static;display:inline-block"></span> one-off change for that date (overrides the weekly pattern)</span><span>Overnight shifts (e.g. 10p–6a) count toward the day they start.</span></div>`;
    tb.bind(main);
    $('#sc-week').onclick = () => {
      const ids = [...SCHED.selected];
      if (!ids.length) return toast('Select agents with the checkboxes, or click an agent name', true);
      openWeeklyModal(ids);
    };
    $('#sc-paste').onclick = openPasteModal;
    $('#sc-export').onclick = exportScheduleCsv;
    S.data = await api('GET', '/api/schedules?' + matrixQuery());
    S.data.kind = 'schedule';
    const visible = new Set(S.data.employees.map((e) => e.id));
    SCHED.selected = new Set([...SCHED.selected].filter((id) => visible.has(id)));
  }
  renderScheduleGrid();
}

function renderScheduleGrid() {
  const { days, schedule } = S.data;
  const emps = visibleEmployees();
  const month = S.view.mode === 'month';
  const dayTot = Object.fromEntries(days.map((d) => [d, { n: 0, h: 0 }]));
  const body = emps.map((e) => {
    let tot = 0;
    const cells = days.map((d) => {
      const sh = schedule[e.id]?.[d];
      if (sh && !sh.off) { tot += sh.hours; dayTot[d].n++; dayTot[d].h += sh.hours; }
      const tip = sh ? (sh.off ? 'Day off' : `${SP().label(sh)} · ${fmtH(sh.hours)}h${sh.break_minutes ? `, ${sh.break_minutes} min break` : ''}`) + (sh.source === 'override' ? '\nOne-off change' + (sh.note ? ': ' + sh.note : '') : '\nWeekly pattern') : 'No schedule';
      return `<td class="cell ${dayCls(d)}" data-e="${e.id}" data-d="${d}" title="${esc(tip)}">${sh?.source === 'override' ? '<span class="dot"></span>' : ''}${shiftCell(sh, month)}</td>`;
    }).join('');
    return `<tr><td class="selcol"><input type="checkbox" data-sel="${e.id}" ${SCHED.selected.has(e.id) ? 'checked' : ''}></td>
      <td class="emp emp-link" data-emp="${e.id}" title="Set weekly schedule">${esc(e.last_name)}, ${esc(e.first_name)}<small>${esc(e.employee_id)} · ${esc(e.campaign_code || '—')}${e.modality ? ' · ' + esc(e.modality) : ''}</small></td>
      ${cells}<td class="tot">${fmtH(tot)}</td></tr>`;
  }).join('');
  const allSel = emps.length && emps.every((e) => SCHED.selected.has(e.id));
  $('#grid').innerHTML = emps.length ? `<table class="matrix ${month ? 'month' : ''}">
    <thead><tr><th class="selcol"><input type="checkbox" id="sel-all" ${allSel ? 'checked' : ''} title="Select all"></th><th class="emp">Agent (${emps.length})</th>${days.map((d) => dayHeader(d)).join('')}<th>Sched. hrs</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td class="selcol"></td><td class="emp">Agents scheduled</td>${days.map((d) => `<td class="${dayCls(d)}" title="${fmtH(dayTot[d].h)} scheduled hours">${dayTot[d].n || ''}</td>`).join('')}<td>${fmtH(Object.values(dayTot).reduce((a, b) => a + b.h, 0))}</td></tr></tfoot></table>`
    : '<p class="muted" style="padding:20px">No agents in this view.</p>';
  $('#sc-selinfo').textContent = SCHED.selected.size ? `${SCHED.selected.size} agent(s) selected` : '';
  $$('#grid [data-sel]').forEach((cb) => cb.onchange = () => { cb.checked ? SCHED.selected.add(Number(cb.dataset.sel)) : SCHED.selected.delete(Number(cb.dataset.sel)); renderScheduleGrid(); });
  if ($('#sel-all')) $('#sel-all').onchange = (ev) => { emps.forEach((e) => (ev.target.checked ? SCHED.selected.add(e.id) : SCHED.selected.delete(e.id))); renderScheduleGrid(); };
  $$('#grid .emp-link').forEach((td) => td.onclick = () => openWeeklyModal([Number(td.dataset.emp)]));
  $$('#grid td.cell').forEach((td) => td.onclick = () => openShiftPop(td, Number(td.dataset.e), td.dataset.d));
}

// ------------------------------------------------------------------ single cell editor
function openShiftPop(td, empId, day) {
  closeLayers();
  const emp = S.data.employees.find((x) => x.id === empId);
  const cur = S.data.schedule[empId]?.[day];
  const dowName = DOW_LONG[dow(day)];
  const pop = document.createElement('div');
  pop.className = 'pop'; pop.style.width = '300px';
  pop.innerHTML = `<div style="font-weight:600">${esc(emp.first_name)} ${esc(emp.last_name)}</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">${prettyDate(day)}${cur ? ` · ${cur.source === 'override' ? 'one-off change' : 'weekly pattern'}` : ' · no schedule'}</div>
    <input type="text" id="sp-in" value="${esc(SP().toText(cur))}" placeholder="8-5, 5a-3p, 22-6, off…" style="width:100%" autocomplete="off">
    <div id="sp-prev" class="sched-prev"></div>
    <input type="text" id="sp-note" placeholder="Note (optional, e.g. shift swap)" style="width:100%;margin:6px 0" value="${esc(cur?.note || '')}">
    <div class="sp-btns">
      <button class="btn sm primary" data-a="day" title="Enter">This day only</button>
      <button class="btn sm" data-a="week" title="Shift+Enter">Every ${dowName} from here</button>
      ${cur?.source === 'override' ? '<button class="btn sm" data-a="revert">Undo one-off change</button>' : ''}
    </div>
    <div class="muted" style="font-size:11px;margin-top:6px">Enter = this day only · Shift+Enter = every ${dowName}</div>`;
  document.body.appendChild(pop);
  const r = td.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 315)) + 'px';
  pop.style.top = (r.bottom + 240 > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 4) : r.bottom + 4) + 'px';
  const input = $('#sp-in', pop);
  const preview = () => {
    const p = SP().parseShift(input.value);
    $('#sp-prev', pop).innerHTML = p.empty ? '<span class="muted">Type a shift, or "off"</span>' : p.error ? `<span class="err">${esc(p.error)}</span>`
      : p.off ? '<b>Day off</b>' : `<b>${esc(SP().label(p))}</b> · ${fmtH(p.hours)}h${p.break_minutes ? ` (after ${p.break_minutes} min break)` : ''}${p.overnight ? ' · overnight' : ''}`;
    return p;
  };
  input.oninput = preview; preview();
  input.focus(); input.select();
  const act = guard(async (a) => {
    if (a === 'revert') { await api('POST', '/api/schedules/days', { entries: [{ employee_id: empId, work_date: day, shift: null }] }); closeLayers(); return; }
    const p = preview();
    if (p.error || p.empty) return toast(p.error || 'Type a shift first', true);
    const shift = p.off ? { off: true } : { start: p.start, end: p.end, break_minutes: p.break_minutes };
    if (a === 'day') await api('POST', '/api/schedules/days', { entries: [{ employee_id: empId, work_date: day, shift, note: $('#sp-note', pop).value }] });
    else {
      // Change one weekday in the weekly pattern, effective from this date.
      const base = S.data.templates[empId]?.days || {};
      const days = {}; for (let d = 0; d < 7; d++) days[d] = base[d] ?? null;
      days[dow(day)] = shift;
      await api('POST', '/api/schedules/templates', { effective_from: day, items: [{ employee_id: empId, days }] });
    }
    closeLayers();
  });
  $$('[data-a]', pop).forEach((b) => b.onclick = () => act(b.dataset.a));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); act(e.shiftKey ? 'week' : 'day'); } });
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off); } }), 0);
}

// ------------------------------------------------------------------ weekly pattern editor
function openWeeklyModal(empIds) {
  closeLayers();
  const emps = empIds.map((id) => S.data.employees.find((e) => e.id === id)).filter(Boolean);
  const first = S.data.templates[emps[0].id];
  const same = emps.every((e) => JSON.stringify(S.data.templates[e.id]?.days || null) === JSON.stringify(first?.days || null));
  const start = currentRange().from;
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.onclick = closeLayers;
  const md = document.createElement('div'); md.className = 'modal'; md.style.width = 'min(640px, calc(100vw - 32px))';
  md.innerHTML = `<div class="head-row"><div><h2>Weekly schedule</h2><div class="muted">${emps.length === 1 ? esc(`${emps[0].first_name} ${emps[0].last_name} · ${emps[0].employee_id}`) : `${emps.length} agents: ${esc(emps.slice(0, 4).map((e) => e.first_name + ' ' + e.last_name).join(', '))}${emps.length > 4 ? '…' : ''}`}</div>
      ${first && same ? `<div class="muted" style="font-size:12px">Current pattern since ${esc(first.effective_from)}</div>` : emps.length > 1 && !same ? '<div class="muted" style="font-size:12px">These agents currently have different patterns; saving gives them all the one below.</div>' : ''}</div><button class="x">×</button></div>
    <label class="f">Quick entry: describe the whole week in one line
      <input type="text" id="wk-pattern" placeholder="Mon-Fri 8a-5p; Sat 9-1; Sun off   ·   Mon 5-3, Tue 8-5, Wed-Fri 9-6 30m" autocomplete="off"></label>
    <div id="wk-pattern-err" class="err" style="font-size:12px;margin-top:4px"></div>
    <table class="wk-table"><tbody>${weekOrder().map((d) => `<tr><th>${DOW_LONG[d]}</th>
      <td><input type="text" data-dow="${d}" value="${esc(same && first ? SP().toText(first.days[d]) : '')}" placeholder="off" autocomplete="off"></td><td class="wk-prev" data-prev="${d}"></td></tr>`).join('')}</tbody>
      <tfoot><tr><th>Total</th><td></td><td id="wk-total" class="wk-prev"></td></tr></tfoot></table>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <button class="btn sm" id="wk-copy">Copy ${DOW_LONG[weekOrder()[0] === 0 ? 1 : weekOrder()[0]]} to the other weekdays</button>
      <button class="btn sm" id="wk-clear">Clear all</button>
    </div>
    <div class="grid2">
      <label class="f">Effective from<input type="date" id="wk-from" value="${start}"></label>
      <label class="chk" style="align-self:end;margin-bottom:6px"><input type="checkbox" id="wk-clear-ovr"> Also remove one-off changes from this date on</label>
    </div>
    <p class="muted" style="font-size:12px">Blank days are days off. The pattern repeats every week from the effective date until you change it; earlier weeks keep their old schedule.</p>
    <div style="text-align:right"><button class="btn" id="wk-cancel">Cancel</button> <button class="btn primary" id="wk-save">Save schedule</button></div>`;
  document.body.append(ov, md);
  const inputs = $$('[data-dow]', md);
  const parsed = () => Object.fromEntries(inputs.map((i) => [i.dataset.dow, i.value.trim() ? SP().parseShift(i.value) : { off: true, hours: 0 }]));
  const refresh = () => {
    const p = parsed(); let tot = 0, days = 0;
    for (const [d, x] of Object.entries(p)) {
      const cell = $(`[data-prev="${d}"]`, md);
      if (x.error) { cell.innerHTML = `<span class="err">${esc(x.error)}</span>`; continue; }
      if (x.off) { cell.innerHTML = '<span class="muted">Off</span>'; continue; }
      tot += x.hours; days++;
      cell.innerHTML = `<b>${esc(SP().label(x))}</b> · ${fmtH(x.hours)}h${x.overnight ? ' · overnight' : ''}`;
    }
    $('#wk-total', md).innerHTML = `<b>${fmtH(tot)}h</b> over ${days} day(s)`;
  };
  inputs.forEach((i) => i.oninput = refresh); refresh();
  $('#wk-pattern', md).oninput = (e) => {
    if (!e.target.value.trim()) { $('#wk-pattern-err', md).textContent = ''; return; }
    const w = SP().parseWeek(e.target.value);
    inputs.forEach((i) => { i.value = SP().toText(w.days[i.dataset.dow]); });
    $('#wk-pattern-err', md).textContent = w.errors.join(' · ');
    refresh();
  };
  $('#wk-copy', md).onclick = () => {
    const src = inputs.find((i) => i.dataset.dow === '1');
    inputs.filter((i) => ['2', '3', '4', '5'].includes(i.dataset.dow)).forEach((i) => { i.value = src.value; });
    refresh();
  };
  $('#wk-clear', md).onclick = () => { inputs.forEach((i) => { i.value = ''; }); refresh(); };
  $('.x', md).onclick = closeLayers; $('#wk-cancel', md).onclick = closeLayers;
  $('#wk-save', md).onclick = guard(async () => {
    const p = parsed();
    const bad = Object.entries(p).find(([, x]) => x.error);
    if (bad) return toast(`${DOW_LONG[bad[0]]}: ${bad[1].error}`, true);
    const days = {};
    for (const [d, x] of Object.entries(p)) days[d] = x.off ? { off: true } : { start: x.start, end: x.end, break_minutes: x.break_minutes };
    const r = await api('POST', '/api/schedules/templates', { effective_from: $('#wk-from', md).value, clear_overrides: $('#wk-clear-ovr', md).checked, items: emps.map((e) => ({ employee_id: e.id, days })) });
    toast(`Schedule saved for ${r.applied} agent(s)` + (r.errors.length ? `, ${r.errors.length} failed` : ''), !!r.errors.length);
    closeLayers();
  });
  $('#wk-pattern', md).focus();
}

// ------------------------------------------------------------------ paste from Excel
const DAY_HEAD = { sun: 0, sunday: 0, dom: 0, domingo: 0, mon: 1, monday: 1, lun: 1, lunes: 1, tue: 2, tuesday: 2, mar: 2, martes: 2, wed: 3, wednesday: 3, mie: 3, mié: 3, miercoles: 3, miércoles: 3, thu: 4, thursday: 4, jue: 4, jueves: 4, fri: 5, friday: 5, vie: 5, viernes: 5, sat: 6, saturday: 6, sab: 6, sáb: 6, sabado: 6, sábado: 6 };
function parsePasted(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!lines.length) return { rows: [], note: '' };
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const grid = lines.map((l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, '')));
  const head = grid[0].map((h) => h.toLowerCase().replace(/[^a-záéíóú]/g, ''));
  let idCol = 0, dayCols = {}, start = 0, note;
  if (head.filter((h) => DAY_HEAD[h] != null).length >= 2) {
    head.forEach((h, i) => { if (DAY_HEAD[h] != null) dayCols[DAY_HEAD[h]] = i; });
    const idx = head.findIndex((h) => /id|employee|empleado|codigo|código/.test(h));
    idCol = idx >= 0 ? idx : 0; start = 1;
    note = 'Columns matched by the day names in your header row.';
  } else {
    // No header: Employee ID, [Name], Mon … Sun
    const nameCol = grid[0].length >= 9 && SP().parseShift(grid[0][1]).error;
    const off = nameCol ? 2 : 1;
    [1, 2, 3, 4, 5, 6, 0].forEach((d, i) => { dayCols[d] = off + i; });
    note = `No header row found, so columns were read as: Employee ID, ${nameCol ? 'Name, ' : ''}Mon, Tue, Wed, Thu, Fri, Sat, Sun.`;
  }
  const rows = grid.slice(start).map((cells) => {
    const days = {}; const errors = [];
    for (const [d, c] of Object.entries(dayCols)) {
      const v = cells[c] ?? '';
      const p = v ? SP().parseShift(v) : { off: true, hours: 0 };
      if (p.error) errors.push(`${DOW_LONG[d].slice(0, 3)}: "${v}"`);
      days[d] = p;
    }
    return { code: cells[idCol], days, errors };
  }).filter((r) => r.code);
  return { rows, note };
}
function openPasteModal() {
  closeLayers();
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.onclick = closeLayers;
  const md = document.createElement('div'); md.className = 'modal'; md.style.width = 'min(1000px, calc(100vw - 32px))';
  md.innerHTML = `<div class="head-row"><h2>Paste schedules from Excel</h2><button class="x">×</button></div>
    <p class="muted" style="margin-top:0">Copy a block of cells from Excel and paste it below: one row per agent with the <b>Employee ID</b> and one column per day.
    Any shift format works (<code>8-5</code>, <code>5a-3p</code>, <code>08:00-17:00</code>, <code>off</code>…). A header row with day names (Mon/Lunes…) is optional.</p>
    <textarea id="pa-text" style="min-height:140px;font-family:monospace;font-size:12px" placeholder="E1001&#9;5-3&#9;8-5&#9;9-6&#9;9-6&#9;9-6&#9;off&#9;off"></textarea>
    <div class="muted" id="pa-note" style="font-size:12px;margin:6px 0"></div>
    <div class="table-wrap" id="pa-prev" style="max-height:300px"></div>
    <div class="grid2" style="margin-top:10px"><label class="f">Effective from<input type="date" id="pa-from" value="${currentRange().from}"></label>
      <label class="chk" style="align-self:end;margin-bottom:6px"><input type="checkbox" id="pa-clear-ovr"> Also remove one-off changes from this date on</label></div>
    <div style="text-align:right;margin-top:10px"><button class="btn" id="pa-cancel">Cancel</button> <button class="btn primary" id="pa-save" disabled>Import</button></div>`;
  document.body.append(ov, md);
  let data = { rows: [] };
  const byCode = Object.fromEntries(S.data.employees.map((e) => [e.employee_id.toUpperCase(), e]));
  $('#pa-text', md).oninput = (e) => {
    data = parsePasted(e.target.value);
    $('#pa-note', md).textContent = data.rows.length ? `${data.rows.length} row(s). ${data.note}` : '';
    const order = weekOrder();
    $('#pa-prev', md).innerHTML = data.rows.length ? `<table><thead><tr><th>Employee</th>${order.map((d) => `<th>${DOW_LONG[d].slice(0, 3)}</th>`).join('')}<th class="num">Hours</th><th></th></tr></thead><tbody>
      ${data.rows.map((r) => {
        const emp = byCode[r.code.toUpperCase()];
        const tot = Object.values(r.days).reduce((a, x) => a + (x.hours || 0), 0);
        return `<tr><td><b>${esc(r.code)}</b> ${emp ? esc(emp.first_name + ' ' + emp.last_name) : '<span class="muted">(not in current view)</span>'}</td>
          ${order.map((d) => { const x = r.days[d]; return `<td class="${x?.error ? 'err' : ''}">${x ? (x.error ? '⚠' : esc(SP().label(x))) : ''}</td>`; }).join('')}
          <td class="num">${fmtH(tot)}</td><td class="err" style="font-size:12px">${esc(r.errors.join(', '))}</td></tr>`;
      }).join('')}</tbody></table>` : '';
    $('#pa-save', md).disabled = !data.rows.length;
  };
  $('.x', md).onclick = closeLayers; $('#pa-cancel', md).onclick = closeLayers;
  $('#pa-save', md).onclick = guard(async () => {
    const bad = data.rows.filter((r) => r.errors.length);
    if (bad.length && !confirm(`${bad.length} row(s) have shifts that couldn't be read and will be skipped. Continue?`)) return;
    const items = data.rows.filter((r) => !r.errors.length).map((r) => ({
      employee_code: r.code,
      days: Object.fromEntries(Object.entries(r.days).map(([d, x]) => [d, x.off ? { off: true } : { start: x.start, end: x.end, break_minutes: x.break_minutes }])),
    }));
    if (!items.length) return;
    const res = await api('POST', '/api/schedules/templates', { effective_from: $('#pa-from', md).value, clear_overrides: $('#pa-clear-ovr', md).checked, items });
    alert(`Imported schedules for ${res.applied} agent(s).${res.errors.length ? `\n\n${res.errors.length} failed:\n` + res.errors.slice(0, 15).map((e) => `${e.employee}: ${e.error}`).join('\n') : ''}`);
    closeLayers();
  });
  $('#pa-text', md).focus();
}

function exportScheduleCsv() {
  const { days, schedule } = S.data;
  const q = (s) => { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [['Employee ID', 'Last name', 'First name', 'Campaign', 'Modality', ...days, 'Scheduled hours'].map(q).join(',')];
  for (const e of visibleEmployees()) {
    let tot = 0;
    const cells = days.map((d) => { const sh = schedule[e.id]?.[d]; if (sh && !sh.off) tot += sh.hours; return sh ? SP().toText(sh) : ''; });
    lines.push([e.employee_id, e.last_name, e.first_name, e.campaign_code, e.modality, ...cells, fmtH(tot)].map(q).join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
  a.download = `tempo-schedules-${days[0]}-to-${days[days.length - 1]}.csv`; a.click(); URL.revokeObjectURL(a.href);
}
