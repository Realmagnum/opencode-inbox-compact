import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

/** Lets the plugin's coalescing microtask run before the DOM is inspected. */
const flush = () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

// --- host module stubs -------------------------------------------------------

const gui = {
  Plugin: { define: (definition) => ({ __definition: definition, ...definition }) },
  Style: "registry.style",
  Command: "registry.command",
  Store: { global: (schema, initial) => ({ schema, initial, scope: "global" }) },
};
const effect = {
  Schema: {
    Struct: (fields) => ({ tag: "struct", fields }),
    Boolean: { tag: "boolean" },
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@opencode/plugin/gui") return gui;
  if (request === "effect") return effect;
  return originalLoad.call(this, request, ...rest);
};

// --- fake DOM ----------------------------------------------------------------

/** Matches the handful of selectors the plugin uses: tag, [attr], [attr="v"], [attr^="v"]. */
function matches(element, selector) {
  const pattern = /^([a-z0-9]*)((?:\[[^\]]+\])*)$/i.exec(selector);
  if (!pattern) return false;

  const [, tag, attributes] = pattern;
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  for (const [, name, operator, value] of attributes.matchAll(/\[([a-z0-9-]+)(?:([\^=]?=)?"([^"]*)")?\]/gi)) {
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    if (!operator) continue;
    if (operator === "=" && actual !== value) return false;
    if (operator === "^=" && !actual.startsWith(value)) return false;
  }

  return true;
}

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.ownerDocument = document;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.textContent = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    child.parentElement = this;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  remove() {
    const siblings = this.parentElement?.children;
    if (!siblings) return;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click() {
    for (const listener of this.listeners.get("click") ?? []) listener({ type: "click" });
  }

  descendants() {
    const result = [];
    const queue = [...this.children];

    while (queue.length > 0) {
      const element = queue.shift();
      result.push(element);
      queue.push(...element.children);
    }

    return result;
  }

  querySelector(selector) {
    return this.descendants().find((element) => matches(element, selector)) ?? null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => matches(element, selector));
  }

  closest(selector) {
    let element = this;

    while (element) {
      if (matches(element, selector)) return element;
      element = element.parentElement;
    }

    return null;
  }

  contains(other) {
    let element = other;

    while (element) {
      if (element === this) return true;
      element = element.parentElement;
    }

    return false;
  }

  get isConnected() {
    return Boolean(this.parentElement);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 28, bottom: 28, x: 0, y: 0, width: 28, height: 28 };
  }
}

class FakeDocument {
  constructor() {
    this.attributes = new Map();
    this.listeners = new Map();
    this.documentElement = new FakeElement("html", this);
    this.documentElement.setAttribute = (name, value) => this.attributes.set(name, value);
    this.documentElement.getAttribute = (name) => (this.attributes.has(name) ? this.attributes.get(name) : null);
    this.documentElement.removeAttribute = (name) => this.attributes.delete(name);
    this.documentElement.hasAttribute = (name) => this.attributes.has(name);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName, this);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

class FakeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    FakeObserver.instances.push(this);
  }

  observe(target, options) {
    this.observed.push({ target, options });
  }

  disconnect() {
    this.disconnected = true;
  }

  trigger(records = []) {
    this.callback(records);
  }
}
FakeObserver.instances = [];

globalThis.MutationObserver = FakeObserver;

// The plugin reports its clicks to a local probe; tests only assert the outcome.
const reports = [];
globalThis.fetch = async (url, options) => {
  reports.push({ url, body: options?.body });
  return { ok: true };
};

const event = (type, target, extra = {}) => ({
  type,
  target,
  clientX: 14,
  clientY: 14,
  preventDefault() {},
  stopPropagation() {},
  ...extra,
});

/** Dispatches the same capture-phase click the browser would send for a press on `target`. */
const press = (doc, target) => doc.dispatch("click", event("click", target));
const pointer = (doc, type, target) => doc.dispatch(type, event(type, target));
const key = (doc, target, keyName) => doc.dispatch("keydown", event("keydown", target, { key: keyName }));

function makeContext(enabled) {
  const prefs = {
    value: { enabled },
    set: (next) => {
      prefs.value = next;
      prefs.calls.push(next);
    },
    calls: [],
  };

  return {
    prefs,
    stores: { prefs },
    added: new Map(),
    add(registry, item) {
      this.added.set(registry, typeof item === "function" ? item : () => item);
      return () => {};
    },
  };
}

