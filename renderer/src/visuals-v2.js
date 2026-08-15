import { RocketView } from './three-view.js';
import { LocalMapView } from './map-view.js';

export class RocketViewV2 extends RocketView {
  attach(host, { interactive = false } = {}) {
    if (!host || this.host === host) {
      this.setInteractionEnabled(interactive);
      return;
    }
    this.resizeObserver.disconnect();
    this.host = host;
    host.appendChild(this.renderer.domElement);
    this.resizeObserver.observe(host);
    this.setInteractionEnabled(interactive);
    this.resize();
  }

  setInteractionEnabled(enabled) {
    this.controls.enabled = true;
    this.controls.enableRotate = Boolean(enabled);
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
