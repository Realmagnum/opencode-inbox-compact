"use strict";

/**
 * OpenCode GUI plugin: compact session rows for the "Inbox" interface layout.
 *
 * The Inbox sidebar renders every session as a two-line, 54px card: title, then
 * a second line holding the project/branch and, pinned to the end, the status
 * indicator (dot or activity ring) and the elapsed time. This plugin keeps the
 * status and the time, drops the project/branch group and lays the row out as a
 * single 24px line, so the sidebar fits roughly twice as many sessions.
 *
 * The switch is a 28px icon button in the sidebar header, beside the icons the
 * other plugins inject there (the session-timestamps clock and the llama-swap
 * pill). The host's `TitlebarItem` registry is not used on purpose: in the
 * vertical sidebar it renders in `[data-slot="vertical-tabs-footer"]`.
 *
 * The host provides `@opencode/plugin/gui` and `effect` to the bundle at runtime,
 * so both are required, never bundled.
 */

const { Plugin, Style, Store, Command } = require("@opencode/plugin/gui");
const { Schema } = require("effect");

const ATTRIBUTE = "data-oc-inbox-compact";
const TOGGLE = "data-oc-inbox-compact-toggle";
const CLASS = "oc-inbox-compact-toggle";
const ITEM_ID = "inbox-compact";
const INBOX = '[data-slot="sidebar-inbox"]';
const ITEM = '[data-slot="sidebar-inbox-item"]';
const SCROLL = '[data-slot="sidebar-inbox-scroll"]';
const HEADER = '[data-slot="sidebar-header"]';
const SIDEBAR_TOGGLE = 'button[aria-controls="vertical-tabs-sidebar"]';
const COLLAPSED = '[data-slot="collapsed-sidebar-toggle"]';
const CLOCK = '[data-ocst-kind="toggle"]';
const ICON = "#opencode-v2-icon-align-right";
const LABELS = { en: "Compact list", ru: "Компактный список" };
const LABEL = LABELS.en;
const DEBUG_URL = "http://127.0.0.1:8777/dbg";

/** How often an absent sidebar is re-probed, in milliseconds. */
const PROBE_INTERVAL = 500;

/** The observer of the last `setup` in this window, if any. */
let attached;

/** The probe is off unless the window sets `globalThis.__OC_INBOX_COMPACT_DEBUG__`. */
const DEBUG = () => globalThis.__OC_INBOX_COMPACT_DEBUG__ === true;

/**
 * Temporary probe: reports what the window actually sees. Every press used to
 * POST here, which put a fetch in the click path of the whole app; it now runs
 * only when debugging is explicitly switched on.
 */
function report(kind, data) {
  if (!DEBUG()) return;

  try {
    void fetch(DEBUG_URL, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ kind, at: Date.now(), data }),
    }).catch(() => {});
  } catch {}
}

/**
 * Row rules are scoped under `html[data-oc-inbox-compact]`, so nothing is styled
 * while compaction is off. `!important` keeps the host's Tailwind utilities from
 * winning by cascade order.
 *
 * The item becomes a two-column grid: the title keeps `minmax(0, 1fr)` and the
 * second line collapses into the trailing `auto` cell, where only its last
 * group — the status glyph/ring and the age — survives. Its first groups (the
 * server tag and the project/branch span with `flex-1`) are hidden.
 *
 * The switch is a ghost 28px icon button with a 16px muted icon and the same
 * hover wash as the neighbouring header icons; `data-on="false"` dims it.
 */
function buildCss(attribute, className, toggle) {
  return [
    `html[${attribute}] ${ITEM}{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:center!important;height:24px!important;padding:2px 8px!important;gap:6px!important;border-radius:4px!important}`,
    `html[${attribute}] ${ITEM}>:first-child{width:auto!important;min-width:0!important;height:16px!important}`,
    `html[${attribute}] ${ITEM}>:nth-child(2){position:static!important;width:auto!important;height:16px!important;padding:0!important;gap:4px!important}`,
    `html[${attribute}] ${ITEM}>:nth-child(2)>span.flex-1{display:none!important}`,
    `html[${attribute}] ${ITEM}>:nth-child(2)>span.absolute{position:static!important;inset:auto!important}`,
    `html[${attribute}] ${ITEM}>:nth-child(2)>:last-child{margin-inline-start:0!important;gap:4px!important}`,
    `html[${attribute}] ${SCROLL}{gap:1px!important}`,
    `.${className}{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:28px!important;height:28px!important;flex:none!important;padding:0!important;border:0!important;border-radius:6px!important;background:transparent!important;color:var(--v2-icon-icon-muted,light-dark(#5f5f5f,#8a8a8a))!important;cursor:pointer!important;-webkit-app-region:no-drag!important;transition:color 120ms ease,background-color 120ms ease,opacity 120ms ease!important}`,
    `.${className} svg{width:16px!important;height:16px!important}`,
    `.${className}:hover,.${className}:focus-visible{background:var(--v2-overlay-simple-overlay-hover,light-dark(rgba(0,0,0,.05),rgba(255,255,255,.06)))!important;color:var(--v2-text-text-base,light-dark(#1f1f1f,#eeeeee))!important}`,
    `.${className}[data-on="true"]{color:var(--v2-text-text-base,light-dark(#1f1f1f,#eeeeee))!important}`,
    `.${className}[data-on="false"]{color:var(--v2-text-text-faint,light-dark(#6b6b6b,#8a8a8a))!important;opacity:.65!important}`,
    `html:not(:has(${INBOX})) [${toggle}]{display:none!important}`,
  ].join("\n");
}

const CSS = buildCss(ATTRIBUTE, CLASS, TOGGLE);

/** The host sets `document.documentElement.lang` reactively, so labels follow the UI language. */
function labelFor(lang) {
  const key = String(lang || "en")
    .toLowerCase()
    .replace("_", "-")
    .split("-")[0];

  return LABELS[key] || LABELS.en;
}

/** The switch goes right before the header's icon cluster, not after it. */
function slotFor(header, wrapper) {
  const clock = header.querySelector(CLOCK) ?? header.querySelector("[data-llama-header-item]");

  return { header, before: clock && clock.parentElement === header ? clock : wrapper };
}

/**
 * The sidebar header row that already hosts the other plugins' icons: the
 * session-timestamps clock, the llama-swap pill and the sidebar collapse button.
 *
 * The host marks that row with `data-slot`, so the usual case is one lookup.
 * Scanning every sidebar toggle stays as the fallback for a layout whose header
 * is not marked. This runs only when the mounted switch was lost, never on the
 * steady state — see `ensure`.
 */
function findHeaderSlot(doc) {
  // A layout can carry more than one marked header (Home and the tab list), so
  // the first one that actually holds the collapse button wins.
  for (const header of doc.querySelectorAll(HEADER)) {
    const inside = header.querySelector(SIDEBAR_TOGGLE);

    if (inside && !inside.closest(COLLAPSED) && inside.parentElement) {
      return slotFor(header, inside.parentElement);
    }
  }

  const toggle = Array.from(doc.querySelectorAll(SIDEBAR_TOGGLE)).find(
    (element) => !element.closest(COLLAPSED),
  );
  const wrapper = toggle && toggle.parentElement;
  const found = wrapper && wrapper.parentElement;

  return found ? slotFor(found, wrapper) : null;
}

function createToggle(doc) {
  const button = doc.createElement("button");

  button.type = "button";
  button.setAttribute(TOGGLE, "");
  button.className = CLASS;

  const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("data-slot", "icon-svg");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("aria-hidden", "true");

  const use = doc.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", ICON);
  icon.appendChild(use);

  button.appendChild(icon);

  return button;
}