/**
 * A sidebar header shaped like the real one: Home fills the start, then the
 * sidebar collapse button, with an optional plugin clock beside it.
 */
function makeHeader(doc, { clock = false } = {}) {
  const header = doc.createElement("div");
  header.setAttribute("data-slot", "sidebar-header");

  const home = doc.createElement("div");
  home.appendChild(doc.createElement("button"));
  home.children[0].setAttribute("data-action", "vertical-tabs-home");
  header.appendChild(home);

  if (clock) {
    const clockButton = doc.createElement("button");
    clockButton.setAttribute("data-ocst-kind", "toggle");
    header.appendChild(clockButton);
  }

  const wrapper = doc.createElement("div");
  const collapse = doc.createElement("button");
  collapse.setAttribute("aria-controls", "vertical-tabs-sidebar");
  wrapper.appendChild(collapse);
  header.appendChild(wrapper);

  doc.documentElement.appendChild(header);

  return { header, home, wrapper, collapse };
}

const plugin = require("../src/gui.cjs");
const { buildCss, labelFor, findHeaderSlot, ATTRIBUTE, TOGGLE, CLASS, ITEM_ID, LABELS, CSS } =
  plugin.__internals;

// --- checks ------------------------------------------------------------------

await check("package exports the gui bundle", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "opencode-inbox-compact");
  assert.equal(pkg.exports["./gui-experimental"], "./src/gui.cjs");
  assert.ok(existsSync(join(root, pkg.exports["./gui-experimental"])));
});

await check("bundle default-exports a Plugin.define with a window setup and a preference", () => {
  assert.ok(plugin.__definition, "definition present");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(Object.keys(plugin.__definition.stores).join(), "prefs");
  assert.deepEqual(plugin.__definition.stores.prefs.initial, { enabled: true });
});

await check("rows become a single 24px grid line and the list tightens", () => {
  assert.match(CSS, /data-slot="sidebar-inbox-item"\]\{display:grid!important/);
  assert.match(CSS, /grid-template-columns:minmax\(0,1fr\) auto!important/);
  assert.match(CSS, /data-slot="sidebar-inbox-item"\]\{[^}]*height:24px!important/);
  assert.match(CSS, /data-slot="sidebar-inbox-scroll"\]\{gap:1px!important\}/);
});

