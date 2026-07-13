import { jsPDF } from 'jspdf';

/**
 * Patient Statement PDF engine.
 *
 * Reproduces the enterprise statement layout pixel-for-pixel (US-Letter,
 * 612x792pt). Every office, patient, monetary and identity field is driven in
 * real time from the uploaded statement rows — there is no hardcoded or mock
 * address data anywhere in the engine.
 *
 * Rules implemented:
 *  - Every Date-Of-Service (DOS) line for the same patient is collected into a
 *    single multi-page statement.
 *  - Each page carries the full statement chrome (brand bar, payment banner,
 *    statement summary, remit-to, patient address, account summary and the
 *    detailed-information header) plus its share of detailed DOS rows.
 */

// Exactly five DOS line-items per page on EVERY page — page 1 included.
// Pagination is COUNT-based, so page 1 = DOS 1–5, page 2 = 6–10, … with no
// repeats and no short first page. Five rows leave enough room for comfortable,
// clearly-readable spacing beneath the full first-page chrome.
export const ROWS_PER_PAGE = 5;
export const FIRST_PAGE_ROWS = ROWS_PER_PAGE;
export const CONT_PAGE_ROWS = ROWS_PER_PAGE;
export const LINES_PER_PAGE = ROWS_PER_PAGE; // back-compat alias

/* Template fallbacks — used when a field is absent from the uploaded data. */
/* Empty office/provider context — used for the blank structural template, which
   carries no real practice data. Real statements populate this from the uploaded
   file only; there is no hardcoded/mock address anywhere. */
const EMPTY_PROVIDER = { officeName: '', address: '', city: '', state: '', zip: '', phone: '' };

/* ------------------------------------------------------------------ helpers */

const s = (v) => (v == null ? '' : String(v)).trim();

/** Parse a currency-ish string ("$1,234.50", "(45.00)") into a number. */
function num(v) {
  if (v == null || v === '') return 0;
  let str = String(v).trim();
  let neg = false;
  if (/^\(.*\)$/.test(str)) {
    neg = true;
    str = str.slice(1, -1);
  }
  str = str.replace(/[^0-9.\-]/g, '');
  const n = parseFloat(str);
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}

function money(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Format any date-ish value as mm/dd/yyyy; unrecognised values pass through. */
function mdy(v) {
  const str = s(v);
  if (!str) return '';
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);       // ISO: YYYY-MM-DD[...]
  if (m) return `${pad2(m[2])}/${pad2(m[3])}/${m[1]}`;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);         // already M/D/YYYY
  if (m) return `${pad2(m[1])}/${pad2(m[2])}/${m[3]}`;
  const d = new Date(str);
  if (!isNaN(d)) return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  return str;
}

const first = (row, keys) => {
  for (const k of keys) {
    const val = s(row[k]);
    if (val) return val;
  }
  return '';
};

/**
 * Lay out one DOS as an ordered list of description lines exactly like the
 * reference statement, and measure its height. Lines are only emitted for data
 * that exists, so a DOS with no payment/adjustment is shorter than one with both.
 *
 * Line sequence (top → bottom):
 *   PATIENT: <name>  - <account>
 *   PROVIDER: <provider>   CPT: <cpt>
 *   <procedure>                       (carries the DOS date + Charges)
 *   Payment - <payer>                 (if an insurance payment exists)
 *   Adjustment - <payer>              (if an insurance adjustment exists)
 *   <balance-applied-to message>      (if present)
 *   Balance Amount                    (carries the Patient Balance)
 */
function layoutDosRow(r) {
  const seq = ['patient', 'provider', 'service'];
  const hasPmt = num(r.insurancePayment) !== 0 || !!s(r.paymentDate);
  const hasAdj = num(r.adjustment) !== 0 || !!s(r.adjustmentDate);
  if (hasPmt) seq.push('payment');
  if (hasAdj) seq.push('adjustment');
  if (s(r.balanceAppliedTo)) seq.push('message');
  seq.push('balance');

  const lines = [];
  let y = ROW_PAD_TOP;
  seq.forEach((type) => {
    if (type === 'balance') y += ROW_GAP_BALANCE;
    lines.push({ type, y });
    y += LINE_H;
  });
  const height = lines[lines.length - 1].y + ROW_PAD_BOTTOM;
  return { row: r, lines, height };
}

/**
 * Pack laid-out DOS rows into pages of exactly ROWS_PER_PAGE (6) rows — page 1
 * included. Pagination is count-based, so every page carries six DOS (the last
 * page carries the remainder). Page 1 starts lower (it carries the statement
 * chrome); continuation pages start near the top. Returns an array of pages,
 * each an array of { row, lines, height, rowTop }.
 */
