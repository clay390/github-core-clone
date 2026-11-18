// Test driver: start the forge on an ephemeral loopback port and print it, then serve
// forever. The kit's conformance runner (sdk/run.ts) dials it from another process.
import { createApp } from '../src/app.ts';

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('the server did not bind a TCP port');
process.stdout.write(`LISTENING ${address.port}\n`);
