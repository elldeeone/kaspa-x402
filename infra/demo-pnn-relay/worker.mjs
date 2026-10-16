import { Container } from '@cloudflare/containers';

export class DemoPnnRelay extends Container {
  defaultPort = 8789;
  sleepAfter = '10m';
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { RELAY_TOKEN: env.RELAY_TOKEN, PNN_ENDPOINTS: env.PNN_ENDPOINTS };
  }
}

export default {
  async fetch(request, env) {
    const answer = status => new Response('{}', { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
    if (typeof env.RELAY_TOKEN !== 'string' || new TextEncoder().encode(env.RELAY_TOKEN).length < 32) return answer(503);
    const encoder = new TextEncoder();
    const [provided, expected] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('authorization') ?? '')),
      crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${env.RELAY_TOKEN}`)),
    ]);
    if (!crypto.subtle.timingSafeEqual(provided, expected)) return answer(401);
    if (new URL(request.url).pathname !== '/rpc' || request.method !== 'POST') return answer(404);
    try {
      const response = await env.RELAY.getByName('transport-v1').fetch(request, { signal: AbortSignal.timeout(30_000) });
      if (response.status >= 500) { await response.body?.cancel(); return answer(503); }
      return response;
    } catch {
      console.error(JSON.stringify({ event: 'relay-container-unavailable' }));
      return answer(503);
    }
  },
};
