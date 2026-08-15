import { RocketView } from './three-view.js';
import { LocalMapView } from './map-view.js';

export class RocketViewV2 extends RocketView {
  attach(host, { interactive = false } = {}) {
    if (!host) return;
    if (this.host !== host) {
      this.resizeObserver.disconnect();
      this.host = host;
      host.appendChild(this.renderer.domElement);
      this.resizeObserver.observe(host);
      this.resize();
    }
    this.setInteractionEnabled(interactive);
    // Only the live Flight 3D uses causal prediction. Calibration/CommandReceive
    // must show the latest measured/preflight pose, and MissionLinkFallback must
    // freeze immediately instead of predicting until the 1 s stale threshold.
    const liveFlight = Boolean(host.closest('.flight-3d'));
    this.setMode(liveFlight ? 'predictive' : 'hold');
  }

  setInteractionEnabled(enabled) {
    const interactive = Boolean(enabled);
    this.controls.enabled = interactive;
    this.controls.enableRotate = interactive;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
  }
}

export class LocalMapViewV2 extends LocalMapView {
  attach(host) {
    if (!host || this.host === host) return;
    this.resizeObserver.disconnect();
    this.host = host;
    host.appendChild(this.canvas);
    this.resizeObserver.observe(host);
    this.resize();
  }
}
