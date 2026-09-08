// Pressing "Test" on a step must reach the code that runs it.
//
// The test path special-cased a handful of types and forwarded everything else
// to the page. Ten of the twenty-two step types run in the *worker*, so half of
// them arrived at injector.js, which refuses them by design (B-32), and the
// panel showed:
//
//   Unknown step type: LOOP
//   Unknown step type: API_SNIFFER
//
// Reported from a real session, along with "pdf extract is not working" — which
// was the same thing: PDF_EXTRACTION runs in the worker and was forwarded to a
// page that has never known what a PDF is.
//
// A hand-kept list of exceptions is what drifted. The registry already says
// where each type runs; route by that (G-01).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STEP_TYPES, USER_STEP_TYPES } from "../utils/step-types.js";

const src = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
// From the run-only table, which the handler reads, to the next handler.
const handler = src.slice(
  src.indexOf("const RUN_ONLY_STEPS"),
  src.indexOf("_registerHandler(MSG.PIPELINE_PAUSE"),
);

test("no worker step is forwarded to the page when tested", () => {
  // The page's dispatcher throws "Unknown step type" for anything it does not
  // own, so a background type reaching it is always a bug.
  const background = USER_STEP_TYPES.filter(
    (t) => STEP_TYPES[t].runsIn === "background",
  );
  // Quoted in a comparison, or bare as an object key — either counts.
  const unrouted = background.filter(
    (t) => !new RegExp(`(?:"${t}"|\\b${t}:)`).test(handler),
  );
  assert.deepEqual(
    unrouted,
    [],
    "these run in the worker and the test path does not mention them",
  );
});

test("the router is driven by the registry, not by a hand-kept list", () => {
  assert.match(
    handler,
    /STEP_TYPES\[[^\]]+\]\?\.runsIn|runsIn === "background"/,
    "it must ask the registry where a step runs",
  );
});

test("a step that only means something inside a run says so", async () => {
  // LOOP, EXPORT and API_SNIFFER cannot be tested alone: a loop has no run to
  // iterate, an export has no rows, and the sniffer is a run-wide capture that
  // does nothing as a step. Saying "Unknown step type" for those is worse than
  // useless — it reads like the step is broken.
  for (const type of ["LOOP", "EXPORT", "API_SNIFFER"]) {
    assert.match(
      handler,
      new RegExp(`\\b${type}:`),
      `${type} has no explanation in RUN_ONLY_STEPS`,
    );
  }
  assert.match(
    handler,
    /RUN_ONLY_STEPS|only makes sense|cannot be tested/i,
    "there is no explanation for the run-only types",
  );
});

test("PDF_EXTRACTION and AUTO_EXTRACT can be tested, because they can run alone", () => {
  assert.match(handler, /_executePdfExtraction/);
  assert.match(handler, /_executeAutoExtract/);
});
