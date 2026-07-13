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

const GEN_COLSPAN = 10; // table columns (incl. Tier) — used for full-width message/detail rows
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

/** Build a descriptive tooltip for the Address Validation tier pill. */
function tierTitle(s) {
  if (!s) return 'Checking Address Validation billing tier…';
  const parts = [];
  if (s.sku?.name) parts.push(s.sku.name);
  if (s.freeMonthly != null) {
    parts.push(s.callsThisMonth != null
      ? `${Number(s.callsThisMonth).toLocaleString()} / ${Number(s.freeMonthly).toLocaleString()} free calls used this month`
      : `${Number(s.freeMonthly).toLocaleString()} free calls/month`);
  }
  if (s.sku?.unitPrice != null) parts.push(`$${s.sku.unitPrice}/call beyond free`);
  if (s.reason) parts.push(s.reason);
  return parts.join(' · ') || 'Address Validation billing tier';
}

/** Live Address Validation billing tier pill: Free Tier / Paid / Unknown. */
function TierPill({ status }) {
  if (!status) {
    return <span className="tier-pill tier-loading" title={tierTitle(null)}>Checking…</span>;
  }
  const v = status.verdict;
  const cls = v === 'FREE' ? 'tier-free' : v === 'PAYMENT' ? 'tier-paid' : 'tier-unknown';
  const label = v === 'FREE' ? 'Free Tier' : v === 'PAYMENT' ? 'Paid' : 'Unknown';
  return (
    <span className={`tier-pill ${cls}`} title={tierTitle(status)}>
      <span className="tier-dot" aria-hidden="true" />{label}
    </span>
  );
}

