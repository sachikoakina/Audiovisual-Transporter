/**
 * CLI wrapper for read-only review verification.
 * 待核对候选只读复核的 CLI 包装。
 *
 * Usage:
 *   npx tsx scripts/review-verify.ts --input candidates.json --output results.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifyCandidate, type ReviewCandidate } from '../src/review/verify-candidate';

function argValue(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const input = argValue('--input');
const output = argValue('--output');
const candidates = JSON.parse(fs.readFileSync(input, 'utf8')) as ReviewCandidate[];
const results = [];

for (const candidate of candidates) {
  results.push(await verifyCandidate(candidate));
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(`Verified ${results.length} review candidates.`);
