export const LAUNCH_REFERENCE_LAT_DEG = 40.242865;
export const LAUNCH_REFERENCE_LON_DEG = 140.010450;
export const NORTH_METERS_PER_DEGREE = 111039.303376;
export const EAST_METERS_PER_DEGREE = 85090.557487;
export const DEFAULT_MAP_SIZE_KM = 10;
export const DEFAULT_MIN_ZOOM = 14;
export const DEFAULT_MAX_ZOOM = 17;

const WEB_MERCATOR_MAX_LAT_DEG = 85.0511287798066;
const EARTH_CIRCUMFERENCE_M = 40075016.68557849;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function enuToLatLon(eastM, northM) {
  return {
    lat: LAUNCH_REFERENCE_LAT_DEG + northM / NORTH_METERS_PER_DEGREE,
    lon: LAUNCH_REFERENCE_LON_DEG + eastM / EAST_METERS_PER_DEGREE,
  };
}

export function latLonToEnu(latDeg, lonDeg) {
  return {
    east: (lonDeg - LAUNCH_REFERENCE_LON_DEG) * EAST_METERS_PER_DEGREE,
    north: (latDeg - LAUNCH_REFERENCE_LAT_DEG) * NORTH_METERS_PER_DEGREE,
  };
}

export function enuSquareBounds(sizeKm = DEFAULT_MAP_SIZE_KM) {
  if (!Number.isFinite(sizeKm) || sizeKm <= 0) throw new RangeError('sizeKm must be positive');
  const halfSizeM = sizeKm * 500;
  const southWest = enuToLatLon(-halfSizeM, -halfSizeM);
  const northEast = enuToLatLon(halfSizeM, halfSizeM);
  return {
    south: southWest.lat,
    north: northEast.lat,
    west: southWest.lon,
    east: northEast.lon,
  };
}

export function lonToTileX(lonDeg, zoom) {
  return ((lonDeg + 180) / 360) * (2 ** zoom);
}

export function latToTileY(latDeg, zoom) {
  const lat = clamp(latDeg, -WEB_MERCATOR_MAX_LAT_DEG, WEB_MERCATOR_MAX_LAT_DEG);
  const latRad = lat * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * (2 ** zoom);
}

export function tileToLatLon(tileX, tileY, zoom) {
  const n = 2 ** zoom;
  const lon = tileX / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n)));
  return { lat: latRad * 180 / Math.PI, lon };
}

export function tileRangeForBounds(bounds, zoom) {
  const n = 2 ** zoom;
  const minX = clamp(Math.floor(lonToTileX(bounds.west, zoom)), 0, n - 1);
  const maxX = clamp(Math.floor(lonToTileX(bounds.east, zoom)), 0, n - 1);
  const minY = clamp(Math.floor(latToTileY(bounds.north, zoom)), 0, n - 1);
  const maxY = clamp(Math.floor(latToTileY(bounds.south, zoom)), 0, n - 1);
  return {
    zoom,
    minX,
    maxX,
    minY,
    maxY,
    count: (maxX - minX + 1) * (maxY - minY + 1),
  };
}

export function tilePlanForEnuSquare({
  sizeKm = DEFAULT_MAP_SIZE_KM,
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM,
} = {}) {
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom > maxZoom) {
    throw new RangeError('invalid zoom range');
  }
  const bounds = enuSquareBounds(sizeKm);
  const ranges = [];
  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) ranges.push(tileRangeForBounds(bounds, zoom));
  return {
    bounds,
    ranges,
    totalCount: ranges.reduce((sum, range) => sum + range.count, 0),
  };
}

export function groundResolutionMetersPerPixel(latDeg, zoom) {
  return EARTH_CIRCUMFERENCE_M * Math.cos(latDeg * Math.PI / 180) / (256 * (2 ** zoom));
}

export function selectTileZoom(scalePxPerMeter, {
  latDeg = LAUNCH_REFERENCE_LAT_DEG,
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM,
} = {}) {
  if (!Number.isFinite(scalePxPerMeter) || scalePxPerMeter <= 0) return minZoom;
  let bestZoom = minZoom;
  let bestError = Infinity;
  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    const nativePxPerMeter = 1 / groundResolutionMetersPerPixel(latDeg, zoom);
    const error = Math.abs(Math.log2(nativePxPerMeter / scalePxPerMeter));
    if (error < bestError) {
      bestError = error;
      bestZoom = zoom;
    }
  }
  return bestZoom;
}
