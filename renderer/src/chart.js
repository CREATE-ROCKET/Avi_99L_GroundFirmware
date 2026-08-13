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
    let min = slice[0];
    let max = slice[0];
    for (const point of slice) {
      if (point.y < min.y) min = point;
      if (point.y > max.y) max = point;
    }
    if (min.x <= max.x) out.push(min, max); else out.push(max, min);
  }
  return out;
}

export class SharedTrackChart {
  constructor(host, options) {
    this.host = host;
    this.title = options.title;
    this.subtitle = options.subtitle ?? '';
    this.xLabel = options.xLabel ?? 's';
    this.fixedX = options.fixedX ?? null;
    this.getData = options.getData;
    this.tracks = options.tracks;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.host.appendChild(this.canvas);
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

  draw() {
    const ctx = this.context;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const data = this.getData() ?? [];
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f8f7f2';
    ctx.fillRect(0, 0, width, height);

    const headerHeight = 34;
    const left = 48;
    const right = 12;
    const bottom = 25;
    const plotWidth = Math.max(1, width - left - right);
    const trackHeight = Math.max(42, (height - headerHeight - bottom) / this.tracks.length);

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

    this.tracks.forEach((track, trackIndex) => {
      const top = headerHeight + trackIndex * trackHeight;
      const bottomY = top + trackHeight;
      const allValues = [];
      for (const series of track.series) {
        for (const point of data) {
          const value = point[series.key];
          if (Number.isFinite(value)) allValues.push(value);
        }
      }
      const [yMin, yMax] = track.range ?? niceRange(allValues, track.fallbackRange ?? [-1, 1], track.includeZero ?? false);
      const yToPx = (value) => bottomY - 13 - (value - yMin) / (yMax - yMin) * (trackHeight - 24);

      ctx.strokeStyle = '#d7d4cc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, bottomY);
      ctx.lineTo(width - right, bottomY);
      ctx.stroke();

      for (let grid = 1; grid < 4; grid += 1) {
        const y = top + grid * trackHeight / 4;
        ctx.strokeStyle = '#e6e3dc';
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - right, y);
        ctx.stroke();
      }
      for (let tick = 0; tick <= 5; tick += 1) {
        const x = left + tick / 5 * plotWidth;
        ctx.strokeStyle = '#e6e3dc';
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottomY);
        ctx.stroke();
        if (trackIndex === this.tracks.length - 1) {
          const label = (xMin + tick / 5 * (xMax - xMin)).toFixed(xMax - xMin > 60 ? 0 : 1);
          ctx.fillStyle = '#85817a';
          ctx.font = '500 9px Inter, system-ui, sans-serif';
          ctx.fillText(label, x - ctx.measureText(label).width / 2, height - 7);
        }
      }

      ctx.fillStyle = '#77746e';
      ctx.font = '600 9px Inter, system-ui, sans-serif';
      ctx.fillText(track.label.toUpperCase(), 8, top + 14);
      ctx.fillText(yMax.toFixed(1), 8, top + 27);
      ctx.fillText(yMin.toFixed(1), 8, bottomY - 5);

      let badgeX = width - right;
      for (let seriesIndex = track.series.length - 1; seriesIndex >= 0; seriesIndex -= 1) {
        const series = track.series[seriesIndex];
        const latest = [...data].reverse().find((point) => Number.isFinite(point[series.key]))?.[series.key];
        const text = `${series.label} ${formatValue(latest, series.unit)}`;
        ctx.font = '700 9px Inter, system-ui, sans-serif';
        const badgeWidth = ctx.measureText(text).width + 12;
        badgeX -= badgeWidth;
        ctx.fillStyle = series.color;
        ctx.fillRect(badgeX, top + 5, badgeWidth - 4, 18);
        ctx.fillStyle = '#f8f7f2';
        ctx.fillText(text, badgeX + 5, top + 17);
      }

      for (const series of track.series) {
        const maxGap = series.maxGap ?? track.maxGap ?? Infinity;
        const samples = data
          .filter((point) => Number.isFinite(point.t) && point.t >= xMin && point.t <= xMax && Number.isFinite(point[series.key]))
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
          const drawPoints = thinPoints(rawSegment, plotWidth);
          if (drawPoints.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(drawPoints[0].x, drawPoints[0].y);
          for (let index = 1; index < drawPoints.length; index += 1) ctx.lineTo(drawPoints[index].x, drawPoints[index].y);
          ctx.stroke();
        }
      }
    });

    ctx.fillStyle = '#77746e';
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.fillText(this.xLabel, width - 22, height - 7);
  }

  dispose() {
    this.resizeObserver.disconnect();
  }
}
