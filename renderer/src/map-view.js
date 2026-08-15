import {
  enuToLatLon,
  fitLauncherAndTarget,
  latLonToEnu,
  selectTileZoom,
  tileRangeForBounds,
  tileToLatLon,
} from '../../shared/offline-map.js';

const TILE_CACHE_LIMIT = 128;
const OFFLINE_TILE_ROOT = 'maps/gsi-seamlessphoto/';
const TILE_FADE_MS = 180;
const VIEW_TRANSITION_MS = 250;
const COLOR_SAMPLE_SIZE = 8;
const DEFAULT_PHOTO_FILL = [31, 55, 61];

function latestValidPoint(points) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point?.valid && Number.isFinite(point.east) && Number.isFinite(point.north)) return point;
  }
  return null;
}

function sampleImageColor(image) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = COLOR_SAMPLE_SIZE;
    canvas.height = COLOR_SAMPLE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
    const data = context.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE).data;
    let red = 0;
    let green = 0;
    let blue = 0;
    let weight = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] / 255;
      if (alpha <= 0) continue;
      red += data[index] * alpha;
      green += data[index + 1] * alpha;
      blue += data[index + 2] * alpha;
      weight += alpha;
    }
    if (weight <= 0) return null;
    return [red / weight, green / weight, blue / weight];
  } catch {
    return null;
  }
}

function averageColors(colors, fallback) {
  if (!colors.length) return fallback;
  const sum = colors.reduce((acc, color) => [
    acc[0] + color[0],
    acc[1] + color[1],
    acc[2] + color[2],
  ], [0, 0, 0]);
  return sum.map((value) => value / colors.length);
}

