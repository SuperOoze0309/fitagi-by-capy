/**
 * Minimal Chrome DevTools Protocol driver — no dependencies.
 *
 * `chrome --dump-dom` snapshots the DOM as soon as the load event fires, which
 * races this app's asynchronous boot (open storage -> build repositories ->
 * render). This driver instead attaches over CDP, waits for a condition, and then
 * reads the DOM, so a smoke run can be asserted reliably.
 *
 * Usage:
 *   node scripts/cdp-check.mjs --port 9222 --url <url> --wait-selector '#smoke-result' \
 *     --timeout 30000 --out result.json
 *
 * Node 24 provides a global WebSocket, so nothing needs to be installed.
 */
import { writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 9222);
const url = args.url;
const timeoutMs = Number(args.timeout ?? 30000);
const waitSelector = args['wait-selector'] ?? null;
const waitText = args['wait-text'] ?? null;
const waitDone = args['wait-done'] === 'true';
const outPath = args.out ?? null;
/**
 * Optional viewport override.
 *
 * The app's layout is driven by width breakpoints, and a headless window's default
 * size is not something a run should depend on, so the caller states the viewport
 * it wants to test. Without it the browser's own window size is used.
 */
const viewportWidth = args.width ? Number(args.width) : null;
const viewportHeight = args.height ? Number(args.height) : null;

if (!url) {
  console.error('missing --url');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for Chrome's HTTP debug endpoint to come up. */
async function findTarget() {
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`no debuggable page on port ${port}: ${lastError}`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleLines = [];
    this.errors = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ');
        this.consoleLines.push(`${message.params.type}: ${text}`);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(
          message.params.exceptionDetails?.exception?.description ??
            message.params.exceptionDetails?.text ??
            'unknown exception',
        );
      }
      // Module fetch failures show up as loadingFailed, not as an exception.
      if (message.method === 'Network.loadingFailed') {
        this.errors.push(
          `network: ${message.params.errorText} (${message.params.type ?? 'unknown'})`,
        );
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response ?? {};
        if (typeof response.url === 'string' && /browserSmoke|consoleErrors|main\.tsx/.test(response.url)) {
          this.consoleLines.push(`net ${response.status} ${response.url}`);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.result?.value;
  }
}

async function main() {
  const target = await findTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  // Pin the viewport before the first navigation, so the page boots at the size
  // being tested rather than resizing after it has already rendered.
  if (viewportWidth && viewportHeight) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: 1,
      mobile: viewportWidth < 768,
    });
  }

  await cdp.send('Page.navigate', { url });

  // Poll the page until the wait condition is satisfied (or we run out of time).
  //
  // The result panel exists from the very first moment of the run, so "the selector
  // is present" would be satisfied immediately and the driver would snapshot a
  // half-finished run. `--wait-done` waits for the panel to report note === "done",
  // which is the only state whose assertions are meaningful.
  const deadline = Date.now() + timeoutMs;
  let satisfied = false;
  let lastProbe = null;
  const probeHistory = [];

  // The panel id is passed in as a plain bareword to avoid nested quoting, which
  // PowerShell mangles when it forwards arguments to node.
  const selectorId = (waitSelector ?? '').replace(/^#/, '');
  const probeExpression = `(() => {
    const panel = document.getElementById('${selectorId}');
    let panelNote = null;
    if (panel) {
      try { panelNote = JSON.parse(panel.textContent).note ?? null; } catch (error) { panelNote = 'unparsable'; }
    }
    return {
      title: document.title,
      readyState: document.readyState,
      selectorFound: !!panel,
      panelNote,
      rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
      bodyLength: document.body ? document.body.innerText.length : -1,
    };
  })()`;

  while (Date.now() < deadline) {
    await sleep(250);
    try {
      lastProbe = await cdp.evaluate(probeExpression);
    } catch (error) {
      lastProbe = { probeError: String(error) };
      continue;
    }
    const doneReached = waitDone ? lastProbe?.panelNote === 'done' : true;
    if (lastProbe?.selectorFound && doneReached) {
      satisfied = true;
      break;
    }
    probeHistory.push(lastProbe);
  }

  const dom = await cdp.evaluate('document.documentElement.outerHTML');
  const panel = await cdp.evaluate(
    `document.getElementById('smoke-result') ? document.getElementById('smoke-result').textContent : null`,
  );
  // Page text with the result panel removed, so assertions can be inspected.
  const pageText = await cdp.evaluate(`(() => {
    const panel = document.getElementById('smoke-result');
    if (panel) panel.remove();
    const text = document.body ? document.body.innerText : '';
    return text.slice(0, 4000);
  })()`);

  const report = {
    url,
    satisfied,
    probe: lastProbe,
    probeHistory: probeHistory.slice(-12),
    consoleLines: cdp.consoleLines,
    pageErrors: cdp.errors,
    panelText: panel,
    pageText,
    domLength: dom ? dom.length : 0,
  };

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    // The full report is on disk; keep stdout a compact line so a caller can read
    // it without tripping over console output that contains braces and quotes.
    console.log(
      `[cdp] satisfied=${satisfied} selector=${waitSelector ?? '-'} errors=${cdp.errors.length} out=${outPath}`,
    );
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  socket.close();
  process.exit(satisfied ? 0 : 1);
}

main().catch((error) => {
  console.error('CDP driver failed:', error);
  process.exit(3);
});
