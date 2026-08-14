import { runFramerTests } from './framer-tests.mjs';
import { runProtocolTests } from './protocol-smoke.mjs';
import { runSessionTests } from './session-tests.mjs';
import { runServiceTests } from './service-tests.mjs';
import { runStoreAndLifecycleTests } from './store-lifecycle-tests.mjs';

const vectorCount = runProtocolTests();
runFramerTests();
runStoreAndLifecycleTests();
runSessionTests();
await runServiceTests();
console.log(`USB v1 tests: ${vectorCount} golden vectors and host checks passed`);
