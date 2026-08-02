// Singleton WebSocket to the claude-thing Mac daemon. On bridgething the daemon
// reaches the device through `ssh -R 8790:127.0.0.1:8790`, and loopback is the
// one address the kiosk's SOCKS proxy does not swallow — so this is a direct
// hub client, not two relays away. No MsgPack boundary, so no unbool(); no
// chunking limit on the path, so claude.sessions.list is taken unbounded.

var DEFAULT_URL = 'ws://127.0.0.1:8790/ws';
var OPEN = 1;

var socket = null;
var pending = {};            // id -> {resolve, reject, timer, promise}
var topicListeners = {};     // topic -> [fn]
var openListeners = [];
var closeListeners = [];
var attempts = 0;
var started = false;
var reconnectTimer = null;
var url = DEFAULT_URL;
var factory = function (u) { return new WebSocket(u); };

export function configure(opts) {
  if (opts && opts.url) url = opts.url;
  if (opts && opts.factory) factory = opts.factory;
}

// Settle everything in flight now rather than letting each one die by its own
// 10s timeout. A permission answer sent as the tunnel drops has already failed;
// surfacing SEND FAILED ten seconds later, over a screen that has been showing
// OFFLINE the whole time, reads as a daemon bug.
//
// The inert .catch is not decoration. These rejections are raised by us, not
// requested by the caller, so a caller that never attached a handler — entirely
// reasonable for fire-and-forget — would otherwise take the process down with
// an unhandled rejection. Attaching our own handler marks it handled while
// still delivering the rejection to any handler the caller did attach.
function failPending(message) {
  var ids = Object.keys(pending);
  for (var i = 0; i < ids.length; i++) {
    var p = pending[ids[i]];
    delete pending[ids[i]];
    clearTimeout(p.timer);
    if (p.promise) p.promise.catch(function () {});
    p.reject(new Error(message));
  }
}

// Unwire a socket before letting go of it. Dropping the reference alone is not
// enough: the handlers close over module state, so an orphan that later closes
// would fire the *current* transport's close listeners and start a second
// reconnect loop alongside the first.
function detach(s) {
  if (!s) return;
  try { s.onopen = s.onmessage = s.onclose = s.onerror = null; } catch (e) {}
  try { s.close(); } catch (e) {}
}

// Tests only: drop all state so each case starts from a clean transport. Both
// kinds of live timer go with it — a scheduled reconnect would otherwise
// reconnect the *next* test's transport, and an in-flight request's timeout
// (bridge.hello's, every time, since a fake socket never answers it) would
// hold the process open for its full 10s.
export function reset() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  failPending('transport reset');
  detach(socket);
  socket = null; pending = {}; topicListeners = {};
  openListeners = []; closeListeners = [];
  attempts = 0; started = false; url = DEFAULT_URL;
  factory = function (u) { return new WebSocket(u); };
}

function uuid() {
  // no crypto.randomUUID on Chrome 69
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function connect() {
  reconnectTimer = null;
  // Every handler below is guarded on this captured reference. A socket that
  // has been replaced must not resolve the current transport's requests, fire
  // its close listeners, or schedule its reconnect.
  var s = factory(url);
  socket = s;

  s.onopen = function () {
    if (s !== socket) return;
    attempts = 0;
    // The hub answers this by firing onHello, which is the only moment a
    // restarted daemon can correct a screen that has been showing stale tiles.
    // Not cosmetic — send it before anything else.
    request('bridge.hello', { role: 'device', info: { app: 'claude-thing' } })
      .catch(function () {});
    for (var i = 0; i < openListeners.length; i++) openListeners[i]();
  };

  s.onmessage = function (m) {
    if (s !== socket) return;
    var f;
    try { f = JSON.parse(m.data); } catch (e) { return; }
    if (f.type === 'event' && f.topic) {
      var fns = topicListeners[f.topic] || [];
      for (var i = 0; i < fns.length; i++) fns[i](f.data, f);
      return;
    }
    if ((f.type === 'response' || f.type === 'error') && pending[f.id]) {
      var p = pending[f.id];
      delete pending[f.id];
      clearTimeout(p.timer);
      if (f.type === 'response') p.resolve(f.result);
      else p.reject(new Error(f.error || 'request failed'));
    }
  };

  s.onclose = function () {
    if (s !== socket) return;
    failPending('socket closed');
    for (var i = 0; i < closeListeners.length; i++) closeListeners[i]();
    attempts++;
    var delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
    reconnectTimer = setTimeout(connect, delay);
  };
  s.onerror = function () {
    try { s.close(); } catch (e) {}
  };
}

export function start() {
  if (started) return;
  started = true;
  connect();
}

export function request(method, params, timeoutMs) {
  var entry = null;
  var p = new Promise(function (resolve, reject) {
    if (!socket || socket.readyState !== OPEN) {
      return reject(new Error('socket not open'));
    }
    var id = uuid();
    var timer = setTimeout(function () {
      delete pending[id];
      reject(new Error('timeout: ' + method));
    }, timeoutMs || 10000);
    entry = pending[id] = { resolve: resolve, reject: reject, timer: timer };
    socket.send(JSON.stringify({ type: 'request', id: id, method: method, params: params || {} }));
  });
  // The executor ran synchronously, so this lands on the entry before anything
  // can settle it. failPending() needs the promise to mark it handled.
  if (entry) entry.promise = p;
  return p;
}

export function on(topic, fn) {
  (topicListeners[topic] = topicListeners[topic] || []).push(fn);
}

export function onOpen(fn) {
  openListeners.push(fn);
  if (socket && socket.readyState === OPEN) fn();
}

export function onClose(fn) {
  closeListeners.push(fn);
}
