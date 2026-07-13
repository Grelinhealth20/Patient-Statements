/** Shapes a DB user row into the safe public object returned to the client. */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    statementAccess: Boolean(row.statement_access),
    mustChangePassword: Boolean(row.must_change_password),
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
