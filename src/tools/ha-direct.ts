// Direct Home Assistant REST API client — no OpenClaw, no LLM overhead
import type { RealtimeTool } from '../types.js';

export interface HAConfig {
  url: string;
  token: string;
}

export function loadHAConfig(): HAConfig | undefined {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) return undefined;
  return { url: url.replace(/\/$/, ''), token };
}

/** Tools that xAI can call as function calls */
export function getHATools(): RealtimeTool[] {
  return [
    {
      type: 'function',
      name: 'light_control',
      description: 'Licht ein- oder ausschalten oder dimmen. Beispiel: "Mach das Küchenlicht an"',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Die entity_id des Lichts, z.B. light.kuche oder light.wohnzimmer1' },
          action: { type: 'string', enum: ['turn_on', 'turn_off', 'toggle'], description: 'Aktion' },
          brightness_pct: { type: 'number', description: 'Helligkeit in Prozent (1-100), optional' },
        },
        required: ['entity_id', 'action'],
      },
    },
    {
      type: 'function',
      name: 'get_state',
      description: 'Status einer Entität abfragen. Beispiel: "Ist das Licht im Bad an?"',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Die entity_id, z.B. light.bad3 oder sensor.temperature' },
        },
        required: ['entity_id'],
      },
    },
    {
      type: 'function',
      name: 'call_service',
      description: 'Einen HA Service aufrufen. Für Klimaanlage, Medienplayer, Schalter etc.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain z.B. switch, climate, media_player, script' },
          service: { type: 'string', description: 'Service z.B. turn_on, turn_off, set_temperature' },
          entity_id: { type: 'string', description: 'Entity ID' },
          data: { type: 'object', description: 'Zusätzliche Service-Daten, optional' },
        },
        required: ['domain', 'service'],
      },
    },
    {
      type: 'function',
      name: 'list_entities',
      description: 'Alle Entitäten einer Domain auflisten. Beispiel: "Welche Lichter gibt es?"',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain z.B. light, switch, sensor, climate' },
        },
        required: ['domain'],
      },
    },
  ];
}

/** Execute a tool call against HA REST API */
export async function executeHATool(
  config: HAConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const headers = {
    'Authorization': `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };

  try {
    switch (name) {
      case 'light_control': {
        const service = args.action as string;
        const body: Record<string, unknown> = { entity_id: args.entity_id };
        if (args.brightness_pct && service === 'turn_on') {
          body.brightness_pct = args.brightness_pct;
        }
        const res = await fetch(`${config.url}/api/services/light/${service}`, {
          method: 'POST', headers, body: JSON.stringify(body),
        });
        if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
        // Read back actual state after action
        const stateRes = await fetch(`${config.url}/api/states/${args.entity_id}`, { headers });
        const state = stateRes.ok
          ? await stateRes.json() as { state: string; attributes: Record<string, unknown> }
          : null;
        return JSON.stringify({
          status: 'ok',
          action: service,
          entity: args.entity_id,
          current_state: state?.state ?? 'unknown',
          brightness: state?.attributes?.brightness,
          friendly_name: state?.attributes?.friendly_name,
        });
      }

      case 'get_state': {
        const res = await fetch(`${config.url}/api/states/${args.entity_id}`, { headers });
        if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
        const state = await res.json() as { state: string; attributes: Record<string, unknown> };
        return JSON.stringify({
          entity_id: args.entity_id,
          state: state.state,
          friendly_name: state.attributes.friendly_name,
          brightness: state.attributes.brightness,
        });
      }

      case 'call_service': {
        const body: Record<string, unknown> = {};
        if (args.entity_id) body.entity_id = args.entity_id;
        if (args.data) Object.assign(body, args.data as object);
        const res = await fetch(
          `${config.url}/api/services/${args.domain}/${args.service}`,
          { method: 'POST', headers, body: JSON.stringify(body) },
        );
        if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
        // Read back state if entity_id provided
        if (args.entity_id) {
          const stateRes = await fetch(`${config.url}/api/states/${args.entity_id}`, { headers });
          if (stateRes.ok) {
            const state = await stateRes.json() as { state: string; attributes: Record<string, unknown> };
            return JSON.stringify({
              status: 'ok', domain: args.domain, service: args.service,
              current_state: state.state,
              friendly_name: state.attributes.friendly_name,
            });
          }
        }
        return JSON.stringify({ status: 'ok', domain: args.domain, service: args.service });
      }

      case 'list_entities': {
        const res = await fetch(`${config.url}/api/states`, { headers });
        if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
        const states = await res.json() as Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
        const domain = args.domain as string;
        const filtered = states
          .filter(s => s.entity_id.startsWith(`${domain}.`))
          .map(s => ({
            entity_id: s.entity_id,
            state: s.state,
            name: s.attributes.friendly_name,
          }));
        return JSON.stringify({ count: filtered.length, entities: filtered });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}
