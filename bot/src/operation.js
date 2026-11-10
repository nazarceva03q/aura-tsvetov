'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const scope = new AsyncLocalStorage();
function run(id, fn) { return scope.getStore() ? fn() : scope.run({ id: id || crypto.randomUUID(), sequence: 0, expiresAt: Date.now() + 30 * 86400000 }, fn); }
function next() { const current = scope.getStore(); return current ? { id: current.id + ':' + current.sequence++, expiresAt: current.expiresAt } : null; }
function limit(expiresAt) { const current = scope.getStore(); if (current && Number.isFinite(expiresAt)) current.expiresAt = Math.min(current.expiresAt, expiresAt); }
module.exports = { run, next, limit };
