import { startDemoPnnRelay } from '../../scripts/demo-pnn-relay.mjs';

const relay = await startDemoPnnRelay({
  endpoints: process.env.PNN_ENDPOINTS.split(','), token: process.env.RELAY_TOKEN,
  host: '0.0.0.0', port: 8789,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await relay.close(); process.exit(0);
});
