import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import { buildBlankTemplateDoc, downloadBlankTemplate } from '../lib/statementPdf.js';

/* Minimum time the processing animation stays on screen so the render always
   reads as a deliberate, enterprise-grade operation (never a jarring flash). */
const MIN_PROCESSING_MS = 650;

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
      <path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" />
    </svg>
  );
}
function EngineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M16.9 16.9l2.1 2.1M19.1 4.9l-2.1 2.1M7 16.9l-2.1 2.1" />
    </svg>
  );
}

/** Enterprise-grade processing animation shown while the template renders. */
function ProcessingOverlay({ label }) {
  return (
    <div className="engine-processing" role="status" aria-live="polite">
      <div className="engine-loader" aria-hidden="true">
        <span className="engine-orbit" />
        <span className="engine-orbit o2" />
        <span className="engine-core"><EngineIcon /></span>
      </div>
      <p className="engine-processing-title">{label}</p>
      <div className="engine-progress"><span /></div>
      <span className="engine-processing-sub">ENTERPRISE STATEMENT ENGINE</span>
    </div>
  );
}

/**
 * Statement Engine — a single-purpose template stage.
 *
 * It renders the statement template (visible by default) with a processing
 * animation, and exposes template generation (view / download, colored or
 * completely blank & white). Patient data, KPIs and per-patient tables live on
 * the Dashboard; the Engine intentionally shows only the template + generation.
 */
export default function StatementEngine() {
  const { push } = useToast();
  const [variant, setVariant] = useState('color'); // 'color' | 'white'
  const [url, setUrl] = useState('');
  const [processing, setProcessing] = useState(true);
  const urlRef = useRef('');

  // Build the blank template PDF for the active variant and show it in the stage.
  // Runs on mount and whenever the variant changes. A setTimeout (not rAF, which
  // can be throttled in background/preview contexts) defers the synchronous jsPDF
  // build one macrotask so the processing animation paints first.
  useEffect(() => {
    let cancelled = false;
    setProcessing(true);
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = ''; }
    setUrl('');
    const start = Date.now();
    const build = setTimeout(() => {
      let blobUrl;
      try {
        const doc = buildBlankTemplateDoc(variant === 'white');
        blobUrl = String(doc.output('bloburl'));
      } catch {
        if (!cancelled) { push('Failed to render the statement template.', 'error'); setProcessing(false); }
        return;
      }
      urlRef.current = blobUrl;
      const wait = Math.max(0, MIN_PROCESSING_MS - (Date.now() - start));
      setTimeout(() => { if (!cancelled) { setUrl(blobUrl); setProcessing(false); } }, wait);
    }, 30);
    return () => { cancelled = true; clearTimeout(build); if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = ''; } };
  }, [variant, push]);

  const onDownloadTemplate = (mono) => {
    try {
      downloadBlankTemplate(mono);
      push(`Downloaded the ${mono ? 'completely blank & white' : 'colored'} statement template.`);
    } catch {
      push('Failed to download the template.', 'error');
    }
  };

  const variantLabel = variant === 'white' ? 'BLANK · WHITE' : 'COLORED';

  return (
    <div className="stmt-view engine-view">
      <div className="page-head">
        <div>
          <h1>Statement Engine</h1>
          <p className="page-desc">
            The enterprise statement template, rendered live. Patient generation, validation and status
            are managed on the <Link to="/statements" className="dz-link">Dashboard</Link>.
          </p>
        </div>
        <div className="row-actions" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={() => onDownloadTemplate(true)} title="Completely blank & white, properly structured template">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><DownloadIcon /> Blank · White</span>
          </button>
          <button className="btn-primary btn-compact" onClick={() => onDownloadTemplate(false)} title="Full-color structured template">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><DownloadIcon /> Colored</span>
          </button>
        </div>
      </div>

      <section className="panel template-stage-panel">
        <div className="panel-head">
          <div className="panel-title-wrap">
            <h2>Statement Template</h2>
            <span className="count-badge">{variantLabel}</span>
          </div>
          <div className="seg-toggle" role="tablist" aria-label="Template style">
            <button
              type="button"
              role="tab"
              aria-selected={variant === 'color'}
              className={variant === 'color' ? 'active' : ''}
              onClick={() => setVariant('color')}
            >
              Colored
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={variant === 'white'}
              className={variant === 'white' ? 'active' : ''}
              onClick={() => setVariant('white')}
            >
              Blank · White
            </button>
          </div>
        </div>

        <div className="template-stage">
          {processing && (
            <ProcessingOverlay label={`Rendering ${variant === 'white' ? 'blank & white' : 'colored'} template…`} />
          )}
          {url && (
            <iframe
              title="Statement template"
              src={url}
              className="template-frame"
              onLoad={() => setProcessing(false)}
              style={{ opacity: processing ? 0 : 1 }}
            />
          )}
        </div>
      </section>
    </div>
  );
}
