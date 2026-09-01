// Loads content/injector.js into a jsdom page so its step handlers can be
// exercised against a real DOM.
//
// injector.js is a classic content script, not a module: it has no exports, it
// builds a shadow host at load, and it ends with a dynamic import of the
// overlay engine. So it is evaluated in the page context with `chrome` stubbed
// and a small epilogue that publishes the handlers under test.
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = new URL("../../content/injector.js", import.meta.url);

/** Functions the harness exposes to tests. Extend as more come under test. */
const EXPOSED = ["_executeStep", "_stepExtract", "_stepIfElse", "_queryScoped"];

/**
 * Build a page and load injector.js into it.
 *
 * @param {string} html - body markup for the page under test
 * @returns {Promise<{ window: Window, document: Document, api: Record<string, Function>, close: () => void }>}
 */
export async function loadInjector(html = "") {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://example.test/page",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;

  // Minimal extension surface. The harness never exercises messaging; these
  // exist so module-scope setup does not throw on load.
  window.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener() {} },
      sendMessage: () => Promise.resolve(),
      lastError: null,
    },
  };

  let source = await readFile(SOURCE, "utf8");

  // Drop the trailing overlay-engine bootstrap: it is a dynamic import of an ES
  // module, which is not resolvable inside a classic-script evaluation.
  source = source.replace(
    /import\(chrome\.runtime\.getURL\("content\/overlay-engine\.js"\)\)[\s\S]*?\}\);\s*$/,
    "",
  );

  source += `\n;globalThis.__fsTestApi = { ${EXPOSED.join(", ")} };\n`;

  const context = dom.getInternalVMContext();
  vm.runInContext(source, context, { filename: "injector.js" });

  return {
    window,
    document: window.document,
    api: window.__fsTestApi,
    close: () => window.close(),
  };
}
