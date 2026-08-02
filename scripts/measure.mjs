// Render the queue screen with fabricated asks in a real 800x480 Chrome and
// report whether the hero card actually contains its own children. The unit
// tests can only assert on the emitted string; this is what catches a card
// that lays out 30px taller than the box it is drawn in.
//
//   bun run dev &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --remote-debugging-port=9333 \
//     --user-data-dir="$(mktemp -d)" about:blank &
//   node scripts/measure.mjs [--shot prefix] [--only substring]
//                            [--port 9333] [--host 127.0.0.1] [--url http://localhost:5173/]
//
// Every scenario must print "ok": the ALLOW/DENY chips inside the card, the
// kind line clear of the hazard stripes, the footer on screen.
import fs from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = arg('port', '9333');
const HOST = arg('host', '127.0.0.1');
const URL_ = arg('url', 'http://localhost:5173/');
const SHOT = arg('shot', null);
const ONLY = arg('only', null);

const targets = await fetch(`http://${HOST}:${PORT}/json`).then(r => r.json());
let page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = () => res(); setTimeout(() => rej(new Error('cdp timeout')), 8000); });
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) =>
  new Promise(res => (pending.set(++id, res), ws.send(JSON.stringify({ id, method, params }))));
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('THREW: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result?.result?.value;
};

if (!page.url.startsWith(URL_)) {
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  await new Promise(r => setTimeout(r, 2500));
}
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 480, deviceScaleFactor: 1, mobile: false });
await ev(`location.hash = '#/queue'; window.scrollTo(0,0); 1`);
await new Promise(r => setTimeout(r, 300));

// ---- scenarios --------------------------------------------------------------
const LONG = 'rm -rf node_modules && npx --yes create-something --template typescript-strict --registry https://registry.internal.example.com/artifactory/api/npm/npm-virtual --prefix /Users/joost/Projects/very/deeply/nested/workspace/packages/app';
const BLOB = 'https://registry.internal.example.com/artifactory/api/npm/npm-virtual/@scope/package/-/package-1.2.3-canary.20260802T203344Z.tgz?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9';
const C500 = 'x'.repeat(500);

const ask = (over = {}) => ({
  kind: 'permission', id: over.id || 'p1', sessionName: 'bridgething',
  tool: 'Bash', summary: 'ls', intent: '', createdTs: Date.now() - 120000,
  expired: false, ...over,
});

