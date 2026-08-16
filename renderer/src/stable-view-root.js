import { enuToLatLon } from '../../shared/offline-map.js';

const innerHtmlDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
const PRESERVED_VISUAL_HOST_IDS = Object.freeze([
  'rocket-host',
  'map-host',
  'flight-chart-host',
  'descent-chart-host',
  'system-chart-host',
]);
const METERS_VALUE_PATTERN = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*m$/i;

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

function readMetricMeters(card) {
  const text = card?.querySelector('strong')?.textContent?.trim() ?? '';
  const match = text.match(METERS_VALUE_PATTERN);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function rewritePositionMetrics(root) {
  for (const grid of root.querySelectorAll('.metric-grid')) {
    const cards = [...grid.children].filter((node) => node.classList?.contains('metric-card'));
    const eastCard = cards.find((card) => card.querySelector('span')?.textContent?.trim() === 'EAST');
    const northCard = cards.find((card) => card.querySelector('span')?.textContent?.trim() === 'NORTH');
    if (!eastCard || !northCard) continue;

    const eastMeters = readMetricMeters(eastCard);
    const northMeters = readMetricMeters(northCard);
    const eastLabel = eastCard.querySelector('span');
    const northLabel = northCard.querySelector('span');
    if (eastLabel) eastLabel.textContent = 'LONGITUDE';
    if (northLabel) northLabel.textContent = 'LATITUDE';

    // wire上は発射点基準ENU[m]なので、既存の地図変換と同じ基準で緯度経度へ戻す。
    if (eastMeters !== null && northMeters !== null) {
      const { lat, lon } = enuToLatLon(eastMeters, northMeters);
      const eastValue = eastCard.querySelector('strong');
      const northValue = northCard.querySelector('strong');
      if (eastValue) eastValue.textContent = `${lon.toFixed(6)}°`;
      if (northValue) northValue.textContent = `${lat.toFixed(6)}°`;
    }

    // 表示順も「緯度→経度」に統一する。
    if (eastCard.previousElementSibling !== northCard) grid.insertBefore(northCard, eastCard);
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
      rewritePositionMetrics(this);

      for (const [id, node] of preserved) {
        const replacement = this.querySelector(`#${id}`);
        if (!replacement) continue;
        syncAttributes(node, replacement);
        replacement.replaceWith(node);
      }
    },
  });
}
