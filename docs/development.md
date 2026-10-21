# Development

## Releases

A push to `main` that touches `relay/`, `firmware/` or `site/` tags the next patch version and runs `.github/workflows/release.yml`. It builds the relay bundle and the firmware parts, publishes the GitHub release with `SHA256SUMS`, then deploys the site with the new firmware and `setup.sh`. Pushing a `v<x.y.z>` tag by hand does the same. To build everything without publishing, run the release workflow from the Actions tab with `dry_run` on.