const scenarios = {
  'short, 1 ask':            { asks: [ask()] },
  'short, 3 asks':           { asks: [ask(), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'LONG cmd, 3 asks':        { asks: [ask({ summary: LONG }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'LONG cmd, 1 ask':         { asks: [ask({ summary: LONG })] },
  'unbroken URL, 3 asks':    { asks: [ask({ summary: BLOB }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  '500 chars, 3 asks':       { asks: [ask({ summary: C500 }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'empty cmd, 3 asks':       { asks: [ask({ summary: '' }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'multiline cmd, 3 asks':   { asks: [ask({ summary: 'set -e\ncd /tmp/build\nmake -j8 all install\n./deploy.sh --prod' }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'destructive LONG, 3':     { asks: [ask({ summary: 'rm -rf ' + LONG }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'LONG + intent, 3 asks':   { asks: [ask({ summary: LONG, intent: 'you asked: clean the workspace and reinstall everything from the internal registry' }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'LONG question, 3 asks':   { asks: [ask({ kind: 'question', question: LONG, options: [{ label: 'yes', description: 'do it' }, { label: 'no', description: 'stop' }] }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  // Defeats the 55-column estimate: 44 wide glyphs, so the stack keeps both
  // rows and the CSS safety net is what has to hold the card together.
  'CJK 44 chars, 3 asks':    { asks: [ask({ summary: '删除项目目录下的所有临时文件并重新构建整个工作区然后部署到生产环境上去吧' }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'emoji 40 chars, 3 asks':  { asks: [ask({ summary: '🔥'.repeat(40) }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'expired LONG, 3 asks':    { asks: [ask({ summary: LONG, expired: true }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'armed LONG, 3 asks':      { armed: { id: 'p1', expires: Date.now() + 4000 }, asks: [ask({ summary: 'rm -rf ' + LONG }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'LONG cmd, 10 asks':       { asks: Array.from({ length: 10 }, (_, i) => ask({ id: 'p' + i, summary: i ? 'ls' : LONG })) },
  'long session name, 3':    { asks: [ask({ summary: LONG, sessionName: 'a-really-quite-long-repository-name-that-runs-on' }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
  'answering LONG q':        { answering: true, asks: [ask({ kind: 'question', question: LONG, options: [{ label: 'apply the migration to production', description: 'runs the full migration against the live database right now' }, { label: 'dry run first', description: 'print the statements without executing them' }, { label: 'cancel', description: 'stop' }, { label: 'ask me later', description: 'requeue' }] }), ask({ id: 'p2' }), ask({ id: 'p3' })] },
};

const PROBE = `
(async () => {
  const { renderQueue } = await import('/src/screens/queue.js');
  window.__rq = renderQueue;
  return 'ok';
})()`;
await ev(PROBE);

const measureFn = (state) => `
(function () {
  var st = ${JSON.stringify(state)};
  st.daemonConnected = true; st.queueIndex = 0;
  st.queueAnswering = !!st.answering; st.queueChoice = 0; st.sessions = []; st.stats = {active:0,attention:0}; st.details = {};
  document.getElementById('app').innerHTML = window.__rq(st); window.scrollTo(0,0);
  var q = function (s) { var e = document.querySelector(s); return e && e.getBoundingClientRect(); };
  var r = function (b) { return b ? { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) } : null; };
  var hero = q('.qhero'), body = q('.qherobody'), acts = q('.qactions') || q('.qopts');
  var haz = q('.qhazard'), line = q('.qheroline'), sum = q('.qherosummary'), wrap = q('.qwrap'), foot = q('.qfoot');
  var scr = document.querySelector('.screen');
  return {
    hero: r(hero), body: r(body), hazard: r(haz), line: r(line),
    summary: r(sum), actions: r(acts), wrap: r(wrap), foot: r(foot),
    pageOverflow: Math.round(document.documentElement.scrollWidth) + 'x' + Math.round(document.documentElement.scrollHeight),
    heroScroll: hero ? Math.round(document.querySelector('.qhero').scrollHeight) : null,
    bodyScroll: body ? Math.round(document.querySelector('.qherobody').scrollHeight) : null,
    summaryClipped: (function(){var s=document.querySelector('.qherosummary'); return s ? Math.round((s.scrollHeight - s.getBoundingClientRect().height)*100)/100 : null;})(),
    actionsClipped: (acts && hero) ? Math.round(acts.bottom - hero.bottom) : null,
    headerOverHazard: (line && haz) ? Math.round(haz.bottom - line.top) : null,
    footBottom: foot ? Math.round(foot.bottom) : null,
    screenBottom: scr ? Math.round(scr.getBoundingClientRect().bottom) : null
  };
})()`;

let bad = 0;
for (const [name, state] of Object.entries(scenarios)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const m = await ev(measureFn(state));
  const clip = m.actionsClipped;
  const over = m.headerOverHazard;
  const flags = [];
  if (clip > 0) flags.push(`ACTIONS CLIPPED ${clip}px`);
  if (over > 0) flags.push(`HEADER UNDER HAZARD ${over}px`);
  if (m.footBottom > m.screenBottom) flags.push(`FOOT PAST SCREEN ${m.footBottom - m.screenBottom}px`);
  if (m.bodyScroll > m.body.h) flags.push(`BODY SCROLLS ${m.bodyScroll - m.body.h}px`);
  if (flags.length) bad++;
  console.log(
    (flags.length ? 'FAIL ' : 'ok   ') + name.padEnd(24) +
    ' hero=' + JSON.stringify(m.hero) + ' actions=' + JSON.stringify(m.actions) +
    ' summary=h' + (m.summary ? m.summary.h : '-') +
    (flags.length ? '  << ' + flags.join(' | ') : '')
  );
  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${SHOT}-${name.replace(/[^a-z0-9]+/gi, '_')}.png`, Buffer.from(shot.result.data, 'base64'));
  }
}
console.log(bad ? `\n${bad} scenario(s) overflow` : '\nall scenarios contained');
ws.close();
