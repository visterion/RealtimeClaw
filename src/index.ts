import { AudioBridge } from './bridge.js';
import { loadConfig } from './config.js';
import { WsOpenClawClient } from './tools/ws-openclaw-client.js';
import { loadHAConfig } from './tools/ha-direct.js';
import { PicovoiceEagleFactory } from './speaker/picovoice-factory.js';
import { verifyConfig, logVerifyResults } from './tools/verify.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const verifyResults = await verifyConfig(config);
  logVerifyResults(verifyResults);
  if (verifyResults.some((r) => r.status === 'error')) {
    console.warn('[RealtimeClaw] WARNING: Starting with limited functionality');
  }

  const openclawClient = config.openclaw
    ? new WsOpenClawClient(config.openclaw)
    : undefined;

  if (openclawClient) {
    console.log(`[Main] OpenClaw client: ${config.openclaw!.url}`);
  } else {
    console.log('[Main] No OpenClaw URL configured');
  }

  const haConfig = loadHAConfig();
  if (haConfig) {
    console.log(`[Main] HA direct: ${haConfig.url}`);
  }

  let eagleFactory: PicovoiceEagleFactory | undefined;
  if (config.eagle.enabled) {
    eagleFactory = new PicovoiceEagleFactory();
    await eagleFactory.init();
  }
  const bridge = new AudioBridge(config, eagleFactory, openclawClient, haConfig);

  bridge.on('session:connected', (id) => {
    console.log(`[Main] Session connected: ${id}`);
  });

  bridge.on('transcript', (_id, text) => {
    console.log(`[Main] Assistant: ${text}`);
  });

  bridge.on('error', (id, err) => {
    console.error(`[Main] Error in ${id}: ${err.message}`);
  });

  const shutdown = () => {
    bridge.stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bridge.start();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
