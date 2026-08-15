const innerHtmlDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
const PRESERVED_VISUAL_HOST_IDS = Object.freeze([
  'rocket-host',
  'map-host',
  'flight-chart-host',
  'descent-chart-host',
  'system-chart-host',
]);

function syncAttributes(current, replacement) {
  for (const attribute of [...current.attributes]) {
    if (!replacement.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of [...replacement.attributes]) {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
}

if (innerHtmlDescriptor?.get && innerHtmlDescriptor?.set) {
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: innerHtmlDescriptor.configurable,
    enumerable: innerHtmlDescriptor.enumerable,
    get: innerHtmlDescriptor.get,
    set(value) {
      if (this.id !== 'view-root') {
        innerHtmlDescriptor.set.call(this, value);
        return;
      }

      // telemetry更新で画面HTMLを再生成しても、Canvasを持つvisual hostだけは
      // 同一DOM nodeとして保持する。これによりCanvasのdetach/reattachによる
      // フリッカーを防ぎ、その他のbutton/inputは従来どおり再生成する。
      const preserved = new Map();
      for (const id of PRESERVED_VISUAL_HOST_IDS) {
        const node = this.querySelector(`#${id}`);
        if (node) preserved.set(id, node);
      }

      innerHtmlDescriptor.set.call(this, value);

      for (const [id, node] of preserved) {
        const replacement = this.querySelector(`#${id}`);
        if (!replacement) continue;
        syncAttributes(node, replacement);
        replacement.replaceWith(node);
      }
    },
  });
}
