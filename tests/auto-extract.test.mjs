// Regression tests for audit findings B-04, B-05 and B-06.
//
// B-04: the step's "Enable AI fallback" toggle was never read. _executeAutoExtract
//       branched only on extraction.needsLlm, so turning it off did not stop the
//       page being sent to Gemini.
// B-05: the extractType dropdown offered "Article / Blog Post" and "Product
//       Listing / Grid". smart-extractor.js reads only confidenceThreshold and
//       always runs the product extractor, so both options were fiction.
// B-06: confidenceThreshold was labelled "Min. confidence to accept". Nothing is
//       ever rejected — it is the threshold below which the LLM is consulted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const extractorSrc = await readFile(
  new URL("../content/smart-extractor.js", import.meta.url),
  "utf8",
);

const autoExtract = swSrc.match(
  /async function _executeAutoExtract\([\s\S]*?\n\}\n/,
)?.[0];

test("_executeAutoExtract reads the useLlm toggle", () => {
  assert.ok(autoExtract, "found _executeAutoExtract");
  assert.match(
    autoExtract,
    /const useLlm = config\.useLlm !== false;/,
    "the toggle must be read, and default on for pipelines saved before it worked",
  );
  assert.match(
    autoExtract,
    /if \(extraction\.needsLlm && !useLlm\)/,
    "a low-confidence page must not be sent to Gemini when the toggle is off",
  );
});

test("a skipped LLM layer is reported, not silently absorbed", () => {
  assert.ok(
    !/runLlmLayer\([^)]*\)\.catch\(\(\) => null\)/.test(autoExtract),
    "the old .catch(() => null) hid a missing key, a network error and a bad response alike",
  );
  assert.match(autoExtract, /no Gemini API key stored/, "missing key says so");
  assert.match(autoExtract, /LLM layer failed \(\$\{llmError\}\)/, "a real failure reports its reason");
});

test("the extractor implements only product extraction", () => {
  // If someone adds an article or listing extractor, this test should fail and
  // be replaced by one asserting the dropdown is back.
  assert.ok(
    !/extractType/.test(extractorSrc),
    "smart-extractor ignores extractType entirely",
  );
});

test("the UI no longer offers page types that do not exist", () => {
  assert.ok(
    !/data-key="extractType"/.test(panelSrc),
    "the dropdown promised article and listing extraction that was never implemented",
  );
  assert.ok(
    !/Article \/ Blog Post|Product Listing \/ Grid/.test(panelSrc),
    "and its option labels are gone too",
  );
});

test("confidenceThreshold is labelled as what it does", () => {
  assert.ok(
    !/Min\. confidence to accept/.test(panelSrc),
    "nothing is rejected on confidence, so that label was wrong",
  );
  assert.match(panelSrc, /Escalate to AI below this confidence/);
});

test("log levels used by the service worker have matching CSS classes", async () => {
  // "warning-log" was used twice and has no style rule, so those two messages
  // rendered unstyled in the monitor.
  const html = await readFile(
    new URL("../sidepanel/index.html", import.meta.url),
    "utf8",
  );
  const defined = new Set(
    [...html.matchAll(/\.([a-z]+-log)\b/g)].map((m) => m[1]),
  );
  const used = new Set(
    [...swSrc.matchAll(/"([a-z]+-log)"/g)].map((m) => m[1]),
  );

  const undefinedLevels = [...used].filter((l) => !defined.has(l));
  assert.deepEqual(undefinedLevels, [], "every log level must have a style rule");
});
