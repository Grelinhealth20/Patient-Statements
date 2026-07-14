import { useCallback, useEffect, useRef, useState } from 'react';
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
  col('patientDob', 'Patient DOB', ['dob', 'dateofbirth', 'birthdate', 'patientdob', 'patientdateofbirth', 'patientbirthdate', 'patientdob']),
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
  'statementNo', 'statementDate', 'renderingProvider', 'insurance', 'patientName', 'patientDob', 'accountNumber',
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
const DATE_KEYS = new Set(['statementDate', 'dateOfService', 'lastPaidDate', 'paymentDate', 'adjustmentDate', 'patientDob']);

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

const GEN_COLSPAN = 11; // table columns (incl. Patient DOB + Tier) — full-width message/detail rows
const PAGE_SIZE = 10; // patients per page in the dashboard table

/** Build a compact page-number window, e.g. [1, '…', 5, 6, 7, '…', 16]. */
function pageWindow(current, totalPages, span = 1) {
  const pages = [];
  const left = Math.max(2, current - span);
  const right = Math.min(totalPages - 1, current + span);
  pages.push(1);
  if (left > 2) pages.push('…');
  for (let p = left; p <= right; p += 1) pages.push(p);
  if (right < totalPages - 1) pages.push('…');
  if (totalPages > 1) pages.push(totalPages);
  return pages;
}

/** Pagination bar: "Showing X–Y of Z" + ‹ 1 … 5 6 7 … 16 › controls. */
function Pagination({ pagination, onPage, busy }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  const { page, pageSize, total, totalPages } = pagination;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="pager">
      <span className="pager-info">Showing <strong>{from}–{to}</strong> of <strong>{total}</strong></span>
      <div className="pager-controls" role="navigation" aria-label="Table pagination">
        <button className="pager-btn" disabled={busy || page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
        {pageWindow(page, totalPages).map((p, i) => (
          p === '…'
            ? <span key={`e${i}`} className="pager-ellipsis" aria-hidden="true">…</span>
            : (
              <button
                key={p}
                className={`pager-btn${p === page ? ' active' : ''}`}
                disabled={busy}
                aria-current={p === page ? 'page' : undefined}
                onClick={() => onPage(p)}
              >
                {p}
              </button>
            )
        ))}
        <button className="pager-btn" disabled={busy || page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
      </div>
    </div>
  );
}

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6l7-3z" /><path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden="true">
      <path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

/** Inline processing spinner. `dark` uses the brand color (for light buttons). */
function Spinner({ dark = false }) {
  return <span className={`inline-spinner${dark ? ' dark' : ''}`} aria-hidden="true" />;
}

/* Dashboard KPI + section glyphs. */
const Svg = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props} />
);
const IconUsers = () => <Svg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Svg>;
const IconLayers = () => <Svg><path d="M12 2l9 5-9 5-9-5 9-5z" /><path d="M3 12l9 5 9-5M3 17l9 5 9-5" /></Svg>;
const IconClock = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
const IconCheck = () => <Svg><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" /></Svg>;
const IconUpload = () => <Svg strokeWidth="1.7"><path d="M12 16V4M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></Svg>;
const IconDollar = () => <Svg><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></Svg>;

/** Human label for the address validator (USPS is the only provider). */
function providerLabel() {
  return 'USPS Address Validation';
}
function providerShort() {
  return 'USPS';
}

/** Build a descriptive tooltip for the USPS address-validation pill. */
function tierTitle(s) {
  if (!s) return 'Checking USPS address validation…';
  const parts = [`${s.provider || 'USPS Address Validation'} — real-time · free (no per-call charge)`];
  if (s.uspsCallsThisMonth != null) parts.push(`${Number(s.uspsCallsThisMonth).toLocaleString()} validations this month`);
  if (!s.uspsHealthy && s.reason) parts.push(`Not serving: ${s.reason}`);
  return parts.join(' · ');
}

