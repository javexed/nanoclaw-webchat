# The webchat CI job's container: the stock act image plus the Linux libraries
# Chromium needs for the UI guards (boot order, role matrix, first open, wiring).
#
# Without this, every run's `playwright install --with-deps` ran apt-get update
# and reinstalled ~70 MB of packages: about 2 minutes and 120 MB per UI run.
# The stamp tells the workflow which Playwright version these libraries are for;
# on a mismatch (a Playwright bump, or GitHub's own runners) it installs them
# itself as before, so a stale image is slower, never broken.
#
# Build with scripts/build-ci-image.sh, which reads the version from ui/.
FROM catthehacker/ubuntu:act-22.04

ARG PLAYWRIGHT_VERSION
RUN test -n "$PLAYWRIGHT_VERSION" \
 && npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
 && echo "$PLAYWRIGHT_VERSION" > /etc/nanoclaw-ci-playwright-deps \
 && rm -rf /var/lib/apt/lists/* /root/.npm
