---
name: release
description: Release a new version of muse-code-acp to npm through GitHub Actions, including verification, release notes, tagging, and cleanup. Use when asked to release or publish this package.
---

# Release muse-code-acp

Deliver a verified npm release of `@bex-co/muse-code-acp` directly from `main`.
Never create a release PR or require PR review. Keep npm authentication and
publishing in `.github/workflows/publish.yml`; do not run local `npm publish` or
copy credentials locally. A request to release authorizes the release commit,
push, tag, workflow dispatch, and GitHub release. A request only to edit this
skill or ship code does not authorize publication.

## Prepare and verify

1. Inspect repository instructions, Git status, remote history/tags, GitHub
   releases, and npm's current versions. Fetch `origin` and tags. Reconcile any
   existing tag, failed workflow, or published version before choosing a new
   version; a tag or GitHub release alone does not prove npm publication.
2. Work on `main`, preserve unrelated work, and pull with rebase. Use an isolated
   worktree when needed to avoid including unrelated local changes. Inspect the
   commits and diff since the last successful release. Summarize major features,
   fixes, compatibility changes, and migration steps for users; do not merely
   copy every commit subject.
3. Honor a requested version; otherwise choose a stable SemVer version based on
   the changes. Before 1.0, use a minor bump for features or breaking changes and
   a patch bump for fixes. Update `package.json`, `package-lock.json`, and
   `CHANGELOG.md` together, using `npm version <version> --no-git-tag-version`
   where appropriate. Put the user-facing release notes in the changelog.
4. Run the checks in `.github/workflows/ci.yml`: formatting, lint, build, unit
   tests, packed-install smoke, and required real Muse loopback suites. Use
   `MUSE_CODE_ACP_REQUIRE_MUSE=1` for loopback tests so missing Muse cannot silently
   pass. If the required host is unavailable locally, explicitly leave that
   verification to the required CI job. Fix failures before publication; never
   weaken checks to release. Paid-provider tests require existing authorization.

## Ship and publish

1. Review the release diff, commit only intended files with a Conventional Commit,
   pull/rebase latest `origin/main`, and push directly to `main`. Reverify if the
   final source changes. Never force-push or skip hooks.
2. Create an annotated `v<version>` tag on the release commit and push that exact
   tag. Do not move or replace an existing remote release tag. The tag must match
   `package.json` and its commit must be reachable from `origin/main`.
3. Dispatch CI using `gh workflow run publish.yml --ref main -f ref=v<version>`.
   Identify the new workflow-dispatch run by its time and event; inspect its input
   tag/resolve step if concurrent releases make identification ambiguous. Monitor
   that run through completion. CI resolves the tag to a SHA, runs the full
   reusable CI workflow on that SHA, and publishes that same SHA with GitHub's
   npm authentication. Ordinary pushes and tag creation do not publish.
4. Confirm the run's publish job succeeded and the exact version is available in
   the npm registry, with the expected `latest` dist-tag. Check package metadata
   and smoke-test the installed published version in a temporary directory.
   Use `scripts/pack-smoke.mjs` as a reference for meaningful package checks.
5. The workflow's `github-release` job creates (or, on a rerun, updates) the GitHub
   release for the tag after npm publication, using that version's `CHANGELOG.md`
   section via `scripts/release-notes.mjs`; `resolve-release` fails before
   publishing if that section is missing. Review the section before tagging, then
   confirm the release exists with the expected notes and is marked Latest.

## Failures and cleanup

- Diagnose CI failures and fix their cause. Before retrying, query npm for the
  exact version: if already published, verify it and finish missing release
  metadata instead of attempting to overwrite it. Never unpublish as cleanup.
- If a fix changes the tagged source, use a new version/tag; do not silently
  retarget a release tag. Workflow-only repairs can rerun the unchanged tag after
  verifying that the source and package version remain correct.
- Remove only temporary files, worktrees, and branches created by this release
  attempt. Preserve user work, release tags, and historical PRs. Leave no release
  PR or temporary release branch behind.
- Finish only after CI, npm availability, published-package smoke, GitHub release,
  and cleanup are verified. Report version, major changes, verification results,
  npm/release links, and final Git status. If credentials or an external service
  block completion, report the exact remaining step; do not claim release success.
