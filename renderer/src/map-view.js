import {
  enuToLatLon,
  latLonToEnu,
  selectTileZoom,
  tileRangeForBounds,
  tileToLatLon,
} from '../../shared/offline-map.js';

const TILE_CACHE_LIMIT = 128;
const OFFLINE_TILE_ROOT = 'maps/gsi-seamlessphoto/';

export class LocalMapView {
  constructor(host, store) {
    this.host = host;
    this.store = store;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.background = null;
    this.backgroundMeta = null;
    this.displayPosition = null;
    this.lastTarget = null;
    this.transitionStart = 0;
    this.tileRoot = new URL(OFFLINE_TILE_ROOT, document.baseURI);
    this.tileCache = new Map();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop = () => { this.draw(); this.frame = requestAnimationFrame(this.loop); };
    this.frame = requestAnimationFrame(this.loop);
  }

  async loadImage(url, metadata = null) {
    if (!url) { this.background = null; return; }
    const image = new Image();
    image.onload = () => { this.background = image; this.backgroundMeta = metadata; };
    image.onerror = () => console.error('map image load failed', url);
    image.src = url;
  }

  resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  transform(points, width, height) {
    const valid = points.filter((point) => Number.isFinite(point.east) && Number.isFinite(point.north));
    const eastValues = [0, ...valid.map((point) => point.east)];
    const northValues = [0, ...valid.map((point) => point.north)];
    const minE = Math.min(...eastValues), maxE = Math.max(...eastValues);
    const minN = Math.min(...northValues), maxN = Math.max(...northValues);
    const span = Math.max(80, maxE - minE, maxN - minN);
    const centerE = (minE + maxE) / 2;
    const centerN = (minN + maxN) / 2;
    const mapWidth = Math.max(1, width - 52);
    const mapHeight = Math.max(1, height - 52);
    const scale = Math.min(mapWidth, mapHeight) / (span * 1.28);
    return {
      scale,
      centerE,
      centerN,
      toScreen: (east, north) => ({
        x: width / 2 + (east - centerE) * scale,
        y: height / 2 - (north - centerN) * scale,
      }),
      fromScreen: (x, y) => ({
        east: centerE + (x - width / 2) / scale,
        north: centerN - (y - height / 2) / scale,
      }),
      span,
    };
  }

  pruneTileCache() {
    while (this.tileCache.size > TILE_CACHE_LIMIT) {
      const oldestKey = this.tileCache.keys().next().value;
      this.tileCache.delete(oldestKey);
    }
  }