function paginateRows(rowInfos) {
  const pages = [];
  for (let i = 0; i < rowInfos.length; i += ROWS_PER_PAGE) {
    const chunk = rowInfos.slice(i, i + ROWS_PER_PAGE);
    let y = pages.length === 0 ? FIRST_PAGE_ROW_TOP : CONT_ROW_TOP;
    pages.push(
      chunk.map((info) => {
        const item = { ...info, rowTop: y };
        y += info.height;
        return item;
      })
    );
  }
  return pages;
}

/**
 * Group parsed rows into per-patient statements. Rows are keyed by account
 * number when present, otherwise by patient name, so every DOS for one patient
 * lands in one statement.
 */
export function groupStatements(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const account = s(row.accountNumber);
    const name = s(row.patientName);
    if (!account && !name) return; // skip empty / non-patient rows
    const key = (account || name).toLowerCase();
    if (!map.has(key)) {
      map.set(key, { key, patientName: name, accountNumber: account, rows: [] });
    }
    const g = map.get(key);
    if (!g.patientName && name) g.patientName = name;
    if (!g.accountNumber && account) g.accountNumber = account;
    g.rows.push(row);
  });

  return Array.from(map.values()).map((g) => {
    const totalCharges = g.rows.reduce((t, r) => t + num(r.charge), 0);
    const insurancePayments = g.rows.reduce((t, r) => t + num(r.insurancePayment), 0);
    const insuranceAdjustments = g.rows.reduce((t, r) => t + num(r.adjustment), 0);
    const insurancePaid = insurancePayments + insuranceAdjustments;
    const patientPaid = g.rows.reduce((t, r) => t + num(r.lastPaidAmount), 0);
    // Prefer explicit patient balance; fall back to charges - payments.
    const explicitDue = g.rows.reduce(
      (t, r) => t + num(r.totalAmountDue || r.patientResponsibility),
      0
    );
    const amountDue = explicitDue || totalCharges - insurancePaid - patientPaid;
    // Height-aware pagination: pack variable-height DOS rows into pages.
    const pagesRows = paginateRows(g.rows.map((r) => layoutDosRow(r)));
    return {
      ...g,
      dosCount: g.rows.length,
      pages: pagesRows.length,
      pagesRows,
      summary: {
        totalCharges,
        insurancePayments,
        insuranceAdjustments,
        insurancePaid,
        patientPaid,
        amountDue,
        patientResponsibility: amountDue,
      },
    };
  });
}

/* ------------------------------------------------------- low-level drawing */

function line(doc, x1, y1, x2, y2, w = 0.7) {
  doc.setLineWidth(w);
  doc.line(x1, y1, x2, y2);
}
function rect(doc, x, y, w, h, lw = 0.7) {
  doc.setLineWidth(lw);
  doc.rect(x, y, w, h);
}

/* Enterprise palette (RGB) — sampled from the reference statement. */
const C = {
  navy: [26, 58, 92], // #1A3A5C — header bars
  navyDark: [15, 39, 68], // #0F2744 — patient-balance accent header
  slate: [45, 63, 85], // #2D3F55 — "Pay Promptly" banner
  panel: [240, 244, 248], // #F0F4F8 — content panels
  panel2: [250, 251, 253], // #FAFBFD — table value rows
  pink: [255, 245, 245], // #FFF5F5 — red-value backgrounds
  border: [214, 221, 230],
  label: [110, 125, 145], // muted slate labels
  text: [26, 58, 92],
  green: [22, 122, 77], // payment green
  red: [185, 28, 28], // #B91C1C — responsibility / alerts
  white: [255, 255, 255],
  black: [17, 17, 17], // #111111 — strong near-black body text
};

/* Monochrome palette for the "completely blank & white" statement: every fill
   becomes white and every mark (text, rules, borders) becomes black. Structural
   blocks that relied on a dark fill for definition get a black outline instead
   (see the `outline()` helper in drawPage). */
const MONO = {
  navy: C.white, navyDark: C.white, slate: C.white, panel: C.white, panel2: C.white, pink: C.white,
  border: C.black, label: C.black, text: C.black, green: C.black, red: C.black,
  white: C.black, black: C.black,
};

function fillRect(doc, x, y, w, h, rgb) {
  doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  doc.rect(x, y, w, h, 'F');
}
function txt(doc, str, x, y, { size = 8, bold = false, align = 'left', color } = {}) {
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setFontSize(size);
  if (color) doc.setTextColor(color[0], color[1], color[2]);
  doc.text(s(str), x, y, { align });
  if (color) doc.setTextColor(0, 0, 0);
}

/** Measure a string's width (pt) at a given size/weight. */
function width(doc, str, size, bold = false) {
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setFontSize(size);
  return doc.getTextWidth(s(str));
}

/** Truncate a string with an ellipsis so it never exceeds maxW at the given font. */
function fit(doc, str, maxW, size, bold = false) {
  str = s(str);
  if (maxW <= 0) return '';
  if (width(doc, str, size, bold) <= maxW) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(doc, str.slice(0, mid) + '…', size, bold) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo).trimEnd() + '…';
}

/** Small outlined envelope glyph for the payment banner (white stroke, black in mono). */
function envelope(doc, x, y, w, h, mono = false) {
  if (mono) doc.setDrawColor(0, 0, 0); else doc.setDrawColor(255, 255, 255);
  doc.setLineWidth(1.1);
  doc.rect(x, y, w, h);
  doc.line(x, y, x + w / 2, y + h * 0.58);
  doc.line(x + w, y, x + w / 2, y + h * 0.58);
  doc.setDrawColor(0, 0, 0);
}

/* ---- Reference layout geometry (US-Letter 612x792, coords from top) ---- */
const PW = 612;
const ML = 22; // outer left margin
const MR = 590; // outer right margin

/* Detailed-information table column edges (x), left→right. */
const DCOL = {
  left: 23,
  dateR: 90, // Date | Service Description
  descR: 305, // Service Description | Ins Message
  insR: 380, // Ins Message | Charges
  chgR: 447, // Charges | Payments & Adjustments
  payR: 521.1, // Payments & Adjustments | Patient Balance
  right: 589,
};
/* Variable-height DOS row metrics (see layoutDosRow). Each DOS renders as a
   multi-line line-item exactly like the reference statement, so its height grows
   with the number of payment / adjustment / message lines present. */
// Sized so five DOS rows (each up to seven description lines) fit beneath the
// full page-1 chrome with comfortable spacing: 5 × max-row-height (65) = 325 ≤
// page-1 band (400→736 = 336).
const LINE_H = 8; // vertical step between description lines
const ROW_PAD_TOP = 9; // first line baseline offset from the row top
const ROW_GAP_BALANCE = 3; // extra gap before the "Balance Amount" line
const ROW_PAD_BOTTOM = 5; // padding below the last line to the row border
const FIRST_PAGE_ROW_TOP = 400; // detailHdrTop(356) + band(20) + colHdr(24)
const CONT_ROW_TOP = 74; // detailHdrTop(30) + band(20) + colHdr(24)
const ROWS_BOTTOM = 736; // rows must end above here so the footer fits
const FOOTER_MIN_TOP = 738; // footer pinned near the page bottom on every page

/** Header band: filled bar + left-aligned title. In mono the bar is white with a
    black outline and black title. Returns bottom Y. */
function bandHeader(doc, x, y, w, label, { h = 19.9, size = 9, pad = 10, pal = C, mono = false } = {}) {
  fillRect(doc, x, y, w, h, pal.navy);
  if (mono) { doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.8); doc.rect(x, y, w, h); doc.setLineWidth(0.7); doc.setDrawColor(0, 0, 0); }
  txt(doc, label, x + pad, y + h - 6.5, { size, bold: true, color: pal.white });
  return y + h;
}
const dash = (v) => (v ? v : '—');

/**
 * Draw one statement page: the full statement chrome (repeated on every page)
 * plus this page's slice of detailed DOS rows. Blank mode renders chrome only.
 */
