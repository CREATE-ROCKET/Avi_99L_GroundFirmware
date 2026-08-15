import assert from 'node:assert/strict';
import {
  LAUNCH_REFERENCE_LAT_DEG,
  LAUNCH_REFERENCE_LON_DEG,
  enuSquareBounds,
  enuToLatLon,
  latLonToEnu,
  selectTileZoom,
  tilePlanForEnuSquare,
} from '../shared/offline-map.js';

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

export function runOfflineMapTests() {
  const origin = latLonToEnu(LAUNCH_REFERENCE_LAT_DEG, LAUNCH_REFERENCE_LON_DEG);
  closeTo(origin.east, 0);
  closeTo(origin.north, 0);

  const roundTripLatLon = enuToLatLon(1234, -4321);
  const roundTrip = latLonToEnu(roundTripLatLon.lat, roundTripLatLon.lon);
  closeTo(roundTrip.east, 1234, 1e-6);
  closeTo(roundTrip.north, -4321, 1e-6);

  const bounds = enuSquareBounds(10);
  closeTo(bounds.south, 40.19783589906023, 1e-12);
  closeTo(bounds.north, 40.28789410093977, 1e-12);
  closeTo(bounds.west, 139.95168907343344, 1e-12);
  closeTo(bounds.east, 140.06921092656654, 1e-12);

  const plan = tilePlanForEnuSquare({ sizeKm: 10, minZoom: 14, maxZoom: 17 });
  assert.equal(plan.totalCount, 2544);
  assert.deepEqual(plan.ranges.map(({ zoom, minX, maxX, minY, maxY, count }) => (
    { zoom, minX, maxX, minY, maxY, count }
  )), [
    { zoom: 14, minX: 14561, maxX: 14566, minY: 6185, maxY: 6190, count: 36 },
    { zoom: 15, minX: 29122, maxX: 29133, minY: 12371, maxY: 12381, count: 132 },
    { zoom: 16, minX: 58245, maxX: 58266, minY: 24742, maxY: 24763, count: 484 },
    { zoom: 17, minX: 116490, maxX: 116533, minY: 49484, maxY: 49526, count: 1892 },
  ]);

  assert.equal(selectTileZoom(0.04), 14);
  assert.equal(selectTileZoom(5), 17);
}
