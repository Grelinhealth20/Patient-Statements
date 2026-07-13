import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { useToast } from '../components/Toast.jsx';
import { statementsApi } from '../api/client.js';
import { groupStatements, buildStatementDoc } from '../lib/statementPdf.js';

/**
 * Canonical statement columns. `aliases` are normalised header strings the
 * uploaded file may use; the first alias is always the normalised label itself.
 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const col = (key, label, extra = []) => ({
  key,
  label,
  aliases: [norm(label), ...extra.map(norm)],
});

const COLUMNS = [
  col('statementNo', 'Statement No', ['statementnumber', 'stmtno']),
  col('statementDate', 'Statement Date', ['stmtdate']),
  col('renderingProvider', 'Rendering Provider', ['provider']),
  col('officeName', 'Office Name'),
  col('address', 'Address', ['address1', 'officeaddress']),
  col('city', 'City'),
  col('state', 'State'),
  col('zipCode', 'Zip Code', ['zip', 'zipcode', 'postalcode']),
  col('phone', 'Phone', ['phonenumber', 'tel', 'telephone', 'officephone']),
  col('insurance', 'Insurance', ['payer', 'insurancename']),
  col('patientName', 'Patient Name', ['patient']),
  col('accountNumber', 'Account Number', ['acctno', 'accountno', 'accountnum']),
  col('patientAddress1', 'Patient Address 1', ['pataddress1', 'patientaddressline1']),
  col('patientAddress2', 'Patient Address 2', ['pataddress2', 'patientaddressline2']),
  col('dateOfService', 'Date Of Service', ['dos']),
  col('cpt', 'CPT', ['cptcode']),
  col('procedure', 'Procedure', ['proceduredescription', 'description']),
  col('quantity', 'Quantity', ['qty', 'units']),
  col('charge', 'Charge', ['charges', 'chargeamount']),
  col('insurancePayment', 'Insurance Payment', ['inspayment', 'insurancepaid']),
  col('lastPaidAmount', 'Last Paid Amount', ['lastpaidamt']),
  col('adjustment', 'Adjustment', ['adjustments', 'adjustmentamount']),
  col('totalAmountDue', 'Total Amount Due', ['amountdue', 'totaldue']),
  col('patientResponsibility', 'Patient Responsibility', ['patientresp', 'patresponsibility']),
  col('lastPaidDate', 'Last Paid Date', ['lastpaymentdate']),
  col('paymentDate', 'Payment Date', ['paydate']),
  col('adjustmentDate', 'Adjustment Date', ['adjdate']),
  col('balanceAppliedTo', 'Balance Applied to', ['balanceapplied', 'balanceappliedto']),
];

const ACCEPT = '.csv,.xlsx,.xls';

// Money-valued columns are right-aligned and currency-formatted in the detail table.
const MONEY_KEYS = new Set([
  'charge', 'insurancePayment', 'lastPaidAmount', 'adjustment', 'totalAmountDue', 'patientResponsibility',
]);

// Full per-DOS detail columns for the expanded drawer, in report order. Each cell
// is read from the DOS's parsed `data` object; Status + File Name are row-level.
// Office Name/Address/City/State/Zip and Patient Address 1/2 are consolidated into
// the patient-level "Office Address" / "Patient Address" columns, so they are
// intentionally omitted from the per-DOS detail table.
const DETAIL_KEYS = [
  'statementNo', 'statementDate', 'renderingProvider', 'insurance', 'patientName', 'accountNumber',
  'dateOfService', 'cpt', 'procedure', 'quantity', 'charge', 'insurancePayment', 'lastPaidAmount',
  'adjustment', 'totalAmountDue', 'patientResponsibility', 'lastPaidDate', 'paymentDate',
  'adjustmentDate', 'balanceAppliedTo',
];
const COL_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
// Total columns in the detail table: every data column + Status + File Name.
const DETAIL_COLSPAN = DETAIL_KEYS.length + 2;

const money = (n) =>
  `$${(Number(String(n).replace(/[^0-9.\-]/g, '')) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

// Detail columns that hold a date, so they render as mm/dd/yyyy.
const DATE_KEYS = new Set(['statementDate', 'dateOfService', 'lastPaidDate', 'paymentDate', 'adjustmentDate']);

const pad2 = (n) => String(n).padStart(2, '0');

/** Format any date-ish value as mm/dd/yyyy for the UI; unrecognised values pass through. */
function toMDY(v) {
  if (v == null || v === '') return '';
  const str = String(v).trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);       // ISO: YYYY-MM-DD[...]
  if (m) return `${pad2(m[2])}/${pad2(m[3])}/${m[1]}`;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);         // already M/D/YYYY
  if (m) return `${pad2(m[1])}/${pad2(m[2])}/${m[3]}`;
  const d = new Date(str);
  if (!isNaN(d)) return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  return str;
}

