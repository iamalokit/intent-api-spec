#!/usr/bin/env node
// Bundles this package's OpenAPI spec and installs it into the local Maven
// repository (~/.m2) as com.aurum.silver:api-spec:<version>, packaging
// "yaml". intent-backend-service pins to a specific version of this artifact
// via <api-spec.version> in its pom.xml — bump the version below (in
// package.json) and re-run this script whenever the spec changes, then bump
// the matching property in the backend's pom.xml to pick it up.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

function findMavenCommand() {
  try {
    execSync('mvn --version', { stdio: 'ignore' });
    return 'mvn';
  } catch {
    // Neither this repo nor intent-backend-service ships a Maven wrapper —
    // both pin `maven` in their own .mise.toml instead, so `mvn` is expected
    // to already be on PATH via mise.
    throw new Error(
      'No `mvn` on PATH. Run `mise install` in this repo (.mise.toml pins Java + Maven), ' +
        'or install Maven yourself.'
    );
  }
}

console.log(`Building spec bundle for version ${version}...`);
execSync('pnpm run build', { stdio: 'inherit', cwd: packageDir });

console.log(`Installing com.aurum.silver:api-spec:${version} into the local Maven repo...`);
const mvn = findMavenCommand();
execSync(
  `"${mvn}" install:install-file ` +
    '-Dfile=dist/openapi.yaml ' +
    '-DgroupId=com.aurum.silver ' +
    '-DartifactId=api-spec ' +
    `-Dversion=${version} ` +
    '-Dpackaging=yaml ' +
    '-DgeneratePom=true',
  { stdio: 'inherit', cwd: packageDir }
);

console.log(
  `\nDone. Set <api-spec.version>${version}</api-spec.version> in intent-backend-service/pom.xml to consume it.`
);
