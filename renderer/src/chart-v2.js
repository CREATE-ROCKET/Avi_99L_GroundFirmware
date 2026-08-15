const DPR_LIMIT = 2;

function niceRange(values, fallback = [-1, 1], includeZero = false) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return fallback;
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (includeZero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.12;
  return [min - pad, max + pad];
}

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}

function thinPoints(points, width) {
  if (points.length <= width * 2) return points;
  const buckets = Math.max(1, Math.floor(width));
  const out = [];
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor(i * points.length / buckets);
    const end = Math.max(start + 1, Math.floor((i + 1) * points.length / buckets));
    const slice = points.slice(start, end);
    if (!slice.length) continue;
    let min = slice[0], max = slice[0];
    for (const point of slice) {
      if (point.y < min.y) min = point;
      if (point.y > max.y) max = point;
    }
    if (min.x <= max.x) out.push(min, max); else out.push(max, min);
  }
  return out;
}

function normalizedLanes(track) {
  if (Array.isArray(track.lanes) && track.lanes.length) return track.lanes;
  return [{
    label: track.label,
    series: track.series ?? [],
    range: track.range,
    fallbackRange: track.fallbackRange,
    includeZero: track.includeZero,
    maxGap: track.maxGap,
  }];
}

export class SharedTrackChart {
  constructor(host, options) {
    this.host = host;
    this.title = options.title ?? '';
    this.subtitle = options.subtitle ?? '';
    this.xLabel = options.xLabel ?? 's';
    this.fixedX = options.fixedX ?? null;
    this.getData = options.getData;
    this.tracks = options.tracks ?? [];
    this.markers = options.markers ?? [];
    this.canvas = this.host.querySelector(':scope > canvas.chart-canvas');
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'chart-canvas';
      this.host.appendChild(this.canvas);
    }
    this.context = this.canvas.getContext('2d');
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio, DPR_LIMIT);
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  drawLane(ctx, lane, data, bounds, xToPx) {
    const { left, right, top, bottom, width } = bounds;
    const values = [];
    for (const series of lane.series) {
      for (const point of data) if (Number.isFinite(point[series.key])) values.push(point[series.key]);
    }
    const [yMin, yMax] = lane.range ?? niceRange(values, lane.fallbackRange ?? [-1, 1], lane.includeZero ?? false);
    const height = bottom - top;
    const yToPx = (value) => bottom - 6 - (value - yMin) / (yMax - yMin) * Math.max(1, height - 12);

    ctx.strokeStyle = '#e1ded6';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(width - right, bottom); ctx.stroke();

    ctx.fillStyle = '#77746e';
    ctx.font = '600 8px Inter, system-ui, sans-serif';
    ctx.fillText((lane.label ?? '').toUpperCase(), 8, top + 11);

    for (const series of lane.series) {
      const maxGap = series.maxGap ?? lane.maxGap ?? Infinity;
      const samples = data
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point[series.key]))
        .map((point) => ({ t: point.t, x: xToPx(point.t), y: yToPx(point[series.key]) }));

      const segments = [];
      let segment = [];
      for (const sample of samples) {
        if (segment.length && sample.t - segment.at(-1).t > maxGap) {
          segments.push(segment);
          segment = [];
        }
        segment.push(sample);
      }
      if (segment.length) segments.push(segment);

      ctx.strokeStyle = series.color;
      ctx.lineWidth = series.width ?? 1.8;
      for (const rawSegment of segments) {
        const pts = thinPoints(rawSegment, Math.max(1, width - left - right));
        if (pts.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    }
  }

  draw() {
    const ctx = this.context;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const data = this.getData() ?? [];
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f8f7f2';
    ctx.fillRect(0, 0, width, height);

    const headerHeight = 34;
    const left = 52;
    const right = 12;
    const bottomPad = 28;
    const plotHeight = Math.max(1, height - headerHeight - bottomPad);
    const plotWidth = Math.max(1, width - left - right);
    const totalWeight = this.tracks.reduce((sum, track) => sum + (track.weight ?? 1), 0) || 1;

    ctx.fillStyle = '#141410';
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    ctx.fillText(this.title.toUpperCase(), 12, 16);
    ctx.fillStyle = '#77746e';
    ctx.font = '500 10px Inter, system-ui, sans-serif';
    ctx.fillText(this.subtitle.toUpperCase(), 12, 30);

    let xMin = this.fixedX?.[0] ?? 0;
    let xMax = this.fixedX?.[1] ?? Math.max(1, data.at(-1)?.t ?? 1);
    if (xMax <= xMin) xMax = xMin + 1;
    const xToPx = (value) => left + (value - xMin) / (xMax - xMin) * plotWidth;

    let top = headerHeight;
    for (let trackIndex = 0; trackIndex < this.tracks.length; trackIndex += 1) {
      const track = this.tracks[trackIndex];
      const trackHeight = plotHeight * (track.weight ?? 1) / totalWeight;
      const bottom = top + trackHeight;
      ctx.strokeStyle = '#d1cec6';
      ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(width, top); ctx.stroke();

      const lanes = normalizedLanes(track);
      const laneHeight = trackHeight / lanes.length;
      lanes.forEach((lane, laneIndex) => {
        const laneTop = top + laneIndex * laneHeight;
        const laneBottom = laneTop + laneHeight;
        this.drawLane(ctx, lane, data.filter((p) => p.t >= xMin && p.t <= xMax),
          { left, right, top: laneTop, bottom: laneBottom, width }, xToPx);
      });

      let badgeX = width - right;
      const badgeSeries = lanes.flatMap((lane) => lane.series);
      for (let i = badgeSeries.length - 1; i >= 0; i -= 1) {
        const series = badgeSeries[i];
        const latest = [...data].reverse().find((point) => Number.isFinite(point[series.key]))?.[series.key];
        const text = `${series.label} ${formatValue(latest, series.unit)}`;
        ctx.font = '700 8px Inter, system-ui, sans-serif';
        const badgeWidth = ctx.measureText(text).width + 12;
        badgeX -= badgeWidth;
        ctx.fillStyle = '#151714';
        ctx.fillRect(badgeX, top + 5, badgeWidth - 4, 18);
        ctx.fillStyle = series.color ?? '#f2f0ea';
        ctx.fillText(text, badgeX + 5, top + 17);
        badgeX -= 4;
      }
      top = bottom;
    }

    for (let tick = 0; tick <= 5; tick += 1) {
      const x = left + tick / 5 * plotWidth;
      ctx.strokeStyle = '#e6e3dc';
      ctx.beginPath(); ctx.moveTo(x, headerHeight); ctx.lineTo(x, height - bottomPad); ctx.stroke();
      const label = (xMin + tick / 5 * (xMax - xMin)).toFixed(xMax - xMin > 60 ? 0 : 1);
      ctx.fillStyle = '#85817a';
      ctx.font = '500 9px Inter, system-ui, sans-serif';
      ctx.fillText(label, x - ctx.measureText(label).width / 2, height - 8);
    }

    for (const marker of this.markers) {
      if (!Number.isFinite(marker.t) || marker.t < xMin || marker.t > xMax) continue;
      const x = xToPx(marker.t);
      ctx.strokeStyle = marker.color ?? '#c73c32';
      ctx.lineWidth = marker.width ?? 1;
      ctx.setLineDash(marker.dash ?? [4, 3]);
      ctx.beginPath(); ctx.moveTo(x, headerHeight); ctx.lineTo(x, height - bottomPad); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = marker.color ?? '#c73c32';
      ctx.font = '700 8px Inter, system-ui, sans-serif';
      ctx.fillText(marker.label ?? String(marker.t), Math.min(width - 120, x + 4), height - 8);
    }

    ctx.fillStyle = '#77746e';
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.fillText(this.xLabel, width - 22, height - 8);
  }

  dispose() {
    this.resizeObserver.disconnect();
  }
}
