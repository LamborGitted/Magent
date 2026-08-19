# Releasing Magent

Magent is published to npm as [`@lantxx/magent`](https://www.npmjs.com/package/@lantxx/magent).
The installed executable is still named `magent`.

## Before every release

1. Ensure the working tree is clean and CI passes on `main`.
2. Update `package.json` to the intended semantic version.
3. Update release notes when applicable.
4. Verify the package locally:

   ```bash
   corepack pnpm install --frozen-lockfile
   corepack pnpm check
   npm publish --dry-run --access public
   ```

5. Commit and push the version change.
6. Create and push the matching tag:

   ```bash
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

`.github/workflows/release.yml` verifies that the tag matches `package.json`, runs all checks,
and publishes with npm provenance.

## Bootstrap the first release

A trusted publisher is normally configured from an existing npm package's settings. For the first
release, publish once from a trusted local machine using the logged-in `lantxx` npm account:

```bash
npm whoami
corepack pnpm check
npm publish --access public
```

Then configure the package's npm **Trusted Publisher** with:

- Provider: GitHub Actions
- Organization or user: `LamborGitted`
- Repository: `Magent`
- Workflow filename: `release.yml`
- Environment: `npm`

Afterwards, push the matching version tag. The release workflow detects that the bootstrap version
already exists and skips republishing it. Future tags publish through GitHub OIDC without an
`NPM_TOKEN`.

## GitHub repository settings

Create a GitHub environment named `npm`. Optionally require approval for deployments to this
environment. Protect `main` and require all CI matrix jobs before merging.
