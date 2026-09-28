/**
 * Drive the running app through CDP and take a screenshot.
 *
 * Written for visual checks of screens that need state first (enable AI, seed a plan),
 * which a plain `--screenshot` cannot reach. Not part of the build or the test suite.
 *
 * Usage:
 *   node design/theme-art/shot.mjs --port 9410 --url http://127.0.0.1:5179/ \
 *     --steps steps.json --out shot.png --width 430 --height 900
 *
 * `steps.json` is an array of `{ "eval": "…" }` and `{ "wait": 800 }` entries, run in
 * order before the screenshot.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = {};
for (let index = 0; index < process.argv.length - 2; index += 2) {
  const key = process.argv[index + 2];
  if (key?.startsWith('--')) args[key.slice(2)] = process.argv[index + 3];
}

const port = Number(args.port ?? 9410);
const url = args.url;
const out = args.out ?? 'shot.png';
const width = Number(args.width ?? 430);
const height = Number(args.height ?? 900);
const steps = args.steps ? JSON.parse(readFileSync(args.steps, 'utf8')) : [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`no debuggable page on ${port}`);
}

const target = await findTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id === undefined || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return result.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: width < 768,
});
await send('Page.navigate', { url });
await sleep(2500);

for (const step of steps) {
  if (step.eval) {
    const value = await evaluate(step.eval);
    console.log(`eval -> ${JSON.stringify(value)?.slice(0, 120)}`);
  }
  if (step.wait) await sleep(step.wait);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`screenshot: ${out}`);
socket.close();
process.exit(0);
