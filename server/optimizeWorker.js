// Runs the FSRS optimizer off the main thread (the WASI build is synchronous and can take a while).
// Input: { csv } in fsrs-rs revlog format. Posts { progress }, then { params } or { error }.
import { parentPort, workerData } from 'node:worker_threads';

try {
  const { computeParameters, convertCsvToFsrsItems } = await import('@open-spaced-repetition/binding');
  const items = convertCsvToFsrsItems(new Uint8Array(Buffer.from(workerData.csv)), workerData.dayStartsAt ?? 4, workerData.timezone ?? 0, 'FSRS-6');
  parentPort.postMessage({ items: items.length });
  if (items.length < workerData.minItems) {
    parentPort.postMessage({ error: `Not enough review history yet (${items.length} usable reviews; at least ${workerData.minItems} needed)` });
  } else {
    // FSRS-6 gives the 21 weights ts-fsrs uses
    const params = await computeParameters(items, {
      enableShortTerm: true, modelVersion: 'FSRS-6', numRelearningSteps: 1,
      progress: (current, total) => { parentPort.postMessage({ progress: total ? current / total : 0 }); },
    });
    parentPort.postMessage({ params: Array.from(params) });
  }
} catch (e) {
  parentPort.postMessage({ error: /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(String(e?.message))
    ? 'The FSRS optimizer isn’t installed on this server (it needs Node.js 24 or newer)'
    : `Optimizer failed: ${e?.message || e}` });
}
