// ws.js is the whole transport, and on bridgething it is a direct client of the
// Mac daemon's hub rather than two relays away. These drive it through a fake
// socket: no network, no device, no daemon.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import * as ws from '../src/ws.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.last = this;
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  deliver(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }
}

function fresh(url) {
  ws.reset();
  ws.configure({ url: url, factory: function (u) { return new FakeSocket(u); } });
  ws.start();
  return FakeSocket.last;
}

// The reconnect backoff is real: a closed socket schedules a retry that would
// otherwise hold the test process open. reset() cancels it.
test.after(() => { ws.reset(); });

test('connects to the daemon on the device loopback by default', () => {
  const s = fresh();
  assert.equal(s.url, 'ws://127.0.0.1:8790/ws');
});

test('bridge.hello is the first frame on the wire', () => {
  const s = fresh();
  s.open();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].method, 'bridge.hello');
  assert.equal(s.sent[0].params.role, 'device');
});

test('a response resolves the request that carries its id', async () => {
  const s = fresh();
  s.open();
  const p = ws.request('claude.usage.get', {});
  const id = s.sent[s.sent.length - 1].id;
  s.deliver({ type: 'response', id: id, result: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });
});

test('an error frame rejects its request', async () => {
  const s = fresh();
  s.open();
  const p = ws.request('claude.session.get', { id: 'nope' });
  const id = s.sent[s.sent.length - 1].id;
  s.deliver({ type: 'error', id: id, error: 'unknown session' });
  await assert.rejects(p, /unknown session/);
});

test('events reach the listeners registered for their topic', () => {
  const s = fresh();
  s.open();
  const seen = [];
  ws.on('claude.usage.update', (d) => seen.push(d));
  s.deliver({ type: 'event', topic: 'claude.usage.update', data: { limits: [] } });
  assert.deepEqual(seen, [{ limits: [] }]);
});

test('a request made while the socket is down rejects rather than hanging', async () => {
  fresh();
  await assert.rejects(ws.request('claude.ping', {}), /socket not open/);
});

test('a request the daemon never answers rejects on its own timeout', async () => {
  const s = fresh();
  s.open();
  await assert.rejects(
    ws.request('claude.sessions.list', {}, 1),
    /timeout: claude\.sessions\.list/
  );
});

test('onClose fires when the link drops — the app has no other offline signal', () => {
  const s = fresh();
  s.open();
  let closed = 0;
  ws.onClose(() => { closed++; });
  s.close();
  assert.equal(closed, 1);
});

// A permission answer sent as the tunnel drops has already failed. Left to its
// own timeout it would toast SEND FAILED ten seconds later, over a screen that
// has been showing OFFLINE the whole time.
test('a request in flight when the link drops rejects at once, not on its timeout', async () => {
  const s = fresh();
  s.open();
  const p = ws.request('claude.permission.answer', { requestId: 'x', decision: 'allow' });
  s.close();
  await assert.rejects(p, /socket closed/);
});

// The rejections above are raised by the transport, not asked for by the
// caller, so they must not punish a fire-and-forget send. node:test fails the
// run on an unhandled rejection, which is exactly the regression being fenced.
test('a transport-raised rejection never lands as an unhandled rejection', () => {
  const s = fresh();
  s.open();
  ws.request('claude.usage.get', {});    // deliberately no .catch
  ws.reset();
});

test('onOpen fires immediately for a listener registered after the socket is up', () => {
  const s = fresh();
  s.open();
  let fired = 0;
  ws.onOpen(() => { fired++; });
  assert.equal(fired, 1);
});

// The reconnect is the only recovery there is now that claude.daemon.status is
// gone, so the backoff curve is load-bearing, not incidental.
test('a dropped link reconnects, and backs off further each failed attempt', (t) => {
  // Order matters: a mocked clearTimeout cannot cancel a *real* timer handle,
  // so the previous test's in-flight bridge.hello has to be cleared with the
  // real one still installed or it holds the process open for its full 10s.
  ws.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); });

  const first = fresh();
  first.open();
  first.close();

  mock.timers.tick(999);
  assert.equal(FakeSocket.last, first, 'must not retry before the 1s backoff');
  mock.timers.tick(1);
  const second = FakeSocket.last;
  assert.notEqual(second, first, 'a close must bring up a new socket');

  // This one never opened, so attempts keeps climbing: the next wait is 2s.
  second.close();
  mock.timers.tick(1999);
  assert.equal(FakeSocket.last, second, 'the second wait must be longer than the first');
  mock.timers.tick(1);
  assert.notEqual(FakeSocket.last, second);
});

// Dropping the reference is not enough — the handlers close over module state,
// so an undetached orphan fires the live transport's listeners and starts a
// second reconnect loop next to the first.
test('reset detaches the old socket instead of orphaning it', () => {
  const orphan = fresh();
  orphan.open();

  const live = fresh();          // reset() + start() again
  live.open();

  // Unwiring alone would leave a real socket holding an open connection to the
  // daemon, so reset() has to close it too, not just forget it.
  assert.equal(orphan.readyState, 3, 'reset must close the socket it lets go of');

  let closed = 0;
  ws.onClose(() => { closed++; });
  orphan.close();

  assert.equal(closed, 0, 'an orphan must not fire the live transport close listeners');
  assert.equal(FakeSocket.last, live, 'an orphan must not start a second reconnect loop');
});
