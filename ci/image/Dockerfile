# A CI job image with Chromium and its Linux libraries already in it, for the
# UI guards (boot order, role matrix, first open, wiring).
#
# Without them each UI run's compose job installs them itself (apt-get update
# plus ~70 MB of packages): about 2 minutes and 120 MB. The workflow probes with
# a headless launch and skips that when Chromium already starts, so ANY runner
# with the libraries benefits — this image is one way to get there:
#
#   act-based runners (Gitea, nektos/act and similar): build on the image the
#     runner already uses (the default below) and map its `ubuntu-latest` label
#     to this image in the runner's config.
#   Self-hosted GitHub runners: no image needed — run
#     `npx playwright install-deps chromium` on the host once.
#   GitHub-hosted runners: nothing to do; they install as before.
#
# Build with scripts/build-ci-image.sh (reads the Playwright version from ui/).
ARG BASE=catthehacker/ubuntu:act-22.04
FROM ${BASE}

ARG PLAYWRIGHT_VERSION
# The browser too, at a fixed shared path, so a job finds it without a cache
# restore or a download. Readable by any user: jobs may run unprivileged.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN test -n "$PLAYWRIGHT_VERSION" \
 && npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
 && npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm
