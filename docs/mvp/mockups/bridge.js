/* Documentation-only replacement for the conversation host's scenario controls. */
(() => {
  const controls = [];
  const send = () => parent.postMessage({
    type: "mvp-design:controls",
    controls: controls.map(({ model, key, id, kind, label, options }) => ({
      id, kind, label, options, value: model[key],
    })),
  }, "*");
  globalThis.Tweak = class {
    constructor({ onChange }) { this.changed = onChange; }
    addSelect(model, key, options) { this.add(model, key, "select", options); }
    addToggle(model, key, options) { this.add(model, key, "toggle", options); }
    add(model, key, kind, options) {
      controls.push({ model, key, kind, id: controls.length, label: options.label,
        options: options.options, changed: this.changed });
      send();
    }
  };
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "mvp-design:set") return;
    const control = controls[event.data.id];
    if (!control) return;
    const value = event.data.value;
    if (control.kind === "toggle" ? typeof value !== "boolean" : !control.options.includes(value)) return;
    control.model[control.key] = value;
    control.changed();
    send();
  });
  addEventListener("DOMContentLoaded", () => {
    const sendHeight = () => parent.postMessage({
      type: "mvp-design:height", height: document.documentElement.scrollHeight,
    }, "*");
    new ResizeObserver(sendHeight).observe(document.body);
    sendHeight();
  });
})();
