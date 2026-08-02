// Screenshot the live kiosk and report what the app thinks its state is.
//   node scripts/device.mjs [out.png]
// Raw-WebSocket CDP: Playwright's connectOverCDP hangs against this chromium,
// so the protocol is spoken directly over the page target's socket.
const out = process.argv[2] || 'device.png';
const DEVICE = process.env.CARTHING_CDP || 'http://10.42.1.178:9222';

const targets = await fetch(DEVICE + '/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
console.log('page url:', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); setTimeout(() => rej(new Error('cdp timeout')), 8000); });
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) =>
  new Promise(res => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))));

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'THREW: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 160);
  return r.result?.result?.value;
};

console.log('banner   :', await ev(`document.getElementById('banner') && document.getElementById('banner').className`));
console.log('hash     :', await ev(`location.hash || '(none)'`));
console.log('ws proto :', await ev(`typeof WebSocket`));
const text = await ev(`document.body.innerText.replace(/\\n+/g,' | ').slice(0,400)`);
console.log('screen   :', text);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  (await import('node:fs')).writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote', out);
} else {
  console.log('screenshot failed:', JSON.stringify(shot).slice(0, 200));
}
ws.close();