function define() {
  return Plugin.define({
    stores: {
      prefs: Store.global(Schema.Struct({ enabled: Schema.Boolean }), { enabled: true }),
    },
    setup(context) {
      const doc = globalThis.document;
      const root = doc ? doc.documentElement : undefined;
      const prefs = context.stores ? context.stores.prefs : undefined;

      const enabled = () => Boolean(prefs && prefs.value ? prefs.value.enabled : true);
      const lang = () => (doc ? doc.documentElement.lang : "en");

      let button;
      /**
       * The header that currently hosts the switch. Remembering it turns the
       * per-mutation check into a few property reads instead of a document scan.
       */
      let slot;

      /** Attribute writes on the live header are re-renders of the host, so only touch changed values. */
      const mark = (name, value) => {
        if (button.getAttribute(name) !== value) button.setAttribute(name, value);
      };

      const paint = () => {
        if (!button) return;

        const on = enabled();
        const label = labelFor(lang());

        mark("data-on", on ? "true" : "false");
        mark("aria-pressed", on ? "true" : "false");

        if (button.getAttribute("aria-label") !== label) {
          button.setAttribute("aria-label", label);
          button.setAttribute("title", label);
        }
      };

      /**
       * True while the remembered slot still hosts the switch exactly where the
       * host left it. A route or layout change rebuilds the header, and that is
       * the only case that needs the switch re-attached.
       */
      const mounted = () =>
        Boolean(button && slot) &&
        slot.header.isConnected &&
        slot.before.parentElement === slot.header &&
        button.parentElement === slot.header &&
        button.nextElementSibling === slot.before;

      const mount = (next) => {
        slot = next;

        if (button.parentElement !== next.header || button.nextElementSibling !== next.before) {
          next.header.insertBefore(button, next.before);
        }

        paint();
      };

      /**
       * Solid may rebuild the sidebar header when the route or the layout
       * changes, so the button is re-attached instead of being inserted once.
       * This runs after every batch of UI mutations, and the transcript streams
       * text continuously, so the steady state must stay O(1): no query until
       * the remembered slot is actually gone.
       */
      const ensure = () => {
        if (!doc || !button || mounted()) return;

        const next = findHeaderSlot(doc);

        if (!next) {
          slot = undefined;
          return;
        }

        mount(next);
      };

      const apply = (on) => {
        if (root) {
          if (on) root.setAttribute(ATTRIBUTE, "");
          else root.removeAttribute(ATTRIBUTE);
        }

        paint();
      };

      const toggle = () => {
        const next = !enabled();

        if (prefs) {
          if (typeof prefs.set === "function") prefs.set({ enabled: next });
          else if (typeof prefs.update === "function") prefs.update((draft) => void (draft.enabled = next));
        }

        apply(next);
      };

      if (doc) {
        button = createToggle(doc);
        ensure();

        report("setup", {
          enabled: enabled(),
          hasPrefs: Boolean(prefs),
          value: prefs ? prefs.value : null,
          parent: button.parentElement ? button.parentElement.getAttribute("data-slot") : null,
          connected: button.isConnected,
        });

        // Capture on the document: it fires before any ancestor could swallow
        // the press, and it survives the host re-parenting the button.
        const pressed = (event) => {
          const target = event.target;
          const hit = target && target.closest ? target.closest(`[${TOGGLE}]`) : null;

          return hit === button ? hit : null;
        };

        let handledAt = 0;
        let handledBy = "";
        let armed = false;

        const activate = (source) => {
          handledAt = Date.now();
          handledBy = source;

          try {
            toggle();

            report("toggle", {
              source,
              enabled: enabled(),
              attribute: doc.documentElement.hasAttribute(ATTRIBUTE),
              dataOn: button.getAttribute("data-on"),
              value: prefs ? prefs.value : null,
            });
          } catch (error) {
            report("toggle-error", { source, message: String((error && error.stack) || error) });
          }
        };

        /** The host can retarget a captured pointerup, so position decides, not the target. */
        const inside = (event) => {
          const rect = button.getBoundingClientRect();

          return (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          );
        };

        doc.addEventListener(
          "pointerdown",
          (event) => {
            const hit = pressed(event);
            armed = Boolean(hit);

            if (!hit) return;

            // A layout read on every press in the app is real work; keep it for the probe.
            if (DEBUG()) report("pointerdown", { tag: event.target.tagName, connected: button.isConnected, inside: inside(event) });

            // The press is the only event this host reliably delivers: the click
            // that should follow never reaches the document, so it activates here.
            activate("pointerdown");
          },
          true,
        );

        doc.addEventListener(
          "pointerup",
          (event) => {
            const onButton = Boolean(pressed(event));
            const wasArmed = armed;

            armed = false;

            if (DEBUG()) report("pointerup", { tag: event.target.tagName, onButton, inside: inside(event), wasArmed });
          },
          true,
        );

        doc.addEventListener(
          "pointercancel",
          () => {
            armed = false;
            handledAt = 0;
          },
          true,
        );

        // A real click (keyboard, or a press the host does end up completing)
        // must not toggle twice for the same gesture.
        doc.addEventListener(
          "click",
          (event) => {
            const hit = pressed(event);

            if (DEBUG()) report("click", { tag: event.target.tagName, onButton: Boolean(hit), since: Date.now() - handledAt });

            if (!hit) return;

            event.preventDefault();
            event.stopPropagation();

            if (Date.now() - handledAt < 800 && handledBy !== "click") return;

            activate("click");
          },
          true,
        );

        doc.addEventListener(
          "keydown",
          (event) => {
            if (!pressed(event)) return;
            if (event.key !== "Enter" && event.key !== " ") return;

            event.preventDefault();
            event.stopPropagation();
            activate("keyboard");
          },
          true,
        );

        let scheduled = false;

        /**
         * The transcript streams text continuously, so most batches are
         * irrelevant: nothing that could move the switch. A batch is only worth
         * a check when it touches the header (or its ancestors) or drops the
         * switch itself.
         */
        const relevant = (records) => {
          if (!slot) return true;
          if (!slot.header.isConnected) return true;

          for (const record of records) {
            // The only attribute observed is `lang`, which repaints the label.
            if (record.type === "attributes") return true;
            if (record.type !== "childList") continue;

            // Anything written inside the header has a target inside the header.
            // Anything that moves the header or the switch names it outright.
            // Neither test walks a subtree, so a batch of streamed nodes stays cheap.
            if (record.target === slot.header || slot.header.contains(record.target)) return true;

            for (const node of record.addedNodes ?? []) {
              if (node === button || node === slot.header) return true;
            }

            for (const node of record.removedNodes ?? []) {
              if (node === button || node === slot.header) return true;
            }
          }

          return false;
        };

        let probeAt = 0;
        let probeTimer;

        // Coalesce the UI's very frequent mutations into one check per turn.
        const observer = new MutationObserver((records) => {
          if (scheduled) return;
          if (slot && !relevant(records)) return;
          scheduled = true;

          // Without a header there is nothing to attach to, and scanning the
          // whole document on every batch would be the very cost this avoids.
          // Back off instead, so the switch still appears when the layout does.
          if (!slot) {
            const wait = probeAt + PROBE_INTERVAL - Date.now();

            if (wait > 0) {
              if (probeTimer === undefined) {
                probeTimer = setTimeout(() => {
                  probeTimer = undefined;
                  ensure();
                }, wait);
              }

              scheduled = false;
              return;
            }

            probeAt = Date.now();
          }

          queueMicrotask(() => {
            scheduled = false;
            ensure();
          });
        });

        observer.observe(doc.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["lang"],
        });

        // The GUI half is re-evaluated on reload; drop the previous observer so a
        // second setup cannot double the work.
        if (attached) attached.dispose();
        attached = {
          dispose: () => {
            observer.disconnect();
            if (probeTimer !== undefined) clearTimeout(probeTimer);
          },
        };
      }

      context.add(Style, CSS);
      context.add(Command, () => ({
        id: `${ITEM_ID}.toggle`,
        get title() {
          return labelFor(lang());
        },
        run: toggle,
      }));

      apply(enabled());
    },
  });
}

module.exports = define();
module.exports.__internals = {
  buildCss,
  labelFor,
  findHeaderSlot,
  ATTRIBUTE,
  TOGGLE,
  CLASS,
  ITEM_ID,
  LABELS,
  LABEL,
  CSS,
};
