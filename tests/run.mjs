import { runFramerTests } from './framer-tests.mjs';
import { runOfflineMapTests } from './offline-map-tests.mjs';
import { runProtocolTests } from './protocol-smoke.mjs';
import { runSessionTests } from './session-tests.mjs';
import { runServiceTests } from './service-tests.mjs';
import { runStoreAndLifecycleTests } from './store-lifecycle-tests.mjs';
import { runUiV2Tests } from './ui-v2-tests.mjs';

const vectorCount = runProtocolTests();
runFramerTests();
runOfflineMapTests();
runStoreAndLifecycleTests();
runUiV2Tests();
runSessionTests();
await runServiceTests();
console.log(`USB v1 tests: ${vectorCount} golden vectors, offline map, UI v2, and host checks passed`);
