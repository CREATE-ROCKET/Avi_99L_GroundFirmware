import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_MAP_SIZE_KM,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  LAUNCH_REFERENCE_LAT_DEG,
  LAUNCH_REFERENCE_LON_DEG,
  tilePlanForEnuSquare,
} from '../shared/offline-map.js';

const SOURCE_TEMPLATE = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
const DEFAULT_OUTPUT = path.resolve('public/maps/gsi-seamlessphoto');
const MAX_RETRIES = 4;
const REQUEST_DELAY_MS = 75;

function usage() {
  console.log(`99L offline map downloader

Usage:
  npm run map:download
  node scripts/download-offline-map.mjs [options]

Options:
  --size-km <km>       Launcher-centered square size (default: ${DEFAULT_MAP_SIZE_KM})
  --min-zoom <z>       Minimum zoom (default: ${DEFAULT_MIN_ZOOM})
  --max-zoom <z>       Maximum zoom (default: ${DEFAULT_MAX_ZOOM})
  --concurrency <n>    Concurrent downloads, 1..8 (default: 4)
  --out <directory>    Output directory (default: public/maps/gsi-seamlessphoto)
  --help               Show this help
`);
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    sizeKm: DEFAULT_MAP_SIZE_KM,
    minZoom: DEFAULT_MIN_ZOOM,
    maxZoom: DEFAULT_MAX_ZOOM,
    concurrency: 4,
    out: DEFAULT_OUTPUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { ...options, help: true };
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    if (arg === '--size-km') options.sizeKm = parseNumber(value, arg);
    else if (arg === '--min-zoom') options.minZoom = parseInteger(value, arg);
    else if (arg === '--max-zoom') options.maxZoom = parseInteger(value, arg);
    else if (arg === '--concurrency') options.concurrency = parseInteger(value, arg);
    else if (arg === '--out') options.out = path.resolve(value);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.sizeKm <= 0) throw new Error('--size-km must be positive');
  if (options.minZoom < 14 || options.maxZoom > 18 || options.minZoom > options.maxZoom) {
    throw new Error('seamlessphoto zoom range must stay within 14..18');
  }
  if (options.concurrency < 1 || options.concurrency > 8) throw new Error('--concurrency must be 1..8');
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExistsNonEmpty(filename) {
  try {
    return (await fs.stat(filename)).size > 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sourceUrl(zoom, x, y) {
  return SOURCE_TEMPLATE
    .replace('{z}', String(zoom))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

async function downloadOne(task, outputRoot) {
  const filename = path.join(outputRoot, String(task.zoom), String(task.x), `${task.y}.jpg`);
  if (await fileExistsNonEmpty(filename)) return 'skipped';
  await fs.mkdir(path.dirname(filename), { recursive: true });

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(sourceUrl(task.zoom, task.x, task.y), {
        headers: { 'User-Agent': 'CREATE-99L-Ground-Station/0.1 offline-map-downloader' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) throw new Error(`unexpected content-type: ${contentType || 'unknown'}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error('empty response');
      const temporary = `${filename}.part`;
      await fs.writeFile(temporary, bytes);
      await fs.rename(temporary, filename);
      return 'downloaded';
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await sleep(300 * (2 ** (attempt - 1)));
    }
  }
  throw new Error(`${task.zoom}/${task.x}/${task.y}: ${lastError?.message ?? 'download failed'}`);
}

function buildTasks(ranges) {
  const tasks = [];
  for (const range of ranges) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) tasks.push({ zoom: range.zoom, x, y });
    }
  }
  return tasks;
}

async function writeMetadata(options, plan, stats) {
  const metadata = {
    schema: 1,
    source: '国土地理院 全国最新写真（シームレス）',
    sourceTemplate: SOURCE_TEMPLATE,
    attribution: '出典: 国土地理院',
    launcher: { latDeg: LAUNCH_REFERENCE_LAT_DEG, lonDeg: LAUNCH_REFERENCE_LON_DEG },
    sizeKm: options.sizeKm,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    bounds: plan.bounds,
    ranges: plan.ranges,
    totalTiles: plan.totalCount,
    complete: stats.failed === 0,
    downloadedAtUtc: new Date().toISOString(),
  };
  await fs.writeFile(path.join(options.out, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const plan = tilePlanForEnuSquare(options);
  const tasks = buildTasks(plan.ranges);
  const stats = { downloaded: 0, skipped: 0, failed: 0, finished: 0 };
  const failures = [];
  let nextIndex = 0;

  console.log(`launcher: ${LAUNCH_REFERENCE_LAT_DEG}, ${LAUNCH_REFERENCE_LON_DEG}`);
  console.log(`area: ${options.sizeKm} km square / z${options.minZoom}..z${options.maxZoom}`);
  console.log(`tiles: ${plan.totalCount} / output: ${options.out}`);
  for (const range of plan.ranges) {
    console.log(`  z${range.zoom}: x=${range.minX}..${range.maxX} y=${range.minY}..${range.maxY} (${range.count})`);
  }

  await fs.mkdir(options.out, { recursive: true });
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try {
        const result = await downloadOne(task, options.out);
        stats[result] += 1;
      } catch (error) {
        stats.failed += 1;
        failures.push(error.message);
      }
      stats.finished += 1;
      if (stats.finished % 100 === 0 || stats.finished === tasks.length) {
        console.log(`progress ${stats.finished}/${tasks.length} downloaded=${stats.downloaded} skipped=${stats.skipped} failed=${stats.failed}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  await writeMetadata(options, plan, stats);

  if (failures.length > 0) {
    console.error(`failed tiles: ${failures.length}`);
    for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
    if (failures.length > 20) console.error(`  ... ${failures.length - 20} more`);
    process.exitCode = 1;
    return;
  }
  console.log('offline map download complete');
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  usage();
  process.exitCode = 1;
}