await check("the status and age group survives while project/branch is hidden", () => {
  // The old behaviour collapsed the whole second line; that is what dropped the time and the indicators.
  assert.doesNotMatch(CSS, /:nth-child\(2\)\{display:none/);
  assert.match(CSS, /:nth-child\(2\)>span\.flex-1\{display:none!important\}/);
  assert.match(CSS, /:nth-child\(2\)>:last-child\{margin-inline-start:0!important/);
});

await check("compaction is off until the attribute is set", () => {
  const compactRules = CSS.split("\n").filter((rule) => rule.startsWith(`html[${ATTRIBUTE}] `));
  assert.equal(compactRules.length, 7);
  for (const rule of compactRules) assert.ok(rule.startsWith(`html[${ATTRIBUTE}] `), `scoped rule: ${rule}`);
});

await check("the switch is a 28px ghost icon button like the other header icons", () => {
  assert.match(CSS, new RegExp(`\\.${CLASS}\\{[^}]*width:28px!important[^}]*height:28px!important`));
  assert.match(CSS, new RegExp(`\\.${CLASS} svg\\{width:16px!important;height:16px!important\\}`));
  assert.match(CSS, new RegExp(`\\.${CLASS}:hover`));
  assert.match(CSS, new RegExp(`\\.${CLASS}\\[data-on="true"\\]`));
  assert.match(CSS, new RegExp(`\\.${CLASS}\\[data-on="false"\\]\\{[^}]*opacity:\\.65!important`));
});

await check("the switch is hidden outside the Inbox layout", () => {
  assert.match(CSS, /html:not\(:has\(\[data-slot="sidebar-inbox"\]\)\)/);
  assert.ok(CSS.includes(`[${TOGGLE}]`));
});

await check("findHeaderSlot targets the header row, before the plugin icons", () => {
  const doc = new FakeDocument();
  const { header, wrapper } = makeHeader(doc);

  assert.deepEqual(findHeaderSlot(doc), { header, before: wrapper });
});

await check("findHeaderSlot puts the switch beside an already injected clock", () => {
  const doc = new FakeDocument();
  const { header } = makeHeader(doc, { clock: true });
  const clock = header.querySelector('[data-ocst-kind="toggle"]');

  assert.deepEqual(findHeaderSlot(doc), { header, before: clock });
});

await check("findHeaderSlot ignores the collapsed sidebar toggle and empty layouts", () => {
  assert.equal(findHeaderSlot(new FakeDocument()), null);

  const doc = new FakeDocument();
  const collapsed = doc.createElement("div");
  collapsed.setAttribute("data-slot", "collapsed-sidebar-toggle");
  const orphan = doc.createElement("button");
  orphan.setAttribute("aria-controls", "vertical-tabs-sidebar");
  collapsed.appendChild(orphan);
  doc.documentElement.appendChild(collapsed);

  assert.equal(findHeaderSlot(doc), null);
});

await check("setup injects a pressed icon into the header and sets the attribute", () => {
  globalThis.document = new FakeDocument();
  const { header, wrapper } = makeHeader(globalThis.document);

  const context = makeContext(true);
  plugin.setup(context);

  const button = header.querySelector(`[${TOGGLE}]`);
  assert.ok(button, "button injected into the header");
  assert.equal(button.className, CLASS);
  assert.equal(button.getAttribute("data-on"), "true");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("aria-label"), "Compact list");
  assert.equal(button.getAttribute("title"), "Compact list");
  assert.equal(button.querySelector("use").getAttribute("href"), "#opencode-v2-icon-align-right");
  assert.equal(button.nextElementSibling, wrapper, "sits right before the collapse button");
  assert.equal(globalThis.document.documentElement.hasAttribute(ATTRIBUTE), true);

  assert.ok(context.added.has(gui.Style));
  assert.ok(context.added.has(gui.Command));
  assert.equal(context.added.get(gui.Style)(), CSS);
});

await check("the icon lands before a plugin clock when one is already present", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document, { clock: true });
  const clock = header.querySelector('[data-ocst-kind="toggle"]');

  plugin.setup(makeContext(true));

  assert.equal(header.querySelector(`[${TOGGLE}]`).nextElementSibling, clock);
});

await check("the injected icon is not created twice when the host re-renders", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);

  plugin.setup(makeContext(true));
  FakeObserver.instances.at(-1).trigger();

  assert.equal(header.querySelectorAll(`[${TOGGLE}]`).length, 1);
});

await check("a disabled preference leaves the rows untouched but keeps a dimmed icon", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);

  plugin.setup(makeContext(false));

  const button = header.querySelector(`[${TOGGLE}]`);
  assert.equal(globalThis.document.documentElement.hasAttribute(ATTRIBUTE), false);
  assert.equal(button.getAttribute("data-on"), "false");
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

await check("clicking flips state, stored preference, document attribute and icon state", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  const context = makeContext(true);
  plugin.setup(context);

  const button = header.querySelector(`[${TOGGLE}]`);

  press(globalThis.document, button);
  assert.deepEqual(context.prefs.calls.at(-1), { enabled: false });
  assert.equal(globalThis.document.documentElement.hasAttribute(ATTRIBUTE), false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.getAttribute("data-on"), "false");

  press(globalThis.document, button);
  assert.deepEqual(context.prefs.calls.at(-1), { enabled: true });
  assert.equal(globalThis.document.documentElement.hasAttribute(ATTRIBUTE), true);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("data-on"), "true");
});

await check("the command toggles the same preference", () => {
  globalThis.document = new FakeDocument();
  makeHeader(globalThis.document);
  const context = makeContext(true);
  plugin.setup(context);

  const command = context.added.get(gui.Command)();
  assert.equal(command.id, `${ITEM_ID}.toggle`);

  command.run();
  assert.deepEqual(context.prefs.calls.at(-1), { enabled: false });
});

