#!/usr/bin/env bun
// Cut a catalog release: build, zip dist/ into docs/, and fold the new version
// into docs/catalog.v1.json — the catalog.v1 source bridgething installs from.
//
// The zip is the bundle push.ts would rsync: dist/ contents at the zip root,
// index.html and manifest.json included, sourcemaps left out. Version and
// identity come from public/manifest.json; this script never invents either.
//
//   bun run release --changelog "what changed"
//   bun run release --changelog "..." --skip-build   # zip whatever is in dist/
//
// Re-running for a version already in the catalog replaces that entry in place.
import { zipSync } from 'fflate';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = 'https://github.com/jstgnkl/bridgething-claude';
const RAW = 'https://raw.githubusercontent.com/jstgnkl/bridgething-claude/main';
const ICON = `${RAW}/public/icon.svg`;
const MIN_LIBBRIDGETHING = '0.8.0';

const repoDir = resolve(import.meta.dir, '..');
const distDir = resolve(repoDir, 'dist');
const docsDir = resolve(repoDir, 'docs');
const catalogPath = join(docsDir, 'catalog.v1.json');

const args = process.argv.slice(2);
const changelog = args[args.indexOf('--changelog') + 1];
if (!args.includes('--changelog') || !changelog || changelog.startsWith('--')) {
  console.error('usage: bun run release --changelog "what changed" [--skip-build]');
  process.exit(1);
}

if (!args.includes('--skip-build')) {
  const build = spawnSync('bun', ['run', 'build'], { cwd: repoDir, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`no manifest.json at ${manifestPath}; run 'bun run build' first or drop --skip-build`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  permissions?: string[];
  role?: string;
  overlay?: unknown;
};
for (const field of ['id', 'name', 'version'] as const) {
  if (!manifest[field]) throw new Error(`${manifestPath} has no '${field}' field`);
}
const version = manifest.version as string;

// Everything in dist/ except sourcemaps and dotfiles: the maps are a third of the
// bundle and nothing on the device reads them.
const files: Record<string, Uint8Array> = {};
function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs);
    else if (!entry.endsWith('.map')) files[relative(distDir, abs)] = new Uint8Array(readFileSync(abs));
  }
}
walk(distDir);
if (!files['index.html']) throw new Error('bundle has no index.html at its root; the device rejects that');

mkdirSync(docsDir, { recursive: true });
const zipName = `claude-thing-bridgething-v${version}.zip`;

// A published version is immutable: its sha256 is already in the catalog and
// on any device that installed it. Bump public/manifest.json instead.
if (existsSync(catalogPath) && !args.includes('--force')) {
  const published = (JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog).apps
    .find(a => a.id === manifest.id)
    ?.versions.some(v => v.version === version);
  if (published) {
    console.error(`${version} is already in docs/catalog.v1.json — bump the version, or pass --force`);
    process.exit(1);
  }
}

// Fixed mtime, so the same dist/ always zips to the same bytes and the sha256 is
// a fact about the bundle rather than about when it was packaged.
const zip = zipSync(files, { level: 9, mtime: '1980-01-01T00:00:00Z' });
writeFileSync(join(docsDir, zipName), zip);

const released_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const entry = {
  version,
  released_at,
  download: {
    url: `${RAW}/docs/${zipName}`,
    size: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
  },
  permissions: manifest.permissions ?? [],
  min_libbridgething_version: MIN_LIBBRIDGETHING,
  changelog,
  ...(manifest.role === 'launcher' ? { role: 'launcher' as const } : {}),
  ...(manifest.overlay ? { provides_overlay: true as const } : {}),
};

type Catalog = {
  schema: string;
  updated_at: string;
  repo: Record<string, string>;
  apps: { id: string; versions: { version: string; released_at: string }[] }[];
  recommended_sources: unknown[];
};

const catalog: Catalog = existsSync(catalogPath)
  ? JSON.parse(readFileSync(catalogPath, 'utf8'))
  : {
      schema: 'catalog.v1',
      updated_at: released_at,
      repo: {
        name: 'claude-thing',
        description: 'Claude Code on a Spotify Car Thing.',
        homepage: REPO,
        icon: ICON,
      },
      apps: [],
      recommended_sources: [],
    };

const at = catalog.apps.findIndex(a => a.id === manifest.id);
const kept = at === -1 ? [] : catalog.apps[at].versions.filter(v => v.version !== version);
const app = {
  id: manifest.id as string,
  name: manifest.name as string,
  description: manifest.description ?? '',
  author: 'jstgnkl',
  icon: ICON,
  homepage: REPO,
  source: REPO,
  // newest-first, as the docs ask sources to emit them
  versions: [entry, ...kept].sort((a, b) => Date.parse(b.released_at) - Date.parse(a.released_at)),
};
if (at === -1) catalog.apps.push(app);
else catalog.apps[at] = app;
catalog.updated_at = released_at;

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`docs/${zipName}  ${Object.keys(files).length} files, ${zip.length} bytes`);
console.log(`docs/catalog.v1.json  ${manifest.name} ${version}`);
console.log('commit and push, then the source url is:');
console.log(`  ${RAW}/docs/catalog.v1.json`);
