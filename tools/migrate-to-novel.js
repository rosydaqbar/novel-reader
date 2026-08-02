import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateMarkdownProject } from '../server/projectServer.js';

export { migrateMarkdownProject as migrateToNovel } from '../server/projectServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export function parseMigrationArgs(args) {
  const options = { sourceDir: path.join(rootDir, 'datasource'), force: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--force') {
      options.force = true;
      continue;
    }
    if (argument === '--source' || argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path.`);
      index += 1;
      if (argument === '--source') options.sourceDir = path.resolve(value);
      else options.outputPath = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  options.outputPath ??= path.join(options.sourceDir, 'project.novel');
  return options;
}

export async function runMigrationCli(args = process.argv.slice(2)) {
  const result = await migrateMarkdownProject(parseMigrationArgs(args));
  console.log(`Created ${result.outputPath}`);
  console.log(`Migrated ${result.volumeCount} volume(s), ${result.codexCount} codex entry/entries, and ${result.mentionCount} mention(s).`);
  return result;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runMigrationCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