await check("labels follow the document language", () => {
  assert.equal(labelFor("en"), "Compact list");
  assert.equal(labelFor("ru"), "Компактный список");
  assert.equal(labelFor("ru-RU"), "Компактный список");
  assert.equal(labelFor("de"), LABELS.en);
  assert.equal(labelFor(undefined), LABELS.en);

  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  globalThis.document.documentElement.lang = "ru";
  plugin.setup(makeContext(true));

  assert.equal(header.querySelector(`[${TOGGLE}]`).getAttribute("aria-label"), "Компактный список");
});

await check("repainting keeps the label attributes stable", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  plugin.setup(makeContext(true));

  const button = header.querySelector(`[${TOGGLE}]`);
  const label = button.getAttribute("aria-label");

  FakeObserver.instances.at(-1).trigger();

  assert.equal(button.getAttribute("aria-label"), label);
});

await check("a press activates the switch even when the host never sends a click", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  const context = makeContext(true);
  plugin.setup(context);

  const button = header.querySelector(`[${TOGGLE}]`);
  pointer(globalThis.document, "pointerdown", button);

  assert.deepEqual(context.prefs.calls.at(-1), { enabled: false });
  assert.equal(globalThis.document.documentElement.hasAttribute(ATTRIBUTE), false);
  assert.equal(button.getAttribute("data-on"), "false");
});

await check("the click that follows a press does not toggle twice", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  const context = makeContext(true);
  plugin.setup(context);

  const button = header.querySelector(`[${TOGGLE}]`);

  pointer(globalThis.document, "pointerdown", button);
  press(globalThis.document, button);

  assert.equal(context.prefs.calls.length, 1);
  assert.deepEqual(context.prefs.calls.at(-1), { enabled: false });
});

await check("keyboard activation toggles without a pointer", () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  const context = makeContext(true);
  plugin.setup(context);

  const button = header.querySelector(`[${TOGGLE}]`);
  key(globalThis.document, button, "Enter");

  assert.deepEqual(context.prefs.calls.at(-1), { enabled: false });
  assert.equal(globalThis.document.documentElement.hasAttribute(ATTRIBUTE), false);
});

await check("buildCss follows the given attribute, class and toggle marker", () => {
  const css = buildCss("data-x", "my-class", "data-y");
  assert.ok(css.includes('html[data-x] [data-slot="sidebar-inbox-item"]'));
  assert.ok(css.includes(".my-class{"));
  assert.ok(css.includes("html:not(:has([data-slot=\"sidebar-inbox\"])) [data-y]"));
});

// --- steady-state cost -------------------------------------------------------

/** Counts the document-wide queries so a per-mutation scan is observable. */
function countQueries(doc) {
  const counts = { all: 0, one: 0 };
  const all = doc.querySelectorAll.bind(doc);
  const one = doc.querySelector.bind(doc);

  doc.querySelectorAll = (selector) => {
    counts.all += 1;
    return all(selector);
  };
  doc.querySelector = (selector) => {
    counts.one += 1;
    return one(selector);
  };

  return counts;
}

/** A batch of transcript-like mutations that cannot touch the header. */
const unrelated = (target) => [
  { type: "childList", target, addedNodes: [], removedNodes: [] },
  { type: "characterData", target },
];

await check("steady state does not rescan the document for unrelated mutations", async () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  plugin.setup(makeContext(true));

  const observer = FakeObserver.instances.at(-1);
  const transcript = globalThis.document.createElement("div");
  header.parentElement.appendChild(transcript);

  const counts = countQueries(globalThis.document);
  const before = header.querySelectorAll(`[${TOGGLE}]`).length;

  for (let index = 0; index < 50; index += 1) observer.trigger(unrelated(transcript));
  await flush();

  assert.equal(counts.all, 0, "no document-wide querySelectorAll while mounted");
  assert.equal(counts.one, 0, "no document-wide querySelector while mounted");
  assert.equal(header.querySelectorAll(`[${TOGGLE}]`).length, before);
});

await check("a rebuilt header gets the switch back and the stale one keeps no copy", async () => {
  globalThis.document = new FakeDocument();
  const first = makeHeader(globalThis.document);
  plugin.setup(makeContext(true));

  const observer = FakeObserver.instances.at(-1);
  const button = first.header.querySelector(`[${TOGGLE}]`);
  assert.ok(button);

  // The route changes: Solid drops the whole sidebar and builds a new one.
  first.header.remove();
  const second = makeHeader(globalThis.document);

  observer.trigger([
    { type: "childList", target: globalThis.document.documentElement, addedNodes: [second.header], removedNodes: [first.header] },
  ]);
  await flush();

  assert.equal(second.header.querySelectorAll(`[${TOGGLE}]`).length, 1, "re-attached once");
  assert.equal(button.parentElement, second.header);
  assert.equal(button.nextElementSibling, second.wrapper);
});