function drawPage(doc, stmt, pageRows, pageIndex, provider, patient) {
  const centre = (a, b) => (a + b) / 2;
  const blank = !!stmt.blank;
  const mono = !!stmt.mono; // monochrome "blank & white" mode
  const P = mono ? MONO : C; // active palette
  const val = (v) => (blank ? '' : v); // suppress data in template mode
  const isFirst = pageIndex === 0; // full chrome only on page 1

  // In mono, white-filled structural blocks need a black outline to stay visible.
  const outline = (x, y, w, h, lw = 0.8) => {
    if (!mono) return;
    doc.setDrawColor(0, 0, 0); doc.setLineWidth(lw); doc.rect(x, y, w, h);
    doc.setLineWidth(0.7); doc.setDrawColor(0, 0, 0);
  };

  /* 1 — Master brand bar (first page only). Continuation pages carry the
     DETAILED INFORMATION table alone, so they skip the brand chrome entirely. */
  // Compose the office's single-line address from only the parts that are present,
  // so a missing field never leaves a stray comma or blank segment.
  const cityStateZip = [s(provider.city), [s(provider.state), s(provider.zip)].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  const officeAddrLine = [s(provider.address), cityStateZip].filter(Boolean).join(', ');
  if (isFirst) {
    fillRect(doc, 0, 0, PW, 27, P.navy);
    outline(0, 0, PW, 27);
    txt(doc, s(provider.officeName).toUpperCase(), 16, 17.5, { size: 11, bold: true, color: P.white });
    if (officeAddrLine) txt(doc, officeAddrLine, MR, 11.5, { size: 6.5, align: 'right', color: P.white });
    const telLine = provider.phone
      ? `Tel: ${s(provider.phone)}  |  Billing Hours: 10am - 2pm`
      : 'Billing Hours: 10am - 2pm';
    txt(doc, telLine, MR, 20.5, { size: 6.5, align: 'right', color: P.white });
  }

  /* Column rails — both columns share one baseline so the frame stays square. */
  const LX = 22, LW = 356, LR = LX + LW;      // left column (22..378)
  const RX = 391, RW = 198, RR = RX + RW;     // right column (391..589)
  const CHROME_TOP = 42;                      // top of the two-column band
  const CHROME_BOTTOM = 238;                  // shared bottom edge of both columns

  /* Sections 2–6 (payment banner, summary, remit-to, patient, account summary)
     appear on the first page only; continuation pages carry the detail table. */
  if (isFirst) {

  /* 2 — "Pay Promptly" banner (left) */
  fillRect(doc, LX, CHROME_TOP, LW, 34, P.slate);
  outline(LX, CHROME_TOP, LW, 34);
  doc.setDrawColor(mono ? 0 : 90, mono ? 0 : 105, mono ? 0 : 125); doc.setLineWidth(0.5);
  doc.rect(LX + 4, CHROME_TOP + 4, LW - 8, 26); doc.setDrawColor(0, 0, 0);
  txt(doc, 'Pay Promptly', LX + 13, CHROME_TOP + 20, { size: 14, bold: true, color: P.white });
  txt(doc, 'Make your payment today.', LX + 14, CHROME_TOP + 30, { size: 7.5, color: P.white });
  doc.setDrawColor(mono ? 0 : 120, mono ? 0 : 132, mono ? 0 : 150); line(doc, LX + LW - 74, CHROME_TOP + 6, LX + LW - 74, CHROME_TOP + 28, 0.5); doc.setDrawColor(0, 0, 0);
  envelope(doc, LX + LW - 62, CHROME_TOP + 8, 34, 18, mono);

  /* 3 — Statement summary card (right). Rows fill the card so it never leaves a gap. */
  bandHeader(doc, RX, CHROME_TOP, RW, 'STATEMENT SUMMARY', { h: 16, size: 8.5, pad: (RW - doc.getTextWidth('STATEMENT SUMMARY')) / 2, pal: P, mono });
  const sumRows = [
    ['Total Charges Billed', money(stmt.summary.totalCharges), P.text, false],
    ['Total Insurance Payments', money(stmt.summary.insurancePayments), P.green, false],
    ['Total Insurance Adjustments', money(stmt.summary.insuranceAdjustments), P.text, false],
    ['Total Patient Paid', money(stmt.summary.patientPaid), P.green, false],
    ['Total Patient Responsibility', money(stmt.summary.patientResponsibility), P.red, true],
  ];
  const sHdrBot = CHROME_TOP + 16;
  const sRowH = (CHROME_BOTTOM - sHdrBot) / sumRows.length;
  let sy = sHdrBot;
  sumRows.forEach((row, ri) => {
    fillRect(doc, RX, sy, RW, sRowH, row[3] ? P.pink : P.panel);
    if (ri > 0) { doc.setDrawColor(P.border[0], P.border[1], P.border[2]); line(doc, RX, sy, RR, sy, 0.4); doc.setDrawColor(0, 0, 0); }
    const yb = sy + sRowH / 2 + 3;
    txt(doc, row[0], RX + 9, yb, { size: 7.5, bold: true, color: row[3] ? P.red : P.text });
    if (!blank) txt(doc, row[1], RR - 9, yb, { size: 8.5, bold: true, align: 'right', color: row[2] });
    sy += sRowH;
  });
  doc.setDrawColor(P.border[0], P.border[1], P.border[2]);
  doc.rect(RX, CHROME_TOP, RW, CHROME_BOTTOM - CHROME_TOP); doc.setDrawColor(0, 0, 0);

  /* 4 — Remit-to block (left) */
  let by = bandHeader(doc, LX, 84, LW, 'PLEASE MAKE CHECKS PAYABLE AND REMIT TO', { h: 15, size: 8, pal: P, mono });
  fillRect(doc, LX, by, LW, 66, P.panel); // 99 → 165
  outline(LX, by, LW, 66);
  txt(doc, s(provider.officeName), LX + 10, by + 16, { size: 10.5, bold: true, color: P.text });
  if (provider.address) txt(doc, s(provider.address), LX + 10, by + 30, { size: 9.5, bold: true, color: P.black });
  if (cityStateZip) txt(doc, cityStateZip, LX + 10, by + 43, { size: 9.5, bold: true, color: P.black });
  doc.setDrawColor(P.border[0], P.border[1], P.border[2]); line(doc, LX + 10, by + 47, LR - 10, by + 47, 0.5); doc.setDrawColor(0, 0, 0);
  txt(doc, 'Any questions please call between the hours of 10am', LX + 10, by + 56, { size: 8, bold: true, color: P.text });
  txt(doc, provider.phone ? `and 2pm at ${s(provider.phone)}` : 'and 2pm.', LX + 10, by + 64, { size: 8, bold: true, color: P.text });

  /* 5 — Patient address block (left) */
  by = bandHeader(doc, LX, 171, LW, 'PATIENT ADDRESS', { h: 15, size: 8, pal: P, mono }); // panel 186 → 238
  fillRect(doc, LX, by, LW, CHROME_BOTTOM - by, P.panel);
  outline(LX, by, LW, CHROME_BOTTOM - by);
  txt(doc, 'PATIENT NAME', LX + 10, by + 12, { size: 6.5, bold: true, color: P.label });
  txt(doc, val(patient.patientName), LX + 10, by + 24, { size: 10.5, bold: true, color: P.text });
  txt(doc, 'PATIENT ADDRESS', LX + 10, by + 34, { size: 6.5, bold: true, color: P.label });
  // Patient address on two lines: street (line 1) then City, State ZIP+4 (line 2).
  // If the street line is missing, the city/state/ZIP promotes to the first line so
  // no blank gap is left. Both lines fit within the panel (bottom edge = 238).
  const addrL1 = val(patient.address1) || val(patient.cityStateZip);
  const addrL2 = val(patient.address1) ? val(patient.cityStateZip) : '';
  txt(doc, addrL1, LX + 10, by + 44, { size: 8, bold: true, color: P.text });
  if (addrL2) txt(doc, addrL2, LX + 10, by + 52, { size: 8, bold: true, color: P.text });

  /* 6 — Account summary (full width). Sits below the patient block with balanced
     spacing above the detailed table; its band matches the DETAILED INFORMATION
     header, and its column headers share the table-header size (8pt). */
  bandHeader(doc, ML, 252, MR - ML, 'ACCOUNT SUMMARY', { h: 20, size: 9, pal: P, mono });
  const grid = (cols, top, h, fill) => {
    const cw = (MR - ML) / cols.length;
    fillRect(doc, ML, top, MR - ML, h, fill);
    outline(ML, top, MR - ML, h, 0.5);
    cols.forEach((c, i) => {
      const cx = ML + cw * (i + 0.5);
      if (c.header) {
        txt(doc, c.header, cx, top + h / 2 + 3, { size: 8, bold: true, align: 'center', color: P.white });
      } else {
        if (c.pink) fillRect(doc, ML + cw * i, top, cw, h, P.pink);
        if (!blank) txt(doc, dash(c.value), cx, top + h / 2 + 3, { size: 8, bold: true, align: 'center', color: c.color || P.text });
      }
      if (i > 0) { doc.setDrawColor(P.border[0], P.border[1], P.border[2]); line(doc, ML + cw * i, top, ML + cw * i, top + h, 0.4); doc.setDrawColor(0, 0, 0); }
    });
  };
  grid([{ header: 'ACCOUNT NUMBER' }, { header: 'STATEMENT DATE' }, { header: 'DATE LAST PAID' }, { header: 'LAST PAID AMOUNT' }], 272, 18, P.navy);
  grid([
    { value: patient.accountNumber }, { value: mdy(stmt.statementDate) },
    { value: mdy(stmt.lastPaidDate) }, { value: stmt.summary.patientPaid ? money(stmt.summary.patientPaid) : '' },
  ], 290, 20, P.panel2);
  grid([{ header: 'INSURANCE PENDING' }, { header: 'PAST DUE' }, { header: 'COLLECTIONS' }, { header: 'FINANCE CHARGE' }, { header: 'BUDGET AMOUNT' }], 310, 18, P.navy);
  grid([
    { value: '' }, { value: stmt.summary.amountDue ? money(stmt.summary.amountDue) : '', color: P.red, pink: true },
    { value: '' }, { value: '' }, { value: '' },
  ], 328, 20, P.panel2);
  } // end first-page-only chrome (sections 2–6)

  /* 7 — Detailed information header + column header row.
     Page 1 slots this beneath the account summary with balanced spacing; every
     continuation page floats it to the top margin so the table stands alone. */
  const detailHdrTop = isFirst ? 356 : 30;
  bandHeader(doc, ML, detailHdrTop, MR - ML, 'DETAILED INFORMATION', { h: 20, size: 9, pal: P, mono });
  const dh = 24, dTop = detailHdrTop + 20;
  fillRect(doc, DCOL.left, dTop, DCOL.right - DCOL.left, dh, P.navy);
  fillRect(doc, DCOL.payR, dTop, DCOL.right - DCOL.payR, dh, P.navyDark);
  outline(DCOL.left, dTop, DCOL.right - DCOL.left, dh);
  // Uniform, clearly-visible bold column headers — one size, one font (Helvetica).
  const DH = { size: 8, bold: true, align: 'center', color: P.white };
  txt(doc, 'DATE', centre(DCOL.left, DCOL.dateR), dTop + 15, DH);
  txt(doc, 'SERVICE DESCRIPTION', centre(DCOL.dateR, DCOL.descR), dTop + 15, DH);
  txt(doc, 'INS MSG*', centre(DCOL.descR, DCOL.insR), dTop + 15, DH);
  txt(doc, 'CHARGES', centre(DCOL.insR, DCOL.chgR), dTop + 15, DH);
  txt(doc, 'PAYMENTS /', centre(DCOL.chgR, DCOL.payR), dTop + 10, DH);
  txt(doc, 'ADJUSTMENTS', centre(DCOL.chgR, DCOL.payR), dTop + 19, DH);
  txt(doc, 'PATIENT', centre(DCOL.payR, DCOL.right), dTop + 10, DH);
  txt(doc, 'BALANCE', centre(DCOL.payR, DCOL.right), dTop + 19, DH);

  /* 7b — Detailed DOS line-items (reference layout, variable height).
     Every line maps a specific field for that DOS:
       DATE col      → DOS date / payment date / adjustment date (per line)
       DESCRIPTION   → PATIENT · PROVIDER+CPT · procedure · Payment · Adjustment ·
                       balance-applied message · Balance Amount
       CHARGES       → charge (on the procedure line)
       PAYMENTS/ADJ  → insurance payment (green) & adjustment (on their lines)
       PATIENT BAL   → patient balance (on the Balance Amount line) */
  const dividers = [DCOL.dateR, DCOL.descR, DCOL.insR, DCOL.chgR, DCOL.payR];
  const dx = DCOL.dateR + 6;   // description column left padding
  const dateX = DCOL.left + 5; // date column left padding
  const descMaxW = DCOL.descR - dx - 4;   // clip description text to its column
  const dateMaxW = DCOL.dateR - dateX - 3; // clip dates to the date column
  let lastBottom = dTop + dh;

  const cellFrame = (top, h) => {
    doc.setDrawColor(P.border[0], P.border[1], P.border[2]); doc.setLineWidth(0.4);
    doc.rect(DCOL.left, top, DCOL.right - DCOL.left, h);
    dividers.forEach((x) => line(doc, x, top, x, top + h, 0.4));
    doc.setDrawColor(0, 0, 0);
  };

  if (blank) {
    // Template: three empty structural rows so the layout reads clearly.
    let ry = dTop + dh;
    for (let i = 0; i < 3; i += 1) {
      const h = 64;
      cellFrame(ry, h);
      ry += h;
    }
    lastBottom = ry;
  } else {
    (pageRows || []).forEach((item) => {
      const { row: r, lines, height, rowTop } = item;
      const charge = num(r.charge);
      const insPmt = num(r.insurancePayment);
      const insAdj = num(r.adjustment);
      const lastPaid = num(r.lastPaidAmount);
      const explicit = num(r.patientResponsibility || r.totalAmountDue);
      const resp = explicit || charge - insPmt - insAdj - lastPaid;
      const payer = s(r.insurance) || 'Insurance';

      // Cell borders (full height). The Patient Balance column is boxed below.
      cellFrame(rowTop, height);

      lines.forEach((ln) => {
        const y = rowTop + ln.y;
        if (ln.type === 'patient') {
          txt(doc, fit(doc, `PATIENT: ${patient.patientName}  - ${patient.accountNumber}`, descMaxW, 7.5, true), dx, y, { size: 7.5, bold: true, color: P.text });
        } else if (ln.type === 'provider') {
          let x = dx;
          txt(doc, 'PROVIDER: ', x, y, { size: 7.5, bold: true, color: P.text });
          x += width(doc, 'PROVIDER: ', 7.5, true);
          const cptStr = `CPT: ${s(r.cpt)}`;
          const provRoom = descMaxW - width(doc, 'PROVIDER: ', 7.5, true) - 8 - width(doc, cptStr, 7.5, true);
          const prov = fit(doc, s(r.renderingProvider) || '—', Math.max(24, provRoom), 7.5, false);
          txt(doc, prov, x, y, { size: 7.5, color: P.text });
          x += width(doc, prov, 7.5, false) + 8;
          txt(doc, cptStr, x, y, { size: 7.5, bold: true, color: P.text });
        } else if (ln.type === 'service') {
          txt(doc, fit(doc, mdy(first(r, ['dateOfService', 'statementDate'])), dateMaxW, 7.5, false), dateX, y, { size: 7.5, color: P.text });
          txt(doc, fit(doc, s(r.procedure) || '—', descMaxW, 7.5, false), dx, y, { size: 7.5, color: P.text });
          txt(doc, money(charge), DCOL.chgR - 7, y, { size: 8, bold: true, align: 'right', color: P.text });
        } else if (ln.type === 'payment') {
          txt(doc, fit(doc, mdy(r.paymentDate), dateMaxW, 7.5, false), dateX, y, { size: 7.5, color: P.text });
          txt(doc, fit(doc, `Payment - ${payer}`, descMaxW, 7.5, false), dx, y, { size: 7.5, color: P.text });
          txt(doc, money(insPmt), DCOL.payR - 7, y, { size: 8, bold: true, align: 'right', color: P.green });
        } else if (ln.type === 'adjustment') {
          txt(doc, fit(doc, mdy(r.adjustmentDate), dateMaxW, 7.5, false), dateX, y, { size: 7.5, color: P.text });
          txt(doc, fit(doc, `Adjustment - ${payer}`, descMaxW, 7.5, false), dx, y, { size: 7.5, color: P.text });
          txt(doc, money(insAdj), DCOL.payR - 7, y, { size: 8, bold: true, align: 'right', color: P.text });
        } else if (ln.type === 'message') {
          txt(doc, fit(doc, s(r.balanceAppliedTo), descMaxW, 7.5, false), dx, y, { size: 7.5, color: P.label });
        } else if (ln.type === 'balance') {
          txt(doc, 'Balance Amount', dx, y, { size: 7.5, bold: true, color: P.text });
          txt(doc, money(resp), DCOL.right - 7, y, { size: 8.5, bold: true, align: 'right', color: P.black });
        }
      });
      lastBottom = rowTop + height;
    });
  }

  /* 7c — Bold black box around the Patient Balance column (reference styling),
     enclosing its header band and every balance cell on this page. */
  doc.setDrawColor(0, 0, 0); doc.setLineWidth(1.3);
  doc.rect(DCOL.payR, dTop, DCOL.right - DCOL.payR, lastBottom - dTop);
  doc.setLineWidth(0.7);

  /* 8 — Footer: rule + alert badge + notice (pinned near the page bottom) */
  const fy = Math.max(FOOTER_MIN_TOP, lastBottom + 14);
  fillRect(doc, ML, fy, MR - ML, 2.5, P.navy);
  if (mono) { doc.setDrawColor(0, 0, 0); doc.setLineWidth(1); doc.line(ML, fy + 1.25, MR, fy + 1.25); doc.setLineWidth(0.7); }
  const bcx = ML + 10;
  if (mono) {
    doc.setDrawColor(0, 0, 0); doc.setLineWidth(1.1); doc.circle(bcx, fy + 26, 10, 'S'); doc.setLineWidth(0.7);
    txt(doc, '!', bcx, fy + 30, { size: 13, bold: true, align: 'center', color: P.black });
  } else {
    doc.setFillColor(C.red[0], C.red[1], C.red[2]);
    doc.circle(bcx, fy + 26, 10, 'F');
    txt(doc, '!', bcx, fy + 30, { size: 13, bold: true, align: 'center', color: C.white });
  }
  txt(doc, 'Please Pay Promptly', ML + 28, fy + 22, { size: 11, bold: true, color: P.text });
  txt(doc, 'BALANCES EXCEEDING 90 DAYS MAY BE SUBJECT TO COLLECTION PROCEDURES', ML + 28, fy + 36, { size: 8, bold: true, color: P.red });

  if (!blank && stmt.pages > 1) txt(doc, `Page ${pageIndex + 1} of ${stmt.pages}`, MR, fy + 36, { size: 7, align: 'right', color: P.label });

  return 0;
}

/** Derive the provider / patient / statement drawing context for one group. */
function buildContext(stmtGroup) {
  const sample = stmtGroup.rows[0] || {};
  // Provider/office details come ONLY from the uploaded statement row — never a
  // hardcoded fallback. A missing field renders blank rather than fabricated data.
  const provider = {
    officeName: first(sample, ['officeName', 'renderingProvider']) || '',
    address: s(sample.address),
    city: s(sample.city),
    state: s(sample.state),
    zip: s(sample.zipCode),
    phone: s(sample.phone),
  };
  const fullAddress = [s(sample.patientAddress1), s(sample.patientAddress2)]
    .filter(Boolean)
    .join(', ');
  const patient = {
    patientName: stmtGroup.patientName,
    accountNumber: stmtGroup.accountNumber,
    address1: s(sample.patientAddress1),
    cityStateZip: s(sample.patientAddress2),
    fullAddress,
  };
  const stmt = {
    ...stmtGroup,
    statementDate: first(sample, ['statementDate']) || '',
    lastPaidDate: first(sample, ['lastPaidDate', 'paymentDate']) || '',
  };
  return { provider, patient, stmt };
}

/** Render every page of one patient statement onto an existing jsPDF doc. */
function renderGroupPages(doc, stmtGroup, startFresh) {
  const { provider, patient, stmt } = buildContext(stmtGroup);
  const pages = stmtGroup.pagesRows || paginateRows((stmtGroup.rows || []).map((r) => layoutDosRow(r)));
  for (let p = 0; p < pages.length; p += 1) {
    if (!startFresh || p > 0) doc.addPage();
    startFresh = false;
    drawPage(doc, stmt, pages[p], p, provider, patient);
  }
}

/**
 * Build a jsPDF document for a single patient statement (multi-page).
 * Returns the jsPDF instance.
 */
export function buildStatementDoc(stmtGroup) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  renderGroupPages(doc, stmtGroup, true);
  return doc;
}