  getTileImage(zoom, x, y) {
    const key = `${zoom}/${x}/${y}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      this.tileCache.delete(key);
      this.tileCache.set(key, cached);
      return cached;
    }

    const image = new Image();
    const entry = { state: 'loading', image };
    image.onload = () => { entry.state = 'ready'; };
    image.onerror = () => { entry.state = 'missing'; };
    image.src = new URL(`${zoom}/${x}/${y}.jpg`, this.tileRoot).href;
    this.tileCache.set(key, entry);
    this.pruneTileCache();
    return entry;
  }

  drawOfflineTiles(ctx, transform, width, height) {
    const zoom = selectTileZoom(transform.scale);
    const northWestEnu = transform.fromScreen(0, 0);
    const southEastEnu = transform.fromScreen(width, height);
    const northWest = enuToLatLon(northWestEnu.east, northWestEnu.north);
    const southEast = enuToLatLon(southEastEnu.east, southEastEnu.north);
    const bounds = {
      north: Math.max(northWest.lat, southEast.lat),
      south: Math.min(northWest.lat, southEast.lat),
      west: Math.min(northWest.lon, southEast.lon),
      east: Math.max(northWest.lon, southEast.lon),
    };
    const range = tileRangeForBounds(bounds, zoom);
    let ready = 0;
    let missing = 0;

    ctx.save();
    ctx.globalAlpha = 0.78;
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const entry = this.getTileImage(zoom, x, y);
        if (entry.state === 'missing') {
          missing += 1;
          continue;
        }
        if (entry.state !== 'ready') continue;

        const northWestCorner = tileToLatLon(x, y, zoom);
        const southEastCorner = tileToLatLon(x + 1, y + 1, zoom);
        const northWestTileEnu = latLonToEnu(northWestCorner.lat, northWestCorner.lon);
        const southEastTileEnu = latLonToEnu(southEastCorner.lat, southEastCorner.lon);
        const a = transform.toScreen(northWestTileEnu.east, northWestTileEnu.north);
        const b = transform.toScreen(southEastTileEnu.east, southEastTileEnu.north);
        ctx.drawImage(entry.image, a.x, a.y, b.x - a.x, b.y - a.y);
        ready += 1;
      }
    }
    ctx.restore();
    return { zoom, requested: range.count, ready, missing };
  }

  draw() {
    const ctx = this.ctx;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#17211f';
    ctx.fillRect(0, 0, width, height);

    const points = this.store.positionHistory;
    const transform = this.transform(points, width, height);
    const { toScreen, span } = transform;
    let tileStatus = null;

    if (this.background) {
      ctx.globalAlpha = 0.7;
      ctx.drawImage(this.background, 0, 0, width, height);
      ctx.globalAlpha = 1;
    } else {
      tileStatus = this.drawOfflineTiles(ctx, transform, width, height);
    }
    ctx.fillStyle = 'rgba(9,18,16,0.26)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(185,204,197,0.15)';
    ctx.lineWidth = 1;
    const gridStep = span <= 200 ? 25 : span <= 500 ? 50 : span <= 1500 ? 200 : span <= 5000 ? 500 : 1000;
    const firstE = Math.floor((transform.centerE - span) / gridStep) * gridStep;
    const firstN = Math.floor((transform.centerN - span) / gridStep) * gridStep;
    for (let east = firstE; east <= transform.centerE + span; east += gridStep) {
      const a = toScreen(east, transform.centerN - span);
      const b = toScreen(east, transform.centerN + span);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let north = firstN; north <= transform.centerN + span; north += gridStep) {
      const a = toScreen(transform.centerE - span, north);
      const b = toScreen(transform.centerE + span, north);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    const launch = toScreen(0, 0);
    ctx.strokeStyle = '#f2f0ea';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(launch.x, launch.y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#d8ddd9';
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.fillText('LAUNCHER', launch.x + 10, launch.y + 4);

    if (points.length) {
      ctx.strokeStyle = '#f05a28';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let started = false;
      let previousHostMs = null;
      for (const point of points) {
        if (!point.valid) { started = false; previousHostMs = null; continue; }
        const screen = toScreen(point.east, point.north);
        if (!started || (previousHostMs !== null && point.hostMs - previousHostMs >= 1000)) {
          ctx.moveTo(screen.x, screen.y);
          started = true;
        } else {
          ctx.lineTo(screen.x, screen.y);
        }
        previousHostMs = point.hostMs;
      }
      ctx.stroke();

      const target = points.at(-1);
      if (!this.lastTarget || target.hostMs !== this.lastTarget.hostMs) {
        this.lastTarget = target;
        if (!this.displayPosition) this.displayPosition = { east: target.east, north: target.north };
        this.transitionFrom = { ...this.displayPosition };
        this.transitionStart = performance.now();
      }
      const progress = Math.min(1, (performance.now() - this.transitionStart) / 250);
      this.displayPosition = {
        east: this.transitionFrom.east + (target.east - this.transitionFrom.east) * progress,
        north: this.transitionFrom.north + (target.north - this.transitionFrom.north) * progress,
      };
      const marker = toScreen(this.displayPosition.east, this.displayPosition.north);
      ctx.fillStyle = '#f05a28';
      ctx.beginPath(); ctx.arc(marker.x, marker.y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff7ef';
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      ctx.fillText('ROCKET', marker.x + 11, marker.y + 4);
    }

    ctx.fillStyle = '#b9c7c2';
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.fillText('LOCAL ENU / ALL RAW GNSS POINTS', 14, 20);
    if (tileStatus) {
      ctx.fillText(`OFFLINE GSI PHOTO / Z${tileStatus.zoom} / ${tileStatus.ready}/${tileStatus.requested}`, 14, height - 28);
      if (tileStatus.missing > 0) ctx.fillText(`MAP TILE MISSING ${tileStatus.missing}`, 14, height - 14);
      else ctx.fillText('出典: 国土地理院', 14, height - 14);
    }
    ctx.fillStyle = '#f2f0ea';
    ctx.fillText('N', width - 23, 21);
    ctx.strokeStyle = '#f2f0ea';
    ctx.beginPath(); ctx.moveTo(width - 19, 30); ctx.lineTo(width - 19, 56); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(width - 23, 35); ctx.lineTo(width - 19, 29); ctx.lineTo(width - 15, 35); ctx.stroke();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.tileCache.clear();
  }
}
