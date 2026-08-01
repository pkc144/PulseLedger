import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'src');
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? await sourceFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat().filter((file) => file.endsWith('.ts'));
}

function relativeName(file: string): string {
  return path.relative(repositoryRoot, file).split(path.sep).join('/');
}

function featureName(file: string): string | undefined {
  return relativeName(file).match(/^src\/modules\/([^/]+)\//)?.[1];
}

function resolveLocalImport(source: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(source), specifier);
  return resolved.endsWith('.js') ? `${resolved.slice(0, -3)}.ts` : resolved;
}

function record(violations: string[], source: string, specifier: string, reason: string): void {
  violations.push(`${relativeName(source)} -> ${specifier}: ${reason}`);
}

const files = await sourceFiles(sourceRoot);
const violations: string[] = [];

for (const source of files) {
  const sourceName = relativeName(source);
  const sourceFeature = featureName(source);
  const contents = await readFile(source, 'utf8');

  for (const match of contents.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    const target = resolveLocalImport(source, specifier);

    if (sourceName.endsWith('-domain.ts') && (!target || featureName(target) !== sourceFeature)) {
      record(violations, source, specifier, 'domain code may only import within its own feature');
      continue;
    }

    if (!target) continue;

    const targetName = relativeName(target);
    const targetFeature = featureName(target);

    if (sourceName.startsWith('src/infrastructure/') && targetFeature) {
      record(violations, source, specifier, 'shared infrastructure cannot depend on a feature');
    }

    if (sourceFeature && targetFeature && sourceFeature !== targetFeature) {
      if (!targetName.endsWith('-domain.ts')) {
        record(
          violations,
          source,
          specifier,
          "features may depend only on another feature's public domain contract",
        );
      }
    }

    if (sourceName.endsWith('-routes.ts')) {
      if (targetName.startsWith('src/infrastructure/') || targetName.endsWith('-repository.ts')) {
        record(
          violations,
          source,
          specifier,
          'HTTP adapters must use ports, not persistence adapters',
        );
      }
    }

    if (sourceName.endsWith('-repository.ts') && targetName.endsWith('-routes.ts')) {
      record(violations, source, specifier, 'persistence adapters cannot depend on HTTP adapters');
    }
  }
}

if (violations.length > 0) {
  console.error('Architecture boundary violations:\n');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture boundaries valid (${files.length} source files checked)`);
}
