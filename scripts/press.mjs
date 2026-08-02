// Press a physical control on the live kiosk via CDP.
//   node scripts/press.mjs Enter | 1 | 2 | 3 | 4 | Escape | m | dial+ | dial-
// Preset 1/2/3 are the page buttons, preset 4 denies, Enter is the dial press —
// so Enter and 4 answer whatever permission is in front of you. Handle with
// care against a device holding real asks.
const which = process.argv[2] || 'Enter';
const DEVICE = process.env.CARTHING_CDP || 'http://10.42.1.178:9222';

const KEYS = {
  Enter:  { key: 'Enter',  code: 'Enter',  keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  '1': { key: '1', code: 'Digit1', keyCode: 49, text: '1' },
  '2': { key: '2', code: 'Digit2', keyCode: 50, text: '2' },
  '3': { key: '3', code: 'Digit3', keyCode: 51, text: '3' },
  '4': { key: '4', code: 'Digit4', keyCode: 52, text: '4' },
  m:   { key: 'm', code: 'KeyM',   keyCode: 77, text: 'm' },
};

const targets = await fetch(DEVICE + '/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); setTimeout(() => rej(new Error('cdp timeout')), 8000); });
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) =>
  new Promise(res => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))));

if (which.startsWith('dial')) {
  const dx = which.endsWith('-') ? -120 : 120;
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 240, deltaX: dx, deltaY: 0 });
  console.log('dial', dx > 0 ? 'right' : 'left');
} else {
  const k = KEYS[which];
  if (!k) { console.error('unknown control:', which); process.exit(1); }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
  console.log('pressed', which);
}
ws.close();
