# Release and Marketing Deploy Guide

This repository now has two separate release paths:

- Desktop app releases are handled by `.github/workflows/release.yml`.
- The marketing site in `apps/marketing` is deployed separately through Vercel.

## 1. Desktop Release CI/CD

The release workflow runs only when you push a git tag matching `v*.*.*`.

### What it does

1. Validates the tag and runs `bun run lint`, `bun run typecheck`, and `bun run test`.
2. Builds the Windows installer.
3. Publishes the GitHub Release with those artifacts.
4. Updates package versions on `main` after the release is published.

### What it does not do anymore

- It does not deploy the old hosted app.
- It does not deploy the marketing site.
- It does not publish npm packages.
- It does not send Discord announcements.

### One-time GitHub setup

No special deployment secrets are needed for the desktop release workflow beyond the existing signing and release app credentials.

Required secrets for the release workflow, if you use them:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

Optional signing secrets:

- Windows signing:
  - `AZURE_TENANT_ID`
  - `AZURE_CLIENT_ID`
  - `AZURE_CLIENT_SECRET`
  - `AZURE_TRUSTED_SIGNING_ENDPOINT`
  - `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
  - `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
  - `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

## 2. Marketing Site Vercel Setup

The marketing site lives in `apps/marketing`.

This is the part you want for the public site.

### Recommended setup

Create a separate Vercel project for the marketing site with:

- Root Directory: `apps/marketing`
- Build Command: `bun run build`
- Output Directory: `dist`

Then connect the project to the repository with Vercel Git integration.

That means:

- pushes to `main` update the marketing site automatically
- release tags do not affect the marketing site

### Suggested Vercel settings

Use the default Vercel project settings unless you need something custom.

Repository-level settings you may still want:

- disable any old hosted-app Vercel project
- ensure the marketing site project points at the correct repo and branch

### Marketing site URL behavior

The marketing site reads release assets from
[apps/marketing/src/lib/releases.ts](/D:/Aadi/W-Projects/AmazingProject/apps/marketing/src/lib/releases.ts).

It is hardcoded to `AadiJo/cadsense`, so the site will show download links for releases from that repo.

If you change the repository again later, update that file and the hardcoded GitHub release links in the marketing pages.

Relevant files:

- [apps/marketing/src/pages/index.astro](/D:/Aadi/W-Projects/AmazingProject/apps/marketing/src/pages/index.astro)
- [apps/marketing/src/pages/download.astro](/D:/Aadi/W-Projects/AmazingProject/apps/marketing/src/pages/download.astro)
- [apps/marketing/src/layouts/Layout.astro](/D:/Aadi/W-Projects/AmazingProject/apps/marketing/src/layouts/Layout.astro)

## 3. Quick Summary

- Desktop releases: tag push -> GitHub Actions -> GitHub Release.
- Marketing site: push to `main` -> Vercel Git integration -> public site update.
- The marketing site is the only online web surface you should configure now.
