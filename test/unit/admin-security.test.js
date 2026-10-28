'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { permissionForPath, hasPermission, validAdminUsername, validAdminPassword } = require('../../src/admin-security');

test('admin paths map to the expected server-side permission', () => {
  assert.equal(permissionForPath('/admin/products/12/edit'), 'content');
  assert.equal(permissionForPath('/admin/articles'), 'content');
  assert.equal(permissionForPath('/admin/orders'), 'orders');
  assert.equal(permissionForPath('/admin/users/9/toggle'), 'users');
  assert.equal(permissionForPath('/admin/settings'), 'settings');
  assert.equal(permissionForPath('/admin/audit'), 'audit');
  assert.equal(permissionForPath('/admin/admins/create'), 'admins');
  assert.equal(permissionForPath('/admin/account/credentials'), 'self');
  assert.equal(permissionForPath('/admin/logout'), 'self');
  assert.equal(permissionForPath('/admin'), 'overview');
});

test('least-privilege role matrix blocks unrelated management areas', () => {
  assert.equal(hasPermission('owner', 'admins'), true);
  assert.equal(hasPermission('admin', 'admins'), false);
  assert.equal(hasPermission('content', 'content'), true);
  assert.equal(hasPermission('content', 'orders'), false);
  assert.equal(hasPermission('orders', 'orders'), true);
  assert.equal(hasPermission('orders', 'users'), false);
  assert.equal(hasPermission('users', 'users'), true);
  assert.equal(hasPermission('users', 'settings'), false);
  assert.equal(hasPermission('unknown', 'overview'), false);
});

test('admin usernames and passwords follow the server-side policy', () => {
  assert.equal(validAdminUsername('Site.Owner_1'), true);
  assert.equal(validAdminUsername('ab'), false);
  assert.equal(validAdminUsername('contains space'), false);
  assert.equal(validAdminUsername('admin<script>'), false);
  assert.equal(validAdminPassword('this-is-a-long-password'), true);
  assert.equal(validAdminPassword('short'), false);
  assert.equal(validAdminPassword('x'.repeat(201)), false);
});