function fmtDate(v) {
  if (!v) return '—';
  return toMDY(v) || '—';
}

/** Two-line address cell: primary line + muted secondary line. */
function AddressCell({ addr }) {
  const line1 = addr?.line1 || '';
  const line2 = addr?.line2 || '';
  if (!line1 && !line2) return <span>—</span>;
  return (
    <div className="addr-cell" title={[line1, line2].filter(Boolean).join(', ')}>
      <span className="addr-line1">{line1 || '—'}</span>
      {line2 && <span className="addr-line2">{line2}</span>}
    </div>
  );
}

function StatusPill({ status }) {
  const generated = status === 'generated';
  return (
    <span
      className="status-pill"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
        fontSize: 12, fontWeight: 700, letterSpacing: 0.2,
        color: generated ? '#167A4D' : '#B45309',
        background: generated ? '#E7F6EE' : '#FEF3E2',
        border: `1px solid ${generated ? '#B7E3CB' : '#F6D9A8'}`,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: generated ? '#167A4D' : '#D97706' }} />
      {generated ? 'Generated' : 'Pending'}
    </span>
  );
}

const GEN_COLSPAN = 9;

/** One patient row plus its expandable list of dates of service. */
function PatientRow({ p, ex, onToggle }) {
  return (
    <>
      <tr
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={!!ex?.open}
        aria-label={`Toggle dates of service for ${p.patientName || p.accountNumber || 'patient'}`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <td style={{ textAlign: 'center', color: 'var(--muted, #6E7D91)' }}>{ex?.open ? '▾' : '▸'}</td>
        <td><strong>{p.patientName || '—'}</strong></td>
        <td className="mono">{p.accountNumber || '—'}</td>
        <td><AddressCell addr={p.officeAddress} /></td>
        <td><AddressCell addr={p.patientAddress} /></td>
        <td className="ta-right mono">
          <span style={{ color: p.pendingCount ? '#B45309' : 'inherit', fontWeight: p.pendingCount ? 700 : 400 }}>{p.pendingCount}</span>
          {' / '}{p.dosCount}
        </td>
        <td><StatusPill status={p.status} /></td>
        <td>{fmtDate(p.lastGeneratedAt)}</td>
        <td className="mono" title={p.lastFileName}>{p.lastFileName || '—'}</td>
      </tr>
      {ex?.open && (
        <tr>
          <td colSpan={GEN_COLSPAN} style={{ background: '#F7F9FC', padding: 0 }}>
            {ex.loading ? (
              <div style={{ padding: '12px 16px', color: 'var(--muted, #6E7D91)' }}>Loading dates of service…</div>
            ) : (
              <table className="data-table" style={{ margin: 0, background: 'transparent' }}>
                <thead>
                  <tr>
                    {DETAIL_KEYS.map((k) => (
                      <th key={k} className={MONEY_KEYS.has(k) ? 'ta-right' : undefined}>{COL_LABEL[k]}</th>
                    ))}
                    <th>Status</th>
                    <th>File Name</th>
                  </tr>
                </thead>
                <tbody>
                  {ex.dos.length === 0 ? (
                    <tr><td colSpan={DETAIL_COLSPAN} className="table-empty">No dates of service.</td></tr>
                  ) : ex.dos.map((d) => (
                    <tr key={d.id}>
                      {DETAIL_KEYS.map((k) => {
                        const raw = k === 'dateOfService' ? (d.dosDate || d.data?.dateOfService) : d.data?.[k];
                        if (MONEY_KEYS.has(k)) return <td key={k} className="ta-right mono">{money(raw)}</td>;
                        if (DATE_KEYS.has(k)) return <td key={k} className="mono">{toMDY(raw) || '—'}</td>;
                        const mono = k === 'cpt' || k === 'accountNumber';
                        return <td key={k} className={mono ? 'mono' : undefined}>{raw || '—'}</td>;
                      })}
                      <td><StatusPill status={d.status} /></td>
                      <td className="mono" title={d.sourceFile}>{d.sourceFile || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function StatementHome() {
  const { push } = useToast();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState('');

  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState('');
  const [generating, setGenerating] = useState('');
  const [expanded, setExpanded] = useState({}); // key -> { open, loading, dos }

  const refresh = useCallback(async () => {
    try {
      const { patients: list } = await statementsApi.patients();
      setPatients(list || []);
      return list || [];
    } catch (err) {
      push('Could not load patient statements from the server.', 'error');
      return [];
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { refresh(); }, [refresh]);

  const parseFile = useCallback(async (file) => {
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
      push('Unsupported file type. Please upload a CSV or Excel file.', 'error');
      return;
    }
    setParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      if (!aoa.length) { push('That file appears to be empty.', 'error'); return; }

      const headerRow = (aoa[0] || []).map((h) => norm(h));
      const headerIndex = {};
      headerRow.forEach((h, i) => { if (h && !(h in headerIndex)) headerIndex[h] = i; });
      const colIdx = COLUMNS.map((c) => {
        for (const a of c.aliases) if (a in headerIndex) return headerIndex[a];
        return -1;
      });

      const parsed = aoa.slice(1)
        .filter((r) => r.some((cell) => String(cell).trim() !== ''))
        .map((r) => {
          const obj = {};
          COLUMNS.forEach((c, ci) => { obj[c.key] = colIdx[ci] >= 0 ? String(r[colIdx[ci]] ?? '') : ''; });
          return obj;
        });

      if (!parsed.length) { push('No data rows found in that file.', 'error'); return; }

      const { imported, skipped, received } = await statementsApi.import(file.name, parsed);
      setFileName(file.name);
      await refresh();
      push(`Imported ${imported} new DOS · ${skipped} already on file · ${received} rows read.`);
    } catch (err) {
      push(err?.response?.data?.message || 'Could not read or import that file.', 'error');
    } finally {
      setParsing(false);
    }
  }, [push, refresh]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const onSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
    e.target.value = '';
  };

  const loadDos = useCallback(async (key, force = false) => {
    let willOpen = true;
    setExpanded((prev) => {
      const cur = prev[key];
      if (cur?.open && !force) { willOpen = false; return { ...prev, [key]: { ...cur, open: false } }; }
      return { ...prev, [key]: { open: true, loading: true, dos: cur?.dos || [] } };
    });
    if (!willOpen) return; // collapsing — no fetch needed
    try {
      const { dos } = await statementsApi.patientDos(key);
      setExpanded((prev) => ({ ...prev, [key]: { open: true, loading: false, dos: dos || [] } }));
    } catch {
      setExpanded((prev) => ({ ...prev, [key]: { open: true, loading: false, dos: [] } }));
      push('Could not load dates of service for this patient.', 'error');
    }
  }, [push]);

  const onGenerate = useCallback(async (key) => {
    if (!key) return;
    setGenerating(key);
    try {
      const { statement, rows } = await statementsApi.generate(key);
      const groups = groupStatements(rows || []);
      if (!groups.length) {
        push('The statement had no dates of service to render.', 'error');
        return;
      }
      const doc = buildStatementDoc(groups[0]);
      doc.save(statement.fileName);
      push(`Generated ${statement.fileName} · ${statement.dosCount} new DOS.`);
      const list = await refresh();
      // If the generated patient no longer has pending DOS, move selection off it.
      if (!list.find((p) => p.key === key && p.pendingCount > 0)) setSelectedKey('');
      // If this patient's DOS drawer is open, refetch it so statuses flip to Generated.
      setExpanded((prev) => {
        if (!prev[key]?.open) return prev;
        statementsApi.patientDos(key)
          .then(({ dos }) => setExpanded((p) => ({ ...p, [key]: { open: true, loading: false, dos: dos || [] } })))
          .catch(() => {});
        return { ...prev, [key]: { ...prev[key], loading: true } };
      });
    } catch (err) {
      const status = err?.response?.status;
      push(err?.response?.data?.message || 'Failed to generate the statement.', status === 409 || status === 404 ? 'info' : 'error');
    } finally {
      setGenerating('');
    }
  }, [push, refresh]);

  const totals = useMemo(() => ({
    patients: patients.length,
    dos: patients.reduce((t, p) => t + p.dosCount, 0),
    pending: patients.filter((p) => p.pendingCount > 0).length,
    generated: patients.filter((p) => p.pendingCount === 0 && p.dosCount > 0).length,
  }), [patients]);

  const selected = patients.find((p) => p.key === selectedKey) || null;
  const genColSpan = 9;

  return (
    <div className="stmt-view">
      {/* Drag & drop upload */}
      <div
        className={`dropzone ${dragging ? 'drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        aria-label="Upload a statement file by dragging and dropping or browsing"
      >
        <input ref={inputRef} type="file" accept={ACCEPT} onChange={onSelect} hidden />
        <div className="dz-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
        </div>
        <p className="dz-title">{parsing ? 'Importing…' : <>Drag &amp; drop your statement file here</>}</p>
        <p className="dz-sub">or <span className="dz-link">browse to upload</span></p>
        <span className="dz-formats">CSV · XLSX · XLS{fileName ? ` · last: ${fileName}` : ''}</span>
      </div>

      {/* Send to Engine — generate a statement for a selected patient */}
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-head">
          <div className="panel-title-wrap">
            <h2>Send to Engine</h2>
            <span className="count-badge">{totals.pending} pending</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', padding: '12px 18px 16px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 320, flex: '1 1 320px' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-mute)', letterSpacing: 0.4 }}>SELECT PATIENT</span>
            <select
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              className="select-input"
              style={{ padding: '11px 14px', borderRadius: 8, border: '1px solid var(--border-2)', background: '#fff', fontSize: 15, fontWeight: 600, color: 'var(--text)' }}
            >
              <option value="">— Choose a patient —</option>
              {patients.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.patientName || '(no name)'} · Acct {p.accountNumber || '—'} · {p.pendingCount} new / {p.dosCount} DOS
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn-primary btn-compact"
            disabled={!selected || selected.pendingCount === 0 || generating === selectedKey}
            onClick={() => onGenerate(selectedKey)}
            title={selected && selected.pendingCount === 0 ? 'No new DOS to generate' : 'Generate statement'}
          >
            {generating && generating === selectedKey ? 'Generating…' : 'Generate Statement'}
          </button>
          {selected && (
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-soft)' }}>
              {selected.pendingCount > 0
                ? `${selected.pendingCount} new DOS will be included${selected.generatedCount ? ` (${selected.generatedCount} already generated are excluded)` : ''}.`
                : 'All DOS for this patient are already on a statement.'}
            </span>
          )}
        </div>
      </section>

      {/* Grouped patient table */}
      <section className="panel panel-breakout">
        <div className="panel-head">
          <div className="panel-title-wrap">
            <h2>Patient Statements</h2>
            <span className="count-badge">{totals.patients}</span>
          </div>
          <div className="upload-meta" style={{ gap: 16, fontSize: 14, fontWeight: 700, color: 'var(--text-soft)' }}>
            <span>{totals.dos} DOS</span>
            <span>{totals.generated} generated</span>
            <span>{totals.pending} pending</span>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Patient</th>
                <th>Account Number</th>
                <th>Office Address</th>
                <th>Patient Address</th>
                <th className="ta-right">DOS (new / total)</th>
                <th>Status</th>
                <th>Generated Date</th>
                <th>File Name</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={genColSpan} className="table-empty">Loading patient statements…</td></tr>
              ) : patients.length === 0 ? (
                <tr><td colSpan={genColSpan} className="table-empty">No patients yet — upload a statement file above to populate this table.</td></tr>
              ) : (
                patients.map((p) => (
                  <PatientRow key={p.key} p={p} ex={expanded[p.key]} onToggle={() => loadDos(p.key)} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