/** Live USPS address-validation pill: Free (serving) / Unavailable. */
function TierPill({ status }) {
  if (!status) {
    return <span className="tier-pill tier-loading" title={tierTitle(null)}>Checking…</span>;
  }
  const healthy = !!status.uspsHealthy;
  const cls = healthy ? 'tier-free' : 'tier-unknown';
  const label = healthy ? 'USPS · Free' : 'USPS · Unavailable';
  return (
    <span className={`tier-pill ${cls}`} title={tierTitle(status)}>
      <span className="tier-dot" aria-hidden="true" />{label}
    </span>
  );
}

/** One patient row plus its expandable list of dates of service. */
function PatientRow({ p, ex, onToggle, onValidate, validating, onDownloadFile, downloading, tier, onSaveAddress, savingAddress }) {
  const hasFile = !!p.lastFileName && !!p.lastStatementId;
  const [editing, setEditing] = useState(false);
  const [l1, setL1] = useState('');
  const [l2, setL2] = useState('');
  const saving = savingAddress === p.key;

  const openEditor = (e) => {
    e.stopPropagation();
    setL1(p.patientAddress?.line1 || '');
    setL2(p.patientAddress?.line2 || '');
    setEditing(true);
  };
  const cancelEdit = (e) => { e?.stopPropagation(); setEditing(false); };
  const saveEdit = async (e) => {
    e?.stopPropagation();
    const ok = await onSaveAddress(p.key, l1.trim(), l2.trim());
    if (ok) setEditing(false);
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  };

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
        <td className="mono">{toMDY(p.patientDob) || p.patientDob || '—'}</td>
        <td className="mono">{p.accountNumber || '—'}</td>
        <td><AddressCell addr={p.officeAddress} /></td>
        <td onClick={(e) => { if (editing) e.stopPropagation(); }}>
          {editing ? (
            <div className="addr-edit" onClick={(e) => e.stopPropagation()}>
              <input
                className="addr-edit-input" value={l1} autoFocus disabled={saving}
                placeholder="Street address (e.g. 6406 Ivy Lane STE 100)"
                onChange={(e) => setL1(e.target.value)} onKeyDown={onKey}
                aria-label="Patient address line 1"
              />
              <input
                className="addr-edit-input" value={l2} disabled={saving}
                placeholder="City, State ZIP (e.g. Greenbelt, MD 20770)"
                onChange={(e) => setL2(e.target.value)} onKeyDown={onKey}
                aria-label="Patient address line 2"
              />
              <div className="addr-edit-actions">
                <button className="btn-save-addr" onClick={saveEdit} disabled={saving || (!l1.trim() && !l2.trim())}
                  title="Format with USPS and save">
                  {saving ? <span className="btn-inline"><Spinner dark /> Formatting & saving…</span> : <>✓ Save</>}
                </button>
                <button className="btn-cancel-addr" onClick={cancelEdit} disabled={saving} title="Discard changes">✕</button>
              </div>
              <span className="addr-edit-hint">USPS will standardize the address automatically on save.</span>
            </div>
          ) : (
            <>
              <AddressCell addr={p.patientAddress} />
              <div className="addr-actions">
                <button className="btn-edit-addr" onClick={openEditor}
                  title="Edit this patient's address — USPS formats & saves it automatically">
                  <PencilIcon /> Edit
                </button>
                {p.addressValidated ? (
                  <span
                    className={`addr-verified prov-${p.addressValidationProvider || 'unknown'}`}
                    title={`Address verified via ${providerLabel(p.addressValidationProvider)}${p.addressValidationVerdict ? ` — ${p.addressValidationVerdict}` : ''}${p.addressValidatedAt ? ` on ${fmtDate(p.addressValidatedAt)}` : ''}`}
                  >
                    <ShieldCheckIcon /> Verified · {providerShort(p.addressValidationProvider)}
                  </span>
                ) : (
                  <button
                    className="btn-validate"
                    disabled={validating}
                    onClick={(e) => { e.stopPropagation(); onValidate(p.key); }}
                    title="Validate & standardize this patient's address with USPS (free, real-time)."
                  >
                    {validating
                      ? <span className="btn-inline"><Spinner dark /> Validating…</span>
                      : <><ShieldCheckIcon /> Validate</>}
                  </button>
                )}
              </div>
            </>
          )}
        </td>
        <td><TierPill status={tier} /></td>
        <td className="ta-right mono">
          <span style={{ color: p.pendingCount ? '#B45309' : 'inherit', fontWeight: p.pendingCount ? 700 : 400 }}>{p.pendingCount}</span>
          {' / '}{p.dosCount}
        </td>
        <td><StatusPill status={p.status} /></td>
        <td>{fmtDate(p.lastGeneratedAt)}</td>
        <td className="mono" title={hasFile ? `Download ${p.lastFileName} from secure storage` : p.lastFileName}>
          {hasFile ? (
            <button
              type="button"
              className="file-link"
              disabled={downloading}
              onClick={(e) => { e.stopPropagation(); onDownloadFile(p); }}
              title={`Download ${p.lastFileName} from secure storage`}
            >
              {downloading ? (
                <span className="file-link-busy"><span className="file-link-spinner" aria-hidden="true" /> Downloading…</span>
              ) : (
                <span className="file-link-inner"><DownloadIcon /> {p.lastFileName}</span>
              )}
            </button>
          ) : (
            p.lastFileName || '—'
          )}
        </td>
      </tr>
      {ex?.open && (
        <tr>
          <td colSpan={GEN_COLSPAN} style={{ background: '#ffffff', padding: 0 }}>
            {ex.loading ? (
              <div style={{ padding: '12px 16px', color: 'var(--muted, #6E7D91)' }}>Loading dates of service…</div>
            ) : (
              <div className="detail-scroll">
              <table className="data-table detail-table" style={{ margin: 0, background: 'transparent' }}>
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
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

const nfmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

/**
 * Real-time popup reporting live USPS address-validation status. USPS is the sole
 * validator and is free of charge; the DPV verdict and ZIP+4 come from the live call.
 */
function ApiStatusModal({ status, onClose }) {
  if (!status) return null;
  const healthy = status.uspsHealthy != null ? !!status.uspsHealthy : (status.live !== false);
  const cls = healthy ? 'v-free' : 'v-unknown';
  const label = healthy ? 'USPS · FREE' : 'USPS · UNAVAILABLE';
  const sub = healthy
    ? 'Validated by USPS — free, no per-call charge'
    : (status.reason || status.note || 'USPS is not serving right now');

  const when = status.checkedAt ? new Date(status.checkedAt) : new Date();
  const whenStr = isNaN(when) ? '' : when.toLocaleString();
  const live = status.live ?? healthy;

  return (
    <div className="api-modal-overlay" role="dialog" aria-modal="true" aria-label="USPS Address Validation status" onClick={onClose}>
      <div className="api-modal" onClick={(e) => e.stopPropagation()}>
        <button className="api-modal-x" onClick={onClose} aria-label="Close">×</button>
        <div className="api-modal-head">
          <span className={`api-live-dot${live ? ' on' : ''}`} aria-hidden="true" />
          <div>
            <h3>USPS Address Validation</h3>
            <p className="api-modal-provider">{status.provider || 'USPS Addresses API v3'}</p>
          </div>
        </div>

        <div className={`api-verdict ${cls}`}>
          <span className="api-verdict-label">Status</span>
          <span className="api-verdict-value">{label}</span>
          <span className="api-verdict-sub">{sub}</span>
        </div>

        <dl className="api-facts">
          <div><dt>Provider</dt><dd>{status.provider || 'USPS Address Validation'}</dd></div>
          <div><dt>Cost</dt><dd>Free — no per-call charge</dd></div>
          <div><dt>Mode</dt><dd>{live ? 'Live · real-time' : 'Offline'}</dd></div>
          {status.dpv && <div><dt>USPS DPV</dt><dd className="mono">{status.dpv}</dd></div>}
          {status.zipPlus4 != null && <div><dt>ZIP+4</dt><dd>{status.zipPlus4 ? 'Appended' : 'Not available'}</dd></div>}
          {status.uspsCallsThisMonth != null && <div><dt>Validations this month</dt><dd>{nfmt(status.uspsCallsThisMonth)}</dd></div>}
          {whenStr && <div><dt>Checked</dt><dd>{whenStr}</dd></div>}
        </dl>

        {status.note && <p className="api-modal-note">{status.note}</p>}
        <button className="btn-primary btn-compact api-modal-ok" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}

/**
 * "Verify All Addresses" batch popup. Loads the full patient roster, then validates
 * every not-yet-verified address via USPS in real time (a small concurrency pool so
 * many run "one by one" without hammering the API), with a live animated progress
 * bar and running success/failure counts. On completion it refreshes the table so
 * addresses that could NOT be validated sort to the top. All calls are real USPS
 * validations through the existing endpoint — no mock data.
 */
function VerifyAllModal({ onClose, onDone }) {
  const [phase, setPhase] = useState('loading'); // loading | running | done | empty | error
  const [stats, setStats] = useState({ total: 0, processed: 0, ok: 0, failed: 0 });
  const [current, setCurrent] = useState('');
  const [failedList, setFailedList] = useState([]);
  const [error, setError] = useState('');
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    (async () => {
      let queue;
      try {
        const { patients } = await statementsApi.addressQueue();
        queue = (patients || []).filter((p) => !p.validated);
      } catch {
        setError('Could not load the patient list.');
        setPhase('error');
        return;
      }
      if (!queue.length) { setPhase('empty'); return; }
      setStats({ total: queue.length, processed: 0, ok: 0, failed: 0 });
      setPhase('running');

      const CONCURRENCY = 5;
      const fails = [];
      let ok = 0, failed = 0, idx = 0;
      const worker = async () => {
        while (idx < queue.length && !cancelRef.current) {
          const p = queue[idx++];
          setCurrent(p.patientName || p.key);
          try {
            await statementsApi.validateAddress(p.key);
            ok += 1;
          } catch (err) {
            failed += 1;
            fails.push({ key: p.key, name: p.patientName || p.key, reason: err?.response?.data?.message || 'Could not validate' });
          }
          setStats((st) => ({ ...st, processed: st.processed + 1, ok, failed }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      setFailedList(fails);
      setCurrent('');
      setPhase('done');
      onDone(); // refresh the table so unvalidated addresses move to the top
    })();
    return () => { cancelRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { total, processed, ok, failed } = stats;
  const pct = total ? Math.round((processed / total) * 100) : 0;
  const running = phase === 'running';

  const close = () => { cancelRef.current = true; onClose(); };

  return (
    <div className="api-modal-overlay" role="dialog" aria-modal="true" aria-label="Verify all patient addresses" onClick={running ? undefined : close}>
      <div className="api-modal va-modal" onClick={(e) => e.stopPropagation()}>
        {!running && <button className="api-modal-x" onClick={close} aria-label="Close">×</button>}
        <div className="api-modal-head">
          <span className={`va-spark${running ? ' spin' : ''}`} aria-hidden="true"><ShieldCheckIcon /></span>
          <div>
            <h3>Verify All Patient Addresses</h3>
            <p className="api-modal-provider">
              {phase === 'loading' && 'Loading patients…'}
              {running && `Validating with USPS · ${processed} of ${total}`}
              {phase === 'done' && 'Validation complete'}
              {phase === 'empty' && 'Nothing to validate'}
              {phase === 'error' && 'Could not start'}
            </p>
          </div>
        </div>

        {error && <div className="alert alert-error" role="alert" style={{ margin: '0 0 12px' }}>{error}</div>}

        {(running || phase === 'done') && (
          <>
            <div className="va-bar" aria-hidden="true">
              <div className={`va-bar-fill${running ? ' striped' : ''}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="va-progress-row">
              <span className="va-pct">{pct}%</span>
              <span className="va-counts">
                <span className="va-ok">✓ {ok} verified</span>
                <span className="va-fail">✕ {failed} failed</span>
              </span>
            </div>
            {running && (
              <p className="va-current">
                <Spinner /> {current ? <>Validating <strong>{current}</strong>…</> : 'Working…'}
              </p>
            )}
          </>
        )}

        {phase === 'done' && (
          <div className="va-summary">
            <p className="va-done-line">
              <strong>{ok}</strong> address{ok === 1 ? '' : 'es'} verified · <strong>{failed}</strong> could not be validated.
            </p>
            {failed > 0 && (
              <>
                <p className="va-note">The {failed} address{failed === 1 ? '' : 'es'} below could not be validated and {failed === 1 ? 'has' : 'have'} been moved to the top of the table for review.</p>
                <ul className="va-fail-list">
                  {failedList.slice(0, 50).map((f) => (
                    <li key={f.key}><strong>{f.name}</strong> — {f.reason}</li>
                  ))}
                  {failedList.length > 50 && <li>…and {failedList.length - 50} more.</li>}
                </ul>
              </>
            )}
          </div>
        )}

        {phase === 'empty' && (
          <p className="confirm-text">Every patient address is already verified — nothing to do.</p>
        )}

        <div className="va-actions">
          {running ? (
            <button className="btn-secondary" onClick={() => { cancelRef.current = true; }}>Stop</button>
          ) : (
            <button className="btn-primary btn-compact" onClick={close}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StatementHome() {
  const { push } = useToast();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState('');

  const [patients, setPatients] = useState([]);            // current page rows
  const [pagination, setPagination] = useState(null);      // { page, pageSize, total, totalPages }
  const [totals, setTotals] = useState({ patients: 0, dos: 0, pending: 0, generated: 0 });
  const [summary, setSummary] = useState(null); // live financials { patientResponsibilityOutstanding, ... }
  const [pendingList, setPendingList] = useState([]);      // all pending patients (selector)
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false); // true while a page change is in flight
  const [selectedKey, setSelectedKey] = useState('');
  const [generating, setGenerating] = useState('');
  const [validating, setValidating] = useState(''); // patient key being address-validated
  const [savingAddress, setSavingAddress] = useState(''); // patient key whose edited address is saving
  const [apiStatus, setApiStatus] = useState(null); // live Address Validation API plan status (popup)
  const [verifyAllOpen, setVerifyAllOpen] = useState(false); // "Verify All Addresses" batch popup
  const [tierStatus, setTierStatus] = useState(null); // live billing tier for the table's Tier column
  const [downloading, setDownloading] = useState(''); // patient key whose stored PDF is downloading
  const [expanded, setExpanded] = useState({}); // key -> { open, loading, dos }

  // Load one page of the patient table (rows + pagination + aggregate totals).
  const loadPage = useCallback(async (p) => {
    setPaging(true);
    try {
      const data = await statementsApi.patients(p, PAGE_SIZE);
      setPatients(data.patients || []);
      setPagination(data.pagination || null);
      setTotals(data.totals || { patients: 0, dos: 0, pending: 0, generated: 0 });
      // Refresh the live financial summary alongside the table (real-time, non-blocking).
      statementsApi.summary().then(setSummary).catch(() => {});
      // The backend clamps the page into range; mirror that back into state.
      if (data.pagination && data.pagination.page !== p) setPage(data.pagination.page);
      return data;
    } catch {
      push('Could not load patient statements from the server.', 'error');
      return null;
    } finally {
      setLoading(false);
      setPaging(false);
    }
  }, [push]);

  // Change the current page. Guarded so out-of-range or same-page clicks are no-ops.
  const goToPage = useCallback((p) => {
    const totalPages = pagination?.totalPages || 1;
    const next = Math.min(Math.max(1, p), totalPages);
    if (next !== page) setPage(next);
  }, [page, pagination]);

  // Load every pending patient for the "Send to Engine" selector (unpaginated).
  const loadPending = useCallback(async () => {
    try {
      const { patients: list } = await statementsApi.pendingPatients();
      setPendingList(list || []);
      return list || [];
    } catch {
      return [];
    }
  }, []);

  // Reload the current page and the pending selector together.
  const refresh = useCallback(async () => {
    const [, pending] = await Promise.all([loadPage(page), loadPending()]);
    return pending;
  }, [loadPage, loadPending, page]);

  // Load the live Address Validation billing tier for the table's Tier column.
  const loadTier = useCallback(async () => {
    try {
      const { api } = await statementsApi.addressValidationStatus();
      setTierStatus(api || null);
      return api || null;
    } catch {
      return null;
    }
  }, []);

  // Fetch the page whenever it changes (and on first mount); load the selector + tier once.
  useEffect(() => { loadPage(page); }, [page, loadPage]);
  useEffect(() => { loadPending(); }, [loadPending]);
  useEffect(() => { loadTier(); }, [loadTier]);

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
      // Archive the exact rendered PDF to S3 (the durable copy). The statement is
      // then downloaded on demand by clicking its file name — no redundant local
      // auto-download. If storage is unavailable or fails, fall back to saving the
      // PDF locally so the user always gets their statement.
      let stored = false;
      if (statement.storageEnabled && statement.id) {
        try {
          await statementsApi.storePdf(statement.id, doc.output('blob'));
          stored = true;
        } catch {
          stored = false;
        }
      }
      if (stored) {
        push(`Generated & stored ${statement.fileName} · ${statement.dosCount} new DOS. Click the file name to download.`);
      } else {
        doc.save(statement.fileName);
        push(
          statement.storageEnabled
            ? `Generated ${statement.fileName}, but cloud archival failed — downloaded locally instead.`
            : `Generated ${statement.fileName} · ${statement.dosCount} new DOS.`,
          statement.storageEnabled ? 'info' : 'success'
        );
      }
      const pending = await refresh();
      // If the generated patient no longer has pending DOS, move selection off it.
      if (!pending.some((p) => p.key === key)) setSelectedKey('');
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

  // Validate one patient's address via USPS, persist the standardized result,
  // then refresh so the table (and any open DOS drawer) shows the updated address.
  const onValidate = useCallback(async (key) => {
    if (!key) return;
    setValidating(key);
    try {
      const { validated, api } = await statementsApi.validateAddress(key);
      // Show the live USPS status popup, and refresh the Tier pill from the live probe.
      if (api) setApiStatus(api);
      statementsApi.addressValidationStatus().then((d) => d.api && setTierStatus(d.api)).catch(() => {});
      push(
        `Address ${validated.complete ? 'confirmed' : 'updated'} via USPS: ${validated.formatted}`,
        validated.complete ? 'success' : 'info'
      );
      await refresh();
      setExpanded((prev) => {
        if (!prev[key]?.open) return prev;
        statementsApi.patientDos(key)
          .then(({ dos }) => setExpanded((p) => ({ ...p, [key]: { open: true, loading: false, dos: dos || [] } })))
          .catch(() => {});
        return { ...prev, [key]: { ...prev[key], loading: true } };
      });
    } catch (err) {
      // USPS failures return a clear message (and provider:'usps'); surface it.
      const api = err?.response?.data?.api;
      if (api) setApiStatus(api);
      push(err?.response?.data?.message || 'USPS could not validate this address.', 'error');
    } finally {
      setValidating('');
    }
  }, [push, refresh]);

  // Save a directly-edited patient address: the backend auto-formats it with USPS and
  // persists it across all of the patient's DOS rows. Returns true on success so the
  // row can close its editor. Refreshes the table (and any open drawer) afterward.
  const onSaveAddress = useCallback(async (key, line1, line2) => {
    if (!key) return false;
    if (!line1 && !line2) { push('Please enter an address to save.', 'error'); return false; }
    setSavingAddress(key);
    try {
      const res = await statementsApi.updateAddress(key, line1, line2);
      if (res.api) setApiStatus(res.api);
      statementsApi.addressValidationStatus().then((d) => d.api && setTierStatus(d.api)).catch(() => {});
      push(res.message || 'Address saved.', res.validated ? 'success' : 'info');
      await refresh();
      setExpanded((prev) => {
        if (!prev[key]?.open) return prev;
        statementsApi.patientDos(key)
          .then(({ dos }) => setExpanded((p) => ({ ...p, [key]: { open: true, loading: false, dos: dos || [] } })))
          .catch(() => {});
        return { ...prev, [key]: { ...prev[key], loading: true } };
      });
      return true;
    } catch (err) {
      push(err?.response?.data?.message || 'Could not save the address.', 'error');
      return false;
    } finally {
      setSavingAddress('');
    }
  }, [push, refresh]);

  // Clicking a File Name downloads the stored PDF: fetch a short-lived presigned
  // S3 URL and trigger the browser download. If the statement was generated
  // before archival existed (409 NOT_STORED), fall back to rebuilding the PDF
  // locally from its dates of service so a download always succeeds.
  const downloadStored = useCallback(async (p) => {
    if (!p?.lastStatementId || downloading) return;
    setDownloading(p.key);
    try {
      const { url, fileName } = await statementsApi.downloadUrl(p.lastStatementId);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || p.lastFileName || '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      push(`Downloading ${p.lastFileName || 'statement'} from secure storage.`);
    } catch (err) {
      // 409 NOT_STORED → statement predates archival; rebuild the exact PDF locally.
      if (err?.response?.status === 409) {
        try {
          const { dos } = await statementsApi.patientDos(p.key);
          const groups = groupStatements((dos || []).map((d) => d.data));
          if (groups.length) {
            buildStatementDoc(groups[0]).save(p.lastFileName || 'statement.pdf');
            push(`Downloaded ${p.lastFileName || 'statement'} (regenerated locally).`, 'info');
            return;
          }
        } catch { /* fall through to error toast */ }
      }
      push('Could not download the statement PDF.', 'error');
    } finally {
      setDownloading('');
    }
  }, [push, downloading]);

  // `totals` (aggregate KPIs) and `pendingList` (all pending patients) now come
  // straight from the backend, so they stay accurate across every page.
  const pendingPatients = pendingList;
  const selected = pendingPatients.find((p) => p.key === selectedKey) || null;
  const genColSpan = GEN_COLSPAN; // 10 columns incl. Tier

  // If the selected patient is no longer pending (e.g. just generated), clear it
  // so the dropdown never shows a stale, already-generated selection.
  useEffect(() => {
    if (selectedKey && !pendingPatients.some((p) => p.key === selectedKey)) setSelectedKey('');
  }, [selectedKey, pendingPatients]);

  return (
    <div className="stmt-view stmt-dash">
      <ApiStatusModal status={apiStatus} onClose={() => setApiStatus(null)} />
      {verifyAllOpen && (
        <VerifyAllModal
          onClose={() => setVerifyAllOpen(false)}
          onDone={() => { loadPage(1); loadTier(); }}
        />
      )}

      {/* Command row: upload | summary cards | Send to Engine — one straight line */}
      <div className="command-row">
        {/* Left — futuristic drag & drop upload */}
        <div
          className={`dz-futuristic ${dragging ? 'drag' : ''} ${parsing ? 'processing' : ''}`}
          onDragOver={(e) => { if (!parsing) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
          onDrop={onDrop}
          onClick={() => { if (!parsing) inputRef.current?.click(); }}
          role="button" tabIndex={0}
          aria-busy={parsing}
          onKeyDown={(e) => !parsing && (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
          aria-label="Upload a statement file by dragging and dropping or browsing"
        >
          <input ref={inputRef} type="file" accept={ACCEPT} onChange={onSelect} hidden />
          <div className="dz-orb">{parsing ? <Spinner /> : <IconUpload />}</div>
          <p className="dz-title">
            {parsing
              ? <span className="dz-processing">Importing &amp; validating rows…</span>
              : <>Drag &amp; drop your statement file</>}
          </p>
          <p className="dz-sub">{parsing ? 'Please wait — parsing your file in real time' : <>or <span className="dz-link">browse to upload</span></>}</p>
          <span className="dz-formats">CSV · XLSX · XLS</span>
        </div>

        {/* Middle — live summary cards, aligned in a single line */}
        <section className="panel summary-panel">
          <div className="summary-strip">
            <div className="summary-tile">
              <span className="summary-ic s-blue"><IconUsers /></span>
              <span className="summary-label">Patients</span>
              <span className="summary-value">{totals.patients}</span>
            </div>
            <div className="summary-tile">
              <span className="summary-ic s-violet"><IconLayers /></span>
              <span className="summary-label">Dates of Service</span>
              <span className="summary-value">{totals.dos}</span>
            </div>
            <div className="summary-tile">
              <span className="summary-ic s-amber"><IconClock /></span>
              <span className="summary-label">Pending</span>
              <span className="summary-value">{totals.pending}</span>
            </div>
            <div className="summary-tile">
              <span className="summary-ic s-green"><IconCheck /></span>
              <span className="summary-label">Generated</span>
              <span className="summary-value">{totals.generated}</span>
            </div>
            <div className="summary-tile" title={summary
              ? `Sum of Patient Responsibility across ${summary.dosWithAmount} of ${summary.dosCount} dates of service (live from the database)`
              : 'Calculating outstanding patient responsibility…'}>
              <span className="summary-ic s-teal"><IconDollar /></span>
              <span className="summary-label">Patient Resp. Outstanding</span>
              <span className="summary-value">{summary ? money(summary.patientResponsibilityOutstanding) : '—'}</span>
            </div>
          </div>
        </section>

        {/* Right — Send to Engine control panel */}
        <section className="panel engine-panel">
          <div className="panel-head">
            <div className="panel-title-wrap">
              <h2>Send to Engine</h2>
              <span className="count-badge">{totals.pending} PENDING</span>
            </div>
          </div>
          <div className="engine-body">
            <label className="engine-field">
              <span>Select Patient</span>
              <select
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
                className="select-input"
              >
                <option value="">
                  {pendingPatients.length ? '— Choose a patient —' : '— No patients with new DOS —'}
                </option>
                {pendingPatients.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.patientName || '(no name)'} · Acct {p.accountNumber || '—'} · {p.pendingCount} new / {p.dosCount} DOS
                  </option>
                ))}
              </select>
            </label>
            <div className="engine-actions">
              <button
                className="btn-primary btn-compact"
                disabled={!selected || selected.pendingCount === 0 || generating === selectedKey}
                onClick={() => onGenerate(selectedKey)}
                title={selected && selected.pendingCount === 0 ? 'No new DOS to generate' : 'Generate statement'}
              >
                {generating && generating === selectedKey
                  ? <span className="btn-inline"><Spinner /> Generating &amp; storing…</span>
                  : 'Generate Statement'}
              </button>
              {selected && (
                <span className="engine-note">
                  {selected.pendingCount > 0
                    ? `${selected.pendingCount} new DOS will be included${selected.generatedCount ? ` (${selected.generatedCount} already generated are excluded)` : ''}.`
                    : 'All DOS for this patient are already on a statement.'}
                </span>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Grouped patient table */}
      <section className="panel panel-breakout">
        <div className="panel-head">
          <div className="panel-title-wrap">
            <h2>Patient Statements</h2>
            <span className="count-badge">{totals.patients}</span>
          </div>
          <div className="panel-head-actions">
            {fileName && <span className="dash-lastfile" title={fileName}>Last import · {fileName}</span>}
            <button
              className="btn-verify-all"
              onClick={() => setVerifyAllOpen(true)}
              disabled={!totals.patients}
              title="Validate every patient's address with USPS, one by one. Unverified addresses move to the top."
            >
              <ShieldCheckIcon /> Verify All Addresses
            </button>
            <div className="upload-meta" style={{ gap: 16, fontSize: 14, fontWeight: 700, color: 'var(--text-soft)' }}>
              <span>{totals.dos} DOS</span>
              <span>{totals.generated} generated</span>
              <span>{totals.pending} pending</span>
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Patient</th>
                <th>Patient DOB</th>
                <th>Account Number</th>
                <th>Office Address</th>
                <th>Patient Address</th>
                <th>Tier</th>
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
                  <PatientRow key={p.key} p={p} ex={expanded[p.key]} onToggle={() => loadDos(p.key)} onValidate={onValidate} validating={validating === p.key} onDownloadFile={downloadStored} downloading={downloading === p.key} tier={tierStatus} onSaveAddress={onSaveAddress} savingAddress={savingAddress} />
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination pagination={pagination} onPage={goToPage} busy={paging} />
      </section>
    </div>
  );
}
