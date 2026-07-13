import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { statementsApi } from '../api/client.js';
import { useToast } from '../components/Toast.jsx';
import { groupStatements, buildStatementDoc, buildBlankTemplateDoc } from '../lib/statementPdf.js';

const TEMPLATE_KEY = '__template__';

const money = (n) =>
  `$${(Number(String(n).replace(/[^0-9.\-]/g, '')) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const safeName = (str) => String(str || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'statement';

function EngineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M16.9 16.9l2.1 2.1M19.1 4.9l-2.1 2.1M7 16.9l-2.1 2.1" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
      <path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" />
    </svg>
  );
}
function StatusPill({ status }) {
  const generated = status === 'generated';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
      fontSize: 12, fontWeight: 700, color: generated ? '#167A4D' : '#B45309',
      background: generated ? '#E7F6EE' : '#FEF3E2', border: `1px solid ${generated ? '#B7E3CB' : '#F6D9A8'}`,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: generated ? '#167A4D' : '#D97706' }} />
      {generated ? 'Generated' : 'Pending'}
    </span>
  );
}

export default function StatementEngine() {
  const { push } = useToast();
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null); // { key, url, title }
  const previewRef = useRef(null);

  useEffect(() => {
    let alive = true;
    statementsApi.patients()
      .then(({ patients: list }) => { if (alive) setPatients(list || []); })
      .catch(() => { if (alive) push('Could not load patients from the server.', 'error'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [push]);

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview?.url]);
  useEffect(() => { if (preview) previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [preview?.key]);

  const totals = useMemo(() => ({
    patients: patients.length,
    dos: patients.reduce((t, p) => t + p.dosCount, 0),
    generated: patients.filter((p) => p.pendingCount === 0 && p.dosCount > 0).length,
  }), [patients]);

  const buildDocForKey = useCallback(async (key) => {
    const { dos } = await statementsApi.patientDos(key);
    const rows = (dos || []).map((d) => d.data);
    const groups = groupStatements(rows);
    return groups.length ? buildStatementDoc(groups[0]) : buildBlankTemplateDoc();
  }, []);

  const showPreview = useCallback(async (key, title, makeDocAsync) => {
    try {
      if (preview?.url) URL.revokeObjectURL(preview.url);
      if (preview?.key === key) { setPreview(null); return; }
      setBusy(key);
      const doc = await makeDocAsync();
      const url = String(doc.output('bloburl'));
      setPreview({ key, url, title });
    } catch {
      push('Failed to render the preview.', 'error');
    } finally {
      setBusy('');
    }
  }, [preview, push]);

  const onPreview = (p) => showPreview(p.key, `Statement Preview · ${p.patientName || p.accountNumber}`, () => buildDocForKey(p.key));
  const onPreviewTemplate = () => showPreview(TEMPLATE_KEY, 'Blank Statement Template', async () => buildBlankTemplateDoc());

  const onDownload = async (p) => {
    setBusy(p.key);
    try {
      const doc = await buildDocForKey(p.key);
      doc.save(p.lastFileName || `Statement_${safeName(p.patientName || p.accountNumber)}.pdf`);
      push(`Statement PDF downloaded for ${p.patientName || p.accountNumber}.`);
    } catch {
      push('Failed to generate the statement PDF.', 'error');
    } finally {
      setBusy('');
    }
  };

  const closePreview = () => { if (preview?.url) URL.revokeObjectURL(preview.url); setPreview(null); };

  const previewPanel = preview && (
    <section className="panel" ref={previewRef}>
      <div className="panel-head">
        <div className="panel-title-wrap"><h2>{preview.title}</h2></div>
        <button className="btn-ghost danger" onClick={closePreview}>Close</button>
      </div>
      <iframe title="Statement preview" src={preview.url}
        style={{ width: '100%', height: '82vh', border: 'none', display: 'block', background: '#fff' }} />
    </section>
  );

  if (!loading && patients.length === 0) {
    return (
      <div className="stmt-view">
        <section className="blank-canvas">
          <div className="blank-inner">
            <div className="blank-icon"><EngineIcon /></div>
            <h2>Statement Engine</h2>
            <p>
              No statement data loaded yet. Upload a CSV or Excel file on the{' '}
              <Link to="/statements" className="dz-link">Dashboard</Link> and every date of service will be
              grouped by patient here in real time.
            </p>
            <button className="btn-primary btn-compact" style={{ marginTop: 18 }} onClick={onPreviewTemplate}>
              {preview?.key === TEMPLATE_KEY ? 'Hide Template' : 'View Blank Template'}
            </button>
            <span className="blank-tag" style={{ display: 'block', marginTop: 14 }}>ENGINE · AWAITING DATA</span>
          </div>
        </section>
        {previewPanel}
      </div>
    );
  }

  return (
    <div className="stmt-view">
      <div className="page-head">
        <div>
          <h1>Statement Engine</h1>
          <p className="page-desc">
            {totals.patients} patient statement{totals.patients === 1 ? '' : 's'} · every date of service is
            consolidated per patient. Generation and status are managed on the{' '}
            <Link to="/statements" className="dz-link">Dashboard</Link>; preview and download the rendered PDFs here.
          </p>
        </div>
        <button className="btn-secondary btn-compact" onClick={onPreviewTemplate}>
          {preview?.key === TEMPLATE_KEY ? 'Hide Template' : 'View Template'}
        </button>
      </div>

      <div className="stat-grid">
        <div className="stat-card accent-blue"><div className="stat-top"><span className="stat-label">Patients</span></div><span className="stat-value">{totals.patients}</span></div>
        <div className="stat-card accent-violet"><div className="stat-top"><span className="stat-label">Dates of Service</span></div><span className="stat-value">{totals.dos}</span></div>
        <div className="stat-card accent-green"><div className="stat-top"><span className="stat-label">Fully Generated</span></div><span className="stat-value">{totals.generated}</span></div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-title-wrap"><h2>Generated Statements</h2><span className="count-badge">{patients.length}</span></div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Account Number</th>
                <th className="ta-right">DOS</th>
                <th>Status</th>
                <th>File Name</th>
                <th className="ta-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="table-empty">Loading…</td></tr>
              ) : patients.map((p) => (
                <tr key={p.key}>
                  <td><div className="cell-user"><strong>{p.patientName || '—'}</strong></div></td>
                  <td className="mono">{p.accountNumber || '—'}</td>
                  <td className="ta-right">{p.dosCount}</td>
                  <td><StatusPill status={p.status} /></td>
                  <td className="mono" title={p.lastFileName}>{p.lastFileName || '—'}</td>
                  <td className="ta-right">
                    <div className="row-actions">
                      <button className="btn-ghost" disabled={busy === p.key} onClick={() => onPreview(p)}>
                        {preview?.key === p.key ? 'Hide' : busy === p.key ? '…' : 'Preview'}
                      </button>
                      <button className="btn-ghost" disabled={busy === p.key} onClick={() => onDownload(p)}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><DownloadIcon /> Download</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {previewPanel}
    </div>
  );
}
