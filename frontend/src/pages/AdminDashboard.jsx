import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';

const emptyForm = { username: '', email: '', fullName: '', password: '', role: 'user', statementAccess: true };

export default function AdminDashboard() {
  const { user: me } = useAuth();
  const { push } = useToast();

  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState({ total: 0, superAdmins: 0, active: 0, withStatementAccess: 0 });
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [wipeOpen, setWipeOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [uRes, sRes] = await Promise.all([
        api.get('/admin/users'),
        api.get('/admin/stats'),
      ]);
      setUsers(uRes.data.users);
      setStats(sRes.data.stats);
    } catch (err) {
      push(err.response?.data?.message || 'Failed to load users.', 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.fullName || '').toLowerCase().includes(q)
    );
  }, [users, query]);

  const toggleAccess = async (u) => {
    try {
      const { data } = await api.patch(`/admin/users/${u.id}/access`, {
        statementAccess: !u.statementAccess,
      });
      setUsers((list) => list.map((x) => (x.id === u.id ? data.user : x)));
      push(`Statement access ${data.user.statementAccess ? 'granted to' : 'restricted for'} ${u.username}.`);
      load();
    } catch (err) {
      push(err.response?.data?.message || 'Could not update access.', 'error');
    }
  };

  const toggleActive = async (u) => {
    try {
      const { data } = await api.put(`/admin/users/${u.id}`, { isActive: !u.isActive });
      setUsers((list) => list.map((x) => (x.id === u.id ? data.user : x)));
      push(`${u.username} ${data.user.isActive ? 'activated' : 'deactivated'}.`);
      load();
    } catch (err) {
      push(err.response?.data?.message || 'Could not update status.', 'error');
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Admin Panel</h1>
          <p className="page-desc">
            Create, edit and govern users, reset passwords, and control access to
            the Statement Generator.
          </p>
        </div>
        <button className="btn-primary btn-compact" onClick={() => setCreateOpen(true)}>
          + New User
        </button>
      </header>

      <section className="stat-grid">
        <StatCard label="Total Users" value={stats.total} accent="blue" icon={<StatIcon name="users" />} />
        <StatCard label="Active Accounts" value={stats.active} accent="green" icon={<StatIcon name="check" />} />
        <StatCard label="Super Admins" value={stats.superAdmins} accent="violet" icon={<StatIcon name="shield" />} />
        <StatCard label="Statement Access" value={stats.withStatementAccess} accent="amber" icon={<StatIcon name="doc" />} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-title-wrap">
            <h2>User Directory</h2>
            <span className="count-badge">{filtered.length}</span>
          </div>
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" />
            </svg>
            <input
              placeholder="Search by name, username or email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Statement Access</th>
                <th>Status</th>
                <th className="ta-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="table-empty">Loading users…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} className="table-empty">No users found.</td></tr>
              ) : (
                filtered.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="cell-user">
                        <div className="avatar avatar-sm">
                          {(u.fullName || u.username).slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <strong>{u.fullName || u.username}</strong>
                          <span className="cell-sub">{u.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`role-tag ${u.role === 'super_admin' ? 'role-super' : 'role-user'}`}>
                        {u.role === 'super_admin' ? 'Super Admin' : 'Operator'}
                      </span>
                    </td>
                    <td>
                      {u.role === 'super_admin' ? (
                        <span className="muted">Full (always)</span>
                      ) : (
                        <button
                          className={`toggle ${u.statementAccess ? 'on' : 'off'}`}
                          onClick={() => toggleAccess(u)}
                          title="Toggle Statement Generator access"
                        >
                          <span className="knob" />
                          <span className="toggle-text">{u.statementAccess ? 'Allowed' : 'Restricted'}</span>
                        </button>
                      )}
                    </td>
                    <td>
                      <button
                        className={`status-tag ${u.isActive ? 'active' : 'inactive'}`}
                        onClick={() => toggleActive(u)}
                        disabled={u.id === me.id}
                        title={u.id === me.id ? 'You cannot change your own status' : 'Toggle account status'}
                      >
                        {u.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="ta-right">
                      <div className="row-actions">
                        <button className="btn-ghost" onClick={() => setEditTarget(u)}>Edit</button>
                        <button className="btn-ghost" onClick={() => setResetTarget(u)}>Reset&nbsp;PW</button>
                        <button
                          className="btn-ghost danger"
                          onClick={() => setDeleteTarget(u)}
                          disabled={u.id === me.id}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Danger Zone — destructive, super-admin-only data purge. */}
      <section className="panel danger-zone">
        <div className="panel-head">
          <div className="panel-title-wrap">
            <h2>Danger Zone</h2>
          </div>
        </div>
        <div className="danger-row">
          <div className="danger-copy">
            <strong>Delete all data</strong>
            <span className="switch-sub">
              Permanently wipes every patient statement, date of service and stored PDF
              from the database and S3. User accounts are preserved so the app keeps
              working. This cannot be undone.
            </span>
          </div>
          <button className="btn-danger" onClick={() => setWipeOpen(true)}>Delete All Data</button>
        </div>
      </section>

      {wipeOpen && (
        <WipeAllModal
          onClose={() => setWipeOpen(false)}
          onWiped={() => setWipeOpen(false)}
        />
      )}

      {createOpen && (
        <UserFormModal
          mode="create"
          onClose={() => setCreateOpen(false)}
          onSaved={() => { setCreateOpen(false); load(); }}
        />
      )}
      {editTarget && (
        <UserFormModal
          mode="edit"
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); load(); }}
        />
      )}
      {resetTarget && (
        <ResetPasswordModal
          target={resetTarget}
          onClose={() => setResetTarget(null)}
          onSaved={() => setResetTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteModal
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); load(); }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, accent, icon }) {
  return (
    <div className={`stat-card accent-${accent}`}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className="stat-ic">{icon}</span>
      </div>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function StatIcon({ name }) {
  const paths = {
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 3.5a3 3 0 0 1 0 5.8M21 20c0-2.4-1.4-4.4-3.4-5.3" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.2 2.2L15.5 10" /></>,
    shield: <><path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6l7-3z" /><path d="M9.5 12l1.8 1.8L15 10" /></>,
    doc: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function UserFormModal({ mode, target, onClose, onSaved }) {
  const { push } = useToast();
  const [form, setForm] = useState(
    mode === 'edit'
      ? {
          username: target.username,
          email: target.email,
          fullName: target.fullName || '',
          role: target.role,
          statementAccess: target.statementAccess,
          isActive: target.isActive,
        }
      : { ...emptyForm }
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'create') {
        await api.post('/admin/users', form);
        push(`User "${form.username}" created.`);
      } else {
        await api.put(`/admin/users/${target.id}`, {
          email: form.email,
          fullName: form.fullName,
          role: form.role,
          statementAccess: form.statementAccess,
          isActive: form.isActive,
        });
        push(`User "${form.username}" updated.`);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === 'create' ? 'Create New User' : `Edit ${target.username}`}
      subtitle={mode === 'create' ? 'Provision a new account' : 'Update account details and access'}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" form="user-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : mode === 'create' ? 'Create User' : 'Save Changes'}
          </button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="form-grid">
        {error && <div className="alert alert-error">{error}</div>}

        <label className="field">
          <span className="field-label">Username</span>
          <input
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
            disabled={mode === 'edit'}
            required
          />
        </label>

        <label className="field">
          <span className="field-label">Full Name</span>
          <input value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
        </label>

        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required />
        </label>

        {mode === 'create' && (
          <label className="field">
            <span className="field-label">Temporary Password</span>
            <input
              type="text"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder="Min. 8 characters"
              required
            />
          </label>
        )}

        <label className="field">
          <span className="field-label">Role</span>
          <select value={form.role} onChange={(e) => set('role', e.target.value)}>
            <option value="user">Operator (Statement Generator)</option>
            <option value="super_admin">Super Admin (Full Access)</option>
          </select>
        </label>

        <div className="switch-row">
          <div>
            <strong>Statement Generator Access</strong>
            <span className="switch-sub">Allow this user to use the generator</span>
          </div>
          <button
            type="button"
            className={`toggle ${form.statementAccess ? 'on' : 'off'}`}
            onClick={() => set('statementAccess', !form.statementAccess)}
          >
            <span className="knob" />
            <span className="toggle-text">{form.statementAccess ? 'Allowed' : 'Restricted'}</span>
          </button>
        </div>

        {mode === 'edit' && (
          <div className="switch-row">
            <div>
              <strong>Account Status</strong>
              <span className="switch-sub">Deactivated users cannot sign in</span>
            </div>
            <button
              type="button"
              className={`toggle ${form.isActive ? 'on' : 'off'}`}
              onClick={() => set('isActive', !form.isActive)}
            >
              <span className="knob" />
              <span className="toggle-text">{form.isActive ? 'Active' : 'Inactive'}</span>
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ target, onClose, onSaved }) {
  const { push } = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post(`/admin/users/${target.id}/reset-password`, { newPassword: pw });
      push(`Password reset for ${target.username}.`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'Reset failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Reset Password"
      subtitle={`Set a new password for ${target.username}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" form="reset-form" type="submit" disabled={busy}>
            {busy ? 'Resetting…' : 'Reset Password'}
          </button>
        </>
      }
    >
      <form id="reset-form" onSubmit={submit} className="form-grid">
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span className="field-label">New Password</span>
          <input
            type="text"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Min. 8 characters"
            required
            autoFocus
          />
        </label>
        <p className="hint">The user's active sessions will be revoked immediately.</p>
      </form>
    </Modal>
  );
}

function DeleteModal({ target, onClose, onDeleted }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await api.delete(`/admin/users/${target.id}`);
      push(`${target.username} deleted.`);
      onDeleted();
    } catch (err) {
      setError(err.response?.data?.message || 'Delete failed.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Delete User"
      subtitle="This action cannot be undone"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-danger" onClick={confirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete Permanently'}
          </button>
        </>
      }
    >
      {error && <div className="alert alert-error">{error}</div>}
      <p className="confirm-text">
        Are you sure you want to permanently delete{' '}
        <strong>{target.fullName || target.username}</strong> ({target.email})?
      </p>
    </Modal>
  );
}

const WIPE_PHRASE = 'DELETE ALL';

/**
 * Type-to-confirm modal for the destructive full data wipe. The Delete button stays
 * disabled until the operator types the exact confirmation phrase; the server also
 * enforces super-admin + the same phrase, so this is defense-in-depth, not the gate.
 */
function WipeAllModal({ onClose, onWiped }) {
  const { push } = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = text.trim() === WIPE_PHRASE;

  const confirm = async () => {
    if (!ok) { setError(`Type "${WIPE_PHRASE}" exactly to confirm.`); return; }
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/admin/wipe-all', { confirm: WIPE_PHRASE });
      push(
        `All data wiped: ${data.statementDosDeleted} DOS · ${data.statementsDeleted} statements · ${data.s3ObjectsDeleted} stored PDFs removed.`,
        'success'
      );
      if (data.s3Error) push(`Note: some S3 objects could not be removed (${data.s3Error}).`, 'error');
      onWiped();
    } catch (err) {
      setError(err.response?.data?.message || 'Wipe failed.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Delete ALL Data"
      subtitle="Permanently erase all patient data and stored PDFs"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-danger" onClick={confirm} disabled={busy || !ok}>
            {busy ? 'Wiping…' : 'Permanently Delete Everything'}
          </button>
        </>
      }
    >
      {error && <div className="alert alert-error">{error}</div>}
      <p className="confirm-text">
        This permanently deletes <strong>every patient statement, date of service and stored PDF</strong>{' '}
        from the database and the S3 bucket. <strong>User accounts are kept</strong> so the app keeps working.{' '}
        <strong>This cannot be undone.</strong>
      </p>
      <label className="field">
        <span className="field-label">Type <strong>{WIPE_PHRASE}</strong> to confirm</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={WIPE_PHRASE}
          autoFocus
          autoComplete="off"
        />
      </label>
    </Modal>
  );
}