/** One patient row plus its expandable list of dates of service. */
function PatientRow({ p, ex, onToggle, onValidate, validating, onDownloadFile, downloading, tier }) {
  const hasFile = !!p.lastFileName && !!p.lastStatementId;
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
        <td>
          <AddressCell addr={p.patientAddress} />
          {p.addressValidated ? (
            <span className="addr-verified" title="Address validated with Google — one-time per patient">
              <ShieldCheckIcon /> Address verified
            </span>
          ) : (
            <button
              className="btn-validate"
              disabled={validating}
              onClick={(e) => { e.stopPropagation(); onValidate(p.key); }}
              title="Validate & standardize this patient's address via Google (one-time per patient)"
            >
              {validating
                ? <span className="btn-inline"><Spinner dark /> Validating…</span>
                : <><ShieldCheckIcon /> Validate</>}
            </button>
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

const nfmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const priceFmt = (p, cur, unit) => {
  if (p == null) return null;
  const c = cur === 'USD' ? '$' : `${cur || ''} `;
  return `${c}${Number(p).toLocaleString('en-US', { maximumFractionDigits: 6 })}${unit ? ` / ${unit}` : ''}`;
};

/**
 * Real-time popup reporting the live Google Address Validation API free-tier / SKU
 * status. The verdict is driven by REAL data: month-to-date call volume from Cloud
 * Monitoring vs. the SKU's free threshold from the Cloud Billing Catalog. When those
 * sources aren't configured/available it reports UNKNOWN honestly — nothing is
 * invented. The base `billingEnabled` fact comes from the live validate call itself.
 */
function ApiStatusModal({ status, onClose }) {
  if (!status) return null;
  const usage = status.usage || null;
  // Prefer the usage-derived verdict (FREE/PAYMENT from real consumption); fall back
  // to the validate-call billing verdict; else UNKNOWN.
  const verdict = usage?.verdict || status.verdict || 'UNKNOWN';
  const cls = verdict === 'FREE' ? 'v-free' : verdict === 'PAYMENT' ? 'v-payment' : 'v-unknown';
  const label = verdict === 'FREE' ? 'FREE TIER' : verdict === 'PAYMENT' ? 'PAYMENT' : 'UNKNOWN';
  const sub = verdict === 'FREE'
    ? 'Within the SKU’s free monthly allowance — not charged'
    : verdict === 'PAYMENT'
      ? 'Free monthly allowance exhausted — usage is billed'
      : (usage && !usage.configured
        ? 'Live usage monitoring not configured'
        : (status.planLabel || 'Live usage could not be determined'));

  const sku = usage?.sku || null;
  const priceStr = sku ? priceFmt(sku.unitPrice, sku.currency, sku.usageUnit) : null;
  const when = (usage?.checkedAt || status.checkedAt) ? new Date(usage?.checkedAt || status.checkedAt) : new Date();
  const whenStr = isNaN(when) ? '' : when.toLocaleString();
  const live = usage?.live ?? status.live;

  return (
    <div className="api-modal-overlay" role="dialog" aria-modal="true" aria-label="Address Validation API status" onClick={onClose}>
      <div className="api-modal" onClick={(e) => e.stopPropagation()}>
        <button className="api-modal-x" onClick={onClose} aria-label="Close">×</button>
        <div className="api-modal-head">
          <span className={`api-live-dot${live ? ' on' : ''}`} aria-hidden="true" />
          <div>
            <h3>Address Validation API</h3>
            <p className="api-modal-provider">{status.provider || 'Google Address Validation API'}</p>
          </div>
        </div>

        <div className={`api-verdict ${cls}`}>
          <span className="api-verdict-label">Billing status</span>
          <span className="api-verdict-value">{label}</span>
          <span className="api-verdict-sub">{sub}</span>
        </div>

        {/* Live SKU pricing + month-to-date usage — each row shown only when the
            underlying figure is really available (SKU pricing works with the API key;
            call volume needs the monitoring service account). */}
        {usage && (sku || usage.callsThisMonth != null || usage.freeMonthly != null) && (
          <dl className="api-facts">
            {sku?.name && <div><dt>SKU</dt><dd>{sku.name}{sku.edition ? ` · ${sku.edition}` : ''}</dd></div>}
            {priceStr && <div><dt>Unit price (beyond free)</dt><dd>{priceStr}</dd></div>}
            {usage.freeMonthly != null && <div><dt>Free monthly allowance</dt><dd>{nfmt(usage.freeMonthly)}</dd></div>}
            {usage.callsThisMonth != null && <div><dt>Calls this month</dt><dd>{nfmt(usage.callsThisMonth)}</dd></div>}
            {usage.remainingFree != null && <div><dt>Free calls remaining</dt><dd>{nfmt(usage.remainingFree)}</dd></div>}
            <div><dt>Sources</dt><dd>{[usage.usageSource === 'cloud_monitoring' && 'Cloud Monitoring', usage.usageSource === 'app_counter' && 'App usage counter', usage.pricingSource === 'billing_catalog' && 'Billing Catalog', usage.pricingSource === 'operator_override' && 'Operator override'].filter(Boolean).join(' · ') || '—'}</dd></div>
          </dl>
        )}

        {/* Base facts from the live validate call. */}
        <dl className="api-facts">
          <div><dt>Mode</dt><dd>{live ? 'Live · real-time' : 'Offline'}</dd></div>
          {status.billingEnabled != null && <div><dt>Billing account</dt><dd>{status.billingEnabled ? 'Enabled' : 'Not enabled'}</dd></div>}
          {status.responseId && <div><dt>Response ID</dt><dd className="mono">{status.responseId}</dd></div>}
          {whenStr && <div><dt>Checked</dt><dd>{whenStr}</dd></div>}
        </dl>

        {(usage?.reason || usage?.notes || status.note) && (
          <p className="api-modal-note">{usage?.reason || usage?.notes || status.note}</p>
        )}
        <button className="btn-primary btn-compact api-modal-ok" onClick={onClose}>Got it</button>
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
  const [pendingList, setPendingList] = useState([]);      // all pending patients (selector)
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false); // true while a page change is in flight
  const [selectedKey, setSelectedKey] = useState('');
  const [generating, setGenerating] = useState('');
  const [validating, setValidating] = useState(''); // patient key being address-validated
  const [apiStatus, setApiStatus] = useState(null); // live Address Validation API plan status (popup)
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

  // Validate one patient's address via Google, persist the standardized result,
  // then refresh so the table (and any open DOS drawer) shows the updated address.
  const onValidate = useCallback(async (key) => {
    if (!key) return;
    setValidating(key);
    try {
      const { validated, api } = await statementsApi.validateAddress(key);
      // Surface the live API plan status as a real-time popup. The validate call proves
      // billing is enabled; enrich it with the live SKU + month-to-date usage (Cloud
      // Monitoring / Billing Catalog) so the free-tier verdict reflects real usage.
      const usage = await statementsApi.addressValidationStatus().then((d) => d.api).catch(() => null);
      if (api || usage) setApiStatus({ ...(api || {}), usage });
      if (usage) setTierStatus(usage); // keep the table's Tier column current
      push(
        `Address ${validated.complete ? 'confirmed' : 'updated'}: ${validated.formatted}`,
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
      // A billing-disabled key still returns an accurate API status — show it.
      const api = err?.response?.data?.api;
      if (api) setApiStatus(api);
      push(err?.response?.data?.message || 'Address validation failed.', 'error');
    } finally {
      setValidating('');
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

      {/* Command hero + KPI row */}
      <header className="dash-hero">
        <div className="dash-hero-head">
          <div>
            <p className="dash-eyebrow">Patient Statements · Control Center</p>
            <h1 className="dash-title">Statement Command Center</h1>
            <p className="dash-sub">Upload, validate, and generate enterprise patient statements in real time.</p>
          </div>
          {fileName && <span className="dash-lastfile" title={fileName}>Last import · {fileName}</span>}
        </div>
        <div className="kpi-grid">
          <div className="kpi k-blue">
            <div className="kpi-top"><span className="kpi-label">Patients</span><span className="kpi-ic"><IconUsers /></span></div>
            <span className="kpi-value">{totals.patients}</span>
          </div>
          <div className="kpi k-violet">
            <div className="kpi-top"><span className="kpi-label">Dates of Service</span><span className="kpi-ic"><IconLayers /></span></div>
            <span className="kpi-value">{totals.dos}</span>
          </div>
          <div className="kpi k-amber">
            <div className="kpi-top"><span className="kpi-label">Pending</span><span className="kpi-ic"><IconClock /></span></div>
            <span className="kpi-value">{totals.pending}</span>
          </div>
          <div className="kpi k-green">
            <div className="kpi-top"><span className="kpi-label">Generated</span><span className="kpi-ic"><IconCheck /></span></div>
            <span className="kpi-value">{totals.generated}</span>
          </div>
        </div>
      </header>

      {/* Control grid: futuristic upload + Send-to-Engine control panel */}
      <div className="control-grid">
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

        {/* Send to Engine — generate a statement for a selected patient */}
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
                  <PatientRow key={p.key} p={p} ex={expanded[p.key]} onToggle={() => loadDos(p.key)} onValidate={onValidate} validating={validating === p.key} onDownloadFile={downloadStored} downloading={downloading === p.key} tier={tierStatus} />
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
