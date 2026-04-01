import assert from 'node:assert/strict';
import {
  getAdminSoundEventForTableRequest,
} from '../src/lib/adminSoundAlerts.js';

assert.equal(getAdminSoundEventForTableRequest('call_waiter'), 'call_waiter');
assert.equal(getAdminSoundEventForTableRequest('request_bill'), 'request_bill');
assert.equal(getAdminSoundEventForTableRequest('unknown'), 'call_waiter');

console.log('Admin sound helper tests passed');