/**
 * Build a single-page blank template PDF — the full statement layout (all boxes,
 * labels and headings) with no patient or line-item content. Used for the
 * "View Template" preview so the structure is clearly visible on its own.
 *
 * @param {boolean} mono  When true, renders a completely blank & white
 *                        (monochrome) statement — white fills, black outlines
 *                        and text. When false, the colored template.
 */
export function buildBlankTemplateDoc(mono = false) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const provider = { ...EMPTY_PROVIDER };
  const patient = { patientName: '', accountNumber: '', address1: '', cityStateZip: '', fullAddress: '' };
  const stmt = {
    blank: true,
    mono: !!mono,
    pages: 1,
    statementDate: '',
    lastPaidDate: '',
    summary: {
      totalCharges: 0,
      insurancePayments: 0,
      insuranceAdjustments: 0,
      insurancePaid: 0,
      patientPaid: 0,
      amountDue: 0,
      patientResponsibility: 0,
    },
  };
  drawPage(doc, stmt, [], 0, provider, patient);
  return doc;
}

/** Download the blank statement template — white/monochrome or colored. */
export function downloadBlankTemplate(mono = false) {
  const doc = buildBlankTemplateDoc(mono);
  doc.save(`Statement_Template_${mono ? 'White' : 'Color'}.pdf`);
}

function safeName(str) {
  return s(str).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'statement';
}

/** Generate + download one patient's statement PDF. */
export function downloadStatement(stmtGroup) {
  const doc = buildStatementDoc(stmtGroup);
  const name = safeName(stmtGroup.patientName || stmtGroup.accountNumber);
  doc.save(`Statement_${name}.pdf`);
}

/** Generate + download every patient's statement merged into one PDF. */
export function downloadAllStatements(groups) {
  if (!groups.length) return;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  // Reuse the auto-created page 1 for the first statement, then append.
  renderGroupPages(doc, groups[0], true);
  groups.slice(1).forEach((g) => renderGroupPages(doc, g, false));
  doc.save('Patient_Statements.pdf');
}
