// Usage: pnpm release [patch|minor|major|<version>]
// Bumps package.json, commits and tags vX.Y.Z, then pushes; the tag triggers
// .github/workflows/release.yml (deploy to GitHub Pages + GitHub Release).
import { execSync } from 'node:child_process';

const bump = process.argv[2] ?? 'patch';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch !== 'master') {
  console.error(`Releases are cut from master (you are on ${branch}).`);
  process.exit(1);
}
if (out('git status --porcelain')) {
  console.error('Working tree is not clean; commit or stash first.');
  process.exit(1);
}

run('git pull --ff-only');
run('pnpm check');
run(`npm version ${bump} -m "chore(release): v%s"`);
run('git push origin HEAD --follow-tags');
console.log(
  `Pushed v${out('node -p "require(\'./package.json\').version"')}; the Release workflow takes it from here.`,
);
