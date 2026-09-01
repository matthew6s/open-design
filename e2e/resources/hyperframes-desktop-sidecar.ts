import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SidecarFactory } from '@open-design/sidecar';
import {
  SIDECAR_MESSAGES,
  type DesktopRenderFramesInput,
} from '@open-design/sidecar-proto';

const capturePath = requireEnvironment('OD_E2E_FRAME_DOCUMENT_PATH');
const framePngPath = requireEnvironment('OD_E2E_FRAME_PNG_PATH');

const client = SidecarFactory.create({
  handlers: {
    async [SIDECAR_MESSAGES.RENDER_FRAMES](value) {
      const input = value as DesktopRenderFramesInput;
      await writeFile(capturePath, input.html, 'utf8');
      await mkdir(input.outputDir, { recursive: true });
      for (let frame = 0; frame < 3; frame += 1) {
        await copyFile(
          framePngPath,
          join(input.outputDir, `frame-${String(frame).padStart(8, '0')}.png`),
        );
      }
      return {
        duration: 0.1,
        fps: 30,
        frameCount: 3,
        framePattern: join(input.outputDir, 'frame-%08d.png'),
        height: 180,
        ok: true,
        width: 320,
      };
    },
  },
  lifecycle: {
    async start() {
      return {};
    },
    status() {
      return {
        capabilities: { frameRenderer: true },
        pid: process.pid,
        state: 'running',
        updatedAt: new Date().toISOString(),
        url: null,
        windowVisible: false,
      };
    },
    async stop() {},
  },
});

await client.start();
await client.waitUntilStopped();

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value == null || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
