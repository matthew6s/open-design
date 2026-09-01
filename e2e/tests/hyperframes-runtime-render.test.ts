// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { PNG } from 'pngjs';
import {
  getSidecarStatus,
  spawnSidecar,
} from '@open-design/sidecar';
import {
  APP_KEYS,
} from '@open-design/sidecar-proto';
import { describe, expect, test, vi } from 'vitest';

import { createSmokeSuite } from '@/vitest/suite';

const odBin = fileURLToPath(new URL('../../apps/daemon/bin/od.mjs', import.meta.url));
const desktopFixture = fileURLToPath(new URL('../resources/hyperframes-desktop-sidecar.ts', import.meta.url));

describe('HyperFrames bundled runtime end-to-end', () => {
  test('[P0] real od media generate renders MP4 through the daemon-owned HyperFrames runtime', async () => {
    const suite = await createSmokeSuite('hyperframes-runtime-render');
    const desktopStamp = {
      app: APP_KEYS.DESKTOP,
      channel: 'local',
      mode: 'dev',
      namespace: suite.namespace,
      source: 'tools-dev',
    } as const;
    const frameDocumentPath = join(suite.scratchDir, 'frame-document.html');
    const framePngPath = join(suite.scratchDir, 'frame.png');
    await writeFile(framePngPath, solidPng(320, 180));
    const desktop = await spawnSidecar({
      args: ['--import', 'tsx', desktopFixture],
      command: process.execPath,
      cwd: suite.root,
      env: {
        ...process.env,
        OD_E2E_FRAME_DOCUMENT_PATH: frameDocumentPath,
        OD_E2E_FRAME_PNG_PATH: framePngPath,
      },
      resources: {
        dataRoot: suite.dataDir,
        ownerPid: null,
        port: 0,
        runtimeRoot: suite.toolsDevRoot,
      },
      stamp: desktopStamp,
    });

    try {
      await vi.waitFor(async () => {
        await expect(getSidecarStatus(desktopStamp, { generationPid: desktop.process.pid }))
          .resolves.toMatchObject({ state: 'running' });
      }, { interval: 100, timeout: 15_000 });
      await suite.with.env(
        {
          HYPERFRAMES_FFMPEG_PATH: ffmpegInstaller.path,
          HYPERFRAMES_FFPROBE_PATH: ffprobeInstaller.path,
        },
        async () => {
          await suite.with.toolsDev(async ({ runtime }) => {
            const daemonUrl = `http://127.0.0.1:${runtime.daemonPort}`;
            const projectId = `hyperframes-render-${Date.now()}`;
            const create = await fetch(`${daemonUrl}/api/projects`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                id: projectId,
                name: 'HyperFrames real runtime render',
                skillId: null,
                designSystemId: null,
                metadata: { kind: 'video' },
              }),
            });
            expect(create.ok, await create.text()).toBe(true);

            const compositionRel = '.hyperframes-cache/e2e-real-render';
            const compositionDir = join(suite.dataDir, 'projects', projectId, compositionRel);
            await mkdir(compositionDir, { recursive: true });
            await writeFile(join(compositionDir, 'hyperframes.json'), JSON.stringify({
              paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
              media: { autoProxy: false },
            }), 'utf8');
            await writeFile(join(compositionDir, 'meta.json'), JSON.stringify({
              id: 'e2e-real-render',
              name: 'E2E real render',
            }), 'utf8');
            await writeFile(join(compositionDir, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:320px;height:180px;overflow:hidden;background:#10253f}
.clip{display:grid;place-items:center;width:320px;height:180px;color:white;font:700 28px sans-serif}
</style></head><body>
<main id="root" data-composition-id="main" data-start="0" data-duration="0.1" data-width="320" data-height="180" data-fps="30">
  <section class="clip" data-start="0" data-duration="0.1" data-track-index="1">Open Design</section>
</main>
<script>
window.__timelines=window.__timelines||{};
window.__timelines.main={duration:function(){return .1},seek:function(){}};
</script></body></html>`, 'utf8');

            const rendered = await runOd(daemonUrl, [
              'media',
              'generate',
              '--project', projectId,
              '--surface', 'video',
              '--model', 'hyperframes-html',
              '--composition-dir', compositionRel,
              '--output', 'hyperframes-e2e.mp4',
            ]);
            expect(rendered.code, rendered.stderr || rendered.stdout).toBe(0);
            const payload = JSON.parse(rendered.stdout.trim().split('\n').at(-1) ?? '{}') as {
              file?: { kind?: string; mime?: string; name?: string; size?: number };
            };
            expect(payload.file).toMatchObject({
              kind: 'video',
              mime: 'video/mp4',
              name: 'hyperframes-e2e.mp4',
              size: expect.any(Number),
            });
            expect(payload.file?.size ?? 0).toBeGreaterThan(1_000);

            const outputPath = join(suite.dataDir, 'projects', projectId, 'hyperframes-e2e.mp4');
            const [outputStat, bytes] = await Promise.all([
              stat(outputPath),
              readFile(outputPath),
            ]);
            expect(outputStat.size).toBe(payload.file?.size);
            expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
            await expect(readFile(frameDocumentPath, 'utf8')).resolves.toContain('window.__odFrameRenderer');
          });
        },
      );
    } finally {
      await desktop.stop();
    }
  }, 180_000);
});

function solidPng(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = 16;
    image.data[offset + 1] = 37;
    image.data[offset + 2] = 63;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

async function runOd(
  daemonUrl: string,
  args: string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [odBin, ...args],
      {
        env: { ...process.env, OD_DAEMON_URL: daemonUrl },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const failure = error as { code?: number } | null;
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : error ? 1 : 0,
          stderr: stderr ?? '',
          stdout: stdout ?? '',
        });
      },
    );
  });
}
