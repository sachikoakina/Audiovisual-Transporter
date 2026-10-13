/*
 * Probe the real NeoDB shelf API and dump its actual response shape.
 *
 * Run this BEFORE trusting the data model — it prints what the server really
 * returns rather than what the docs claim.
 *
 * USAGE:
 *   npm run probe:neodb                 # probe every shelf type, page 1
 *   npm run probe:neodb -- complete     # probe one shelf type
 *
 * Requires NEODB_API_TOKEN in .env. Writes raw responses to .cache/probe-*.json
 * (git-ignored), and prints a field-by-field summary to the console.
 */

import fs from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { neodbToken, fetchShelfPage, getNeodbMe, verifyNeodbToken } from '../src/neodb';
import { neodbTmdbConfig, validateNeodbTmdbCredentials } from '../src/sync-config';
import { SHELF_TYPES, type ShelfType } from '../src/types';

const OUT_DIR = '.cache';

function describeShape(value: unknown, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  if (value === null) {
    return [`${pad}null`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${pad}[] (empty)`];
    }
    return [`${pad}[${value.length} item(s)]`, ...describeShape(value[0], depth + 1)];
  }
  if (typeof value === 'object') {
    const lines: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const type = Array.isArray(child)
        ? 'array'
        : child === null
          ? 'null'
          : typeof child;
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        lines.push(`${pad}${key}: {`);
        lines.push(...describeShape(child, depth + 1));
        lines.push(`${pad}}`);
      } else if (Array.isArray(child)) {
        lines.push(`${pad}${key}: ${type} (len=${(child as unknown[]).length})`);
      } else {
        lines.push(`${pad}${key}: ${type} = ${JSON.stringify(child)?.slice(0, 80)}`);
      }
    }
    return lines;
  }
  return [`${pad}${String(value)}`];
}

async function main(): Promise<void> {
  const credentials = validateNeodbTmdbCredentials();
  if (!neodbToken) {
    consola.error('NEODB_API_TOKEN is not set. Copy .env.example to .env first.');
    process.exitCode = 1;
    return;
  }
  if (!credentials.ok) {
    consola.warn('Credential notes:', credentials.problems.join(' | '));
  }

  consola.info(`NeoDB base URL: ${neodbTmdbConfig.neodb.baseUrl}`);

  // 1) token + account
  const tokenOk = await verifyNeodbToken();
  consola.info(`GET /api/token → ${tokenOk ? 'OK (token valid)' : 'FAILED'}`);
  if (!tokenOk) {
    process.exitCode = 1;
    return;
  }

  const me = await getNeodbMe();
  consola.info('GET /api/me →', me);

  // 2) shelf, per type
  const requested = process.argv[2] as ShelfType | undefined;
  const targets = requested ? [requested] : [...SHELF_TYPES];
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const shelfType of targets) {
    consola.start(`GET /api/me/shelf/${shelfType}?page=1`);
    const result = await fetchShelfPage({ shelfType, page: 1 });

    if (result === null) {
      consola.warn(`  ${shelfType}: request failed (see error above).`);
      continue;
    }

    consola.info(
      `  ${shelfType}: count=${result.count}, pages=${result.pages}, data.length=${result.data.length}`,
    );

    const first = result.data[0];
    if (!first) {
      consola.info('  (empty shelf)');
      continue;
    }

    consola.log('\n  ── MarkSchema (data[0]) ──');
    for (const line of describeShape(first)) {
      consola.log(`  ${line}`);
    }

    if (first.item) {
      consola.log('\n  ── ItemSchema (data[0].item) ──');
      for (const line of describeShape(first.item)) {
        consola.log(`  ${line}`);
      }
      consola.log(
        `\n  external_resources: ${JSON.stringify(first.item.external_resources)}`,
      );
    }

    const file = path.join(OUT_DIR, `probe-${shelfType}.json`);
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    consola.success(`  raw response → ${file}`);
  }

  consola.info('\nProbe complete. Responses saved under .cache/ (git-ignored).');
}

main().catch((error: unknown) => {
  consola.error('Probe failed: ', error);
  process.exitCode = 1;
});
