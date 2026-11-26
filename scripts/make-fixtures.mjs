#!/usr/bin/env node
/**
 * Generate deterministic, fully local fixtures resembling an offline map
 * workstation's daily build output. Re-running it restores the same bytes.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'offline-map-station');

function tile(seed, kilobytes = 4) {
  const buffer = Buffer.alloc(kilobytes * 1024);
  buffer.write('MVT1', 0, 'ascii');
  for (let index = 4; index < buffer.length; index += 1) {
    buffer[index] = (seed * 31 + index * 17) & 0xff;
  }
  return buffer;
}

function manifest(day, tiles) {
  return JSON.stringify(
    {
      product: 'offline-map-station',
      buildDate: day,
      region: 'cuenca-and-delta',
      format: 'vector-tiles+style',
      tiles,
    },
    null,
    2,
  ) + '\n';
}

const days = {
  'day-2026-11-20': {
    'BUILD.txt': 'build=1001 channel=stable\n',
    'map/style.json': JSON.stringify({ version: 8, name: 'field-map-v1', layers: ['land', 'water', 'roads'] }, null, 2) + '\n',
    'manifest.json': manifest('2026-11-20', ['10/0/0', '10/0/1', '10/1/0', '11/0/0']),
    'tiles/10/0/0.mvt': tile(10),
    'tiles/10/0/1.mvt': tile(11),
    'tiles/10/1/0.mvt': tile(12),
    'tiles/11/0/0.mvt': tile(13),
  },
  'day-2026-11-21': {
    'BUILD.txt': 'build=1002 channel=stable\n',
    'map/style.json': JSON.stringify({ version: 8, name: 'field-map-v1.1', layers: ['land', 'water', 'roads', 'labels'] }, null, 2) + '\n',
    'manifest.json': manifest('2026-11-21', ['10/0/0', '10/0/1', '10/1/0', '11/0/0', '11/0/1']),
    // These three are byte-identical to the previous day and must deduplicate.
    'tiles/10/0/0.mvt': tile(10),
    'tiles/10/0/1.mvt': tile(11),
    'tiles/10/1/0.mvt': tile(12),
    'tiles/11/0/0.mvt': tile(13),
    'tiles/11/0/1.mvt': tile(21),
  },
  'day-2026-11-22': {
    'BUILD.txt': 'build=1003 channel=stable\n',
    'map/style.json': JSON.stringify({ version: 9, name: 'field-map-v2', layers: ['land', 'water', 'roads', 'labels', 'contours'] }, null, 2) + '\n',
    'manifest.json': manifest('2026-11-22', ['10/0/0', '10/0/1', '10/1/0', '11/0/0', '11/0/1', '11/1/0']),
    'tiles/10/0/0.mvt': tile(10),
    'tiles/10/0/1.mvt': tile(11),
    'tiles/10/1/0.mvt': tile(32), // updated content
    'tiles/11/0/0.mvt': tile(13),
    'tiles/11/0/1.mvt': tile(21),
    'tiles/11/1/0.mvt': tile(33),
  },
};

await rm(fixtureRoot, { recursive: true, force: true });
for (const [day, files] of Object.entries(days)) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(fixtureRoot, day, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

await writeFile(
  path.join(projectRoot, 'fixtures', 'README.md'),
  `# 自带夹具

\`offline-map-station/\` 是由 \`scripts/make-fixtures.mjs\` 生成的三天离线地图工作站构建产物：

- 包含 JSON、文本和确定性的二进制 \`.mvt\` 瓦片；
- 相邻日期保留大量字节相同的瓦片，用于验证内容去重；
- 第二天新增瓦片，第三天修改并新增瓦片。

可随时运行 \`node scripts/make-fixtures.mjs\` 重新生成；不需要网络或外部服务。
`,
);

console.log(`fixtures written to ${fixtureRoot}`);