function nearbyColor(tile, readyTiles, fallback) {
  let red = 0;
  let green = 0;
  let blue = 0;
  let totalWeight = 0;
  for (const ready of readyTiles) {
    if (!ready.entry.color) continue;
    const dx = ready.x - tile.x;
    const dy = ready.y - tile.y;
    const distanceSquared = dx * dx + dy * dy;
    const weight = 1 / (0.35 + distanceSquared);
    red += ready.entry.color[0] * weight;
    green += ready.entry.color[1] * weight;
    blue += ready.entry.color[2] * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return fallback;
  return [red / totalWeight, green / totalWeight, blue / totalWeight];
}

function rgbCss(color) {
  return `rgb(${Math.round(color[0])} ${Math.round(color[1])} ${Math.round(color[2])})`;
}

function easeOutCubic(value) {
  return 1 - ((1 - value) ** 3);
}

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
    this.lastTargetKey = null;
    this.transitionStart = 0;
    this.tileRoot = new URL(OFFLINE_TILE_ROOT, document.baseURI);
    this.tileCache = new Map();
    this.photoFillColor = DEFAULT_PHOTO_FILL;
    this.viewport = null;
    this.viewportFrom = null;
    this.viewportTarget = null;
    this.viewportKey = null;
    this.viewportTransitionStart = 0;
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
    const latest = latestValidPoint(points);
    const target = fitLauncherAndTarget(
      latest?.east ?? 0,
      latest?.north ?? 0,
      width,
      height,
    );
    const key = `${latest?.hostMs ?? 'origin'}:${latest?.east ?? 0}:${latest?.north ?? 0}:${width}:${height}`;
    const now = performance.now();

    if (!this.viewport) {
      this.viewport = { ...target };
      this.viewportFrom = { ...target };
      this.viewportTarget = { ...target };
      this.viewportKey = key;
      this.viewportTransitionStart = now;
    } else if (this.viewportKey !== key) {
      this.viewportFrom = { ...this.viewport };
      this.viewportTarget = { ...target };
      this.viewportKey = key;
      this.viewportTransitionStart = now;
    }

    const rawProgress = Math.min(1, Math.max(0, (now - this.viewportTransitionStart) / VIEW_TRANSITION_MS));
    const progress = easeOutCubic(rawProgress);
    const from = this.viewportFrom ?? target;
    const to = this.viewportTarget ?? target;
    const scaleRatio = from.scale > 0 ? to.scale / from.scale : 1;
    this.viewport = {
      centerE: from.centerE + (to.centerE - from.centerE) * progress,
      centerN: from.centerN + (to.centerN - from.centerN) * progress,
      scale: from.scale * (scaleRatio ** progress),
    };

    const { centerE, centerN, scale } = this.viewport;
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
      span: Math.max(width / scale, height / scale),
      latest,
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
    const entry = { state: 'loading', image, color: null, readyAt: null };
    image.onload = () => {
      entry.state = 'ready';
      entry.color = sampleImageColor(image);
      entry.readyAt = performance.now();
    };
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
    const tiles = [];

    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const entry = this.getTileImage(zoom, x, y);
        const northWestCorner = tileToLatLon(x, y, zoom);
        const southEastCorner = tileToLatLon(x + 1, y + 1, zoom);
        const northWestTileEnu = latLonToEnu(northWestCorner.lat, northWestCorner.lon);
        const southEastTileEnu = latLonToEnu(southEastCorner.lat, southEastCorner.lon);
        const a = transform.toScreen(northWestTileEnu.east, northWestTileEnu.north);
        const b = transform.toScreen(southEastTileEnu.east, southEastTileEnu.north);
        tiles.push({
          x,
          y,
          entry,
          left: a.x,
          top: a.y,
          width: b.x - a.x,
          height: b.y - a.y,
        });
      }
    }

    const readyTiles = tiles.filter((tile) => tile.entry.state === 'ready');
    const visibleColors = readyTiles.map((tile) => tile.entry.color).filter(Boolean);
    if (visibleColors.length) this.photoFillColor = averageColors(visibleColors, this.photoFillColor);

    let ready = 0;
    let missing = 0;
    let loading = 0;
    const now = performance.now();
    ctx.save();

    // 写真が存在しない海域等は、周辺写真の平均色だけで埋める。
    // 地形を捏造しないため、画像内容の補間や標準地図への差し替えは行わない。
    for (const tile of tiles) {
      if (tile.entry.state === 'missing') missing += 1;
      else if (tile.entry.state === 'loading') loading += 1;
      else ready += 1;
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = rgbCss(nearbyColor(tile, readyTiles, this.photoFillColor));
      ctx.fillRect(tile.left, tile.top, tile.width + 0.5, tile.height + 0.5);
    }

    for (const tile of readyTiles) {
      const fadeProgress = tile.entry.readyAt === null
        ? 1
        : Math.min(1, Math.max(0, (now - tile.entry.readyAt) / TILE_FADE_MS));
      ctx.globalAlpha = 0.78 * fadeProgress;
      ctx.drawImage(tile.entry.image, tile.left, tile.top, tile.width + 0.5, tile.height + 0.5);
    }
    ctx.restore();

    return { zoom, requested: range.count, ready, missing, loading };
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
    const { toScreen, span, latest } = transform;
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

    if (latest) {
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

      const targetKey = `${latest.hostMs ?? ''}:${latest.east}:${latest.north}`;
      if (targetKey !== this.lastTargetKey) {
        this.lastTargetKey = targetKey;
        if (!this.displayPosition) this.displayPosition = { east: latest.east, north: latest.north };
        this.transitionFrom = { ...this.displayPosition };
        this.transitionStart = performance.now();
      }
      const progress = easeOutCubic(Math.min(1, (performance.now() - this.transitionStart) / VIEW_TRANSITION_MS));
      this.displayPosition = {
        east: this.transitionFrom.east + (latest.east - this.transitionFrom.east) * progress,
        north: this.transitionFrom.north + (latest.north - this.transitionFrom.north) * progress,
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
    ctx.fillText('LOCAL ENU / LAUNCHER + LATEST POSITION FIT', 14, 20);
    if (tileStatus) {
      ctx.fillText(`OFFLINE GSI PHOTO / Z${tileStatus.zoom} / ${tileStatus.ready}/${tileStatus.requested}`, 14, height - 28);
      if (tileStatus.missing > 0) {
        ctx.fillText(`PHOTO GAP FILL ${tileStatus.missing} / COLOR ONLY`, 14, height - 14);
      } else if (tileStatus.loading > 0) {
        ctx.fillText(`PHOTO TILES LOADING ${tileStatus.loading}`, 14, height - 14);
      } else {
        ctx.fillText('出典: 国土地理院', 14, height - 14);
      }
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
