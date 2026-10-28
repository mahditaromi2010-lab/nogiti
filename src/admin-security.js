'use strict';

const BCRYPT_MAX_BYTES = 72;
const ROLES = Object.freeze(['owner', 'admin', 'content', 'orders', 'users']);
const ROLE_LABELS = Object.freeze({ owner: 'مدیر اصلی', admin: 'مدیر', content: 'مدیر محتوا', orders: 'مدیر سفارش‌ها', users: 'مدیر کاربران' });

// 'support' (ticket access) is granted to the broad admin roles only (owner, admin), the same way
// 'audit' and 'settings' already are - it is not split into its own admin_accounts role, following the
// existing pattern of adding a capability to the permission map rather than growing the role enum.
const rolePermissions = Object.freeze({
  owner: new Set(['overview', 'content', 'orders', 'users', 'settings', 'audit', 'admins', 'support', 'self']),
  admin: new Set(['overview', 'content', 'orders', 'users', 'settings', 'audit', 'support', 'self']),
  content: new Set(['content', 'self']),
  orders: new Set(['orders', 'self']),
  users: new Set(['users', 'self'])
});

/** Landing page for roles that cannot see the overview. */
const ROLE_HOME = Object.freeze({ owner: '/admin', admin: '/admin', content: '/admin/products', orders: '/admin/orders', users: '/admin/users' });

function permissionForPath(pathname) {
  const path = String(pathname || '/').replace(/^\/admin\/?/, '').split('/').filter(Boolean);
  const section = path[0] || 'overview';
  if (section === 'admins') return 'admins';
  if (section === 'account' || section === 'logout') return 'self';
  if (section === 'products' || section === 'articles' || section === 'article-images' || section === 'assets' || section === 'team') return 'content';
  if (section === 'orders') return 'orders';
  if (section === 'users') return 'users';
  if (section === 'settings') return 'settings';
  if (section === 'audit') return 'audit';
  if (section === 'tickets') return 'support';
  return 'overview';
}

function hasPermission(role, permission) {
  return Boolean(rolePermissions[role] && rolePermissions[role].has(permission));
}
function validAdminUsername(value) {
  return /^[a-z0-9_.-]{3,64}$/.test(String(value || '').trim().toLowerCase());
}
function validAdminPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 200;
}
/** Password policy with context: length plus "must not contain the username". Returns an error message or null. */
function adminPasswordProblem(password, username = '') {
  if (!validAdminPassword(password)) return 'رمز عبور باید بین ۱۲ تا ۲۰۰ نویسه باشد.';
  // bcrypt only uses the first 72 bytes; anything longer would silently be ignored.
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) return 'رمز عبور حداکثر ۷۲ بایت می‌تواند باشد (حدود ۷۲ نویسهٔ انگلیسی یا ۳۶ نویسهٔ فارسی).';
  const u = String(username || '').trim().toLowerCase();
  if (u && u.length >= 3 && password.toLowerCase().includes(u)) return 'رمز عبور نباید شامل نام کاربری باشد.';
  if (/^(.)\1+$/.test(password)) return 'رمز عبور نباید از تکرار یک نویسه ساخته شود.';
  return null;
}
function validRole(role) { return ROLES.includes(role); }

module.exports = { ROLES, ROLE_LABELS, ROLE_HOME, rolePermissions, permissionForPath, hasPermission, validAdminUsername, validAdminPassword, adminPasswordProblem, validRole };