await check("a remounted header inside a new wrapper is still found", async () => {
  globalThis.document = new FakeDocument();
  const first = makeHeader(globalThis.document);
  plugin.setup(makeContext(true));

  const observer = FakeObserver.instances.at(-1);

  // Same header element, rebuilt contents: the collapse button is replaced.
  first.collapse.remove();
  const replacement = new FakeElement("div", globalThis.document);
  const collapse = globalThis.document.createElement("button");
  collapse.setAttribute("aria-controls", "vertical-tabs-sidebar");
  replacement.appendChild(collapse);
  first.header.appendChild(replacement);

  observer.trigger([
    { type: "childList", target: first.header, addedNodes: [replacement], removedNodes: [] },
  ]);
  await flush();

  assert.equal(first.header.querySelectorAll(`[${TOGGLE}]`).length, 1);
});

await check("a switch detached by the host is re-attached", async () => {
  globalThis.document = new FakeDocument();
  const { header, wrapper } = makeHeader(globalThis.document);
  plugin.setup(makeContext(true));

  const observer = FakeObserver.instances.at(-1);
  const button = header.querySelector(`[${TOGGLE}]`);

  button.remove();
  assert.equal(header.querySelector(`[${TOGGLE}]`), null);

  observer.trigger([{ type: "childList", target: header, addedNodes: [], removedNodes: [button] }]);
  await flush();

  assert.equal(header.querySelectorAll(`[${TOGGLE}]`).length, 1);
  assert.equal(button.nextElementSibling, wrapper);
});

check("an absent sidebar is probed at most twice a second", async () => {
  globalThis.document = new FakeDocument();
  const context = makeContext(true);
  plugin.setup(context);

  // No header at all: the switch cannot be placed yet.
  const counts = countQueries(globalThis.document);
  const observer = FakeObserver.instances.at(-1);

  for (let index = 0; index < 50; index += 1) observer.trigger(unrelated(globalThis.document.documentElement));
  await flush();

  assert.ok(
    counts.all <= 2,
    `fifty batches cost at most one probe (two lookups), saw ${counts.all}`,
  );
});

await check("the probe switches itself off once the sidebar appears", async () => {
  globalThis.document = new FakeDocument();
  plugin.setup(makeContext(true));

  const observer = FakeObserver.instances.at(-1);
  const { header } = makeHeader(globalThis.document);

  observer.trigger([
    { type: "childList", target: globalThis.document.documentElement, addedNodes: [header], removedNodes: [] },
  ]);
  await flush();

  assert.equal(header.querySelectorAll(`[${TOGGLE}]`).length, 1);

  const counts = countQueries(globalThis.document);
  for (let index = 0; index < 20; index += 1) observer.trigger(unrelated(header));
  await flush();

  assert.equal(counts.all, 0);
});

await check("a second setup disconnects the previous observer", async () => {
  globalThis.document = new FakeDocument();
  makeHeader(globalThis.document);

  plugin.setup(makeContext(true));
  const first = FakeObserver.instances.at(-1);

  plugin.setup(makeContext(true));
  const second = FakeObserver.instances.at(-1);

  assert.notEqual(first, second);
  assert.equal(first.disconnected, true);
  assert.equal(second.disconnected, false);
});

await check("the debug probe stays silent unless explicitly enabled", async () => {
  globalThis.document = new FakeDocument();
  const { header } = makeHeader(globalThis.document);
  plugin.setup(makeContext(true));

  const before = reports.length;
  press(globalThis.document, header.querySelector(`[${TOGGLE}]`));

  assert.equal(reports.length, before, "no fetch on a press");

  globalThis.__OC_INBOX_COMPACT_DEBUG__ = true;
  plugin.setup(makeContext(true));
  press(globalThis.document, header.querySelector(`[${TOGGLE}]`));
  delete globalThis.__OC_INBOX_COMPACT_DEBUG__;

  assert.ok(reports.length > before, "reports when switched on");
});

console.log(`\n${passed} checks passed`);
