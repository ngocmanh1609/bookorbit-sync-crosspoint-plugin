---
name: release
description: Release a new cp-orbit version end to end. Bump the version in all three places, write the release notes, test, push main, tag v<version>, let the release workflow publish the zip, then verify the GitHub Release and the Plugin Hub listing. Use this whenever the user wants to release, publish, ship, cut or tag a version, bump the version, make a new zip, or get a change to Plugin Hub users, even if they only say "push a new version" or "make 0.2.0".
---

# Release cp-orbit

A release is what Plugin Hub and the Releases page install. Plugin Hub reads the **immutable tag**, not `main`, so a
runtime change only reaches users through a new version and a new tag.

## 1. Decide the version

- Use semver. A patch for fixes, a minor for features.
- Ask only when it's ambiguous.
- List what changed since the last tag:

```bash
git describe --tags --abbrev=0
```

```bash
git log --oneline <last-tag>..HEAD
```

- If the plugin payload (`cp-orbit.crosspoint-plugin/`) didn't change, a release isn't needed. README or test changes
  ship without one.

## 2. Bump and write notes

```bash
node .claude/skills/release/scripts/bump-version.mjs <new-version>
```

The script updates the version in all three places the tests check:
- `manifest.json` `version`
- `device.json` `pluginVersion` `cp-orbit/<v>`, which must stay at 20 characters or less
- `plugin.js` `VERSION`

It also creates `docs/release-notes/<v>.md` from the template if that file is missing.

Then fill in the notes. Keep them user-facing: what changed, any action needed (for example "press Save again"), and
the install/update steps. Keep the "Verified on the BOOX Picco only" note while that's still true.

## 3. Verify locally

```bash
npm test
```

```bash
sh scripts/package.sh v<new-version>
```

```bash
unzip -l dist/cp-orbit-<new-version>.zip
```

The zip must contain only `cp-orbit/<the files listed in manifest.json>`.

## 4. Commit, push, wait for CI, then tag

Pushing and tagging are public, so confirm with the user first unless they already asked for the release. Commit the
bump and notes, push `main`, and wait for the `tests` workflow to pass before tagging:

```bash
gh run watch "$(gh run list --branch main --workflow tests.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Then tag and push the tag. That triggers `.github/workflows/release.yml`, which tests, checks the tag against the
manifest, builds the zip and publishes the release with the notes file:

```bash
git tag -a v<new-version> -m "cp-orbit <new-version>"
```

```bash
git push origin v<new-version>
```

**GitHub auth in this environment.** The `gh` login is `manh-t`: it can push but has no admin rights. The user's
terminal may export a `GITHUB_TOKEN` that overrides `gh`. If plain `git push` asks for a username, push through gh's
credential helper without changing any config:

```bash
env -u GITHUB_TOKEN -u GH_TOKEN git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main
```

GitHub refuses a push that adds or changes `.github/workflows/*` unless the token has the `workflow` scope. If that
happens, ask the user to run this, approve it in the browser, and tell you when it's done:

```bash
env -u GITHUB_TOKEN gh auth refresh -h github.com -s workflow
```

## 5. Verify the release

```bash
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

```bash
gh release view v<new-version> --json isDraft,isPrerelease,assets,url
```

Download the zip into a temporary folder and check it with `unzip -l`. Plugin Hub needs a release that is neither a
draft nor a pre-release, whose tag matches the manifest version.

## 6. Plugin Hub

- **Listing:** Plugin Hub lists the repo automatically when it has the topic `crosspoint-plugin`, exactly one
  `cp-orbit.crosspoint-plugin/` folder, and a release matching the version.
- **Refresh:** the catalog refreshes every 3 hours. New versions show as **Update** on readers that have it installed.
- **Topic:** check that it's set:

```bash
gh repo view ngocmanh1609/bookorbit-sync-crosspoint-plugin --json repositoryTopics
```

  Adding a topic needs owner rights. If it's missing, ask the owner (`ngocmanh1609`) to add it under the repo's
  About ⚙️.
- **Duplicate IDs:** another repo claiming `cp-orbit` would get the ID quarantined. Check
  `crosspoint-reader/crosspoint-plugin-hub` `catalog.json` if the plugin doesn't appear.

## Tell the user

Give the release URL, the zip name and size, and whether the tests and release workflows passed. If anything changed
in `device.json`, say so: readers need a restart after updating. Remind them to update their own reader, using the
`deploy-to-picco` skill.
