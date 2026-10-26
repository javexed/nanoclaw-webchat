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

# jq 1.7: Ubuntu 22.04 ships 1.6, whose `jq -e` exits 0 on empty input, so a
# skill step that validates a command's JSON passes when the command printed
# nothing. Upstream's tests (and GitHub's ubuntu-latest) assume 1.7. Earlier
# on PATH than the distro's /usr/bin/jq.
ARG JQ_VERSION=1.7.1
ARG JQ_SHA256=5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5
RUN curl -fsSL -o /usr/local/bin/jq "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-amd64" \
 && echo "${JQ_SHA256}  /usr/local/bin/jq" | sha256sum -c - \
 && chmod 755 /usr/local/bin/jq \
 && /usr/local/bin/jq --version

# umask 022 for job users, as on GitHub's hosted runners: workflows create an
# unprivileged user and run tests through sudo, whose PAM session applies
# Ubuntu's user-private-group default (002). Tests that assert a written
# file's mode assume 022. Set in sudoers, not login.defs: turning off
# USERGROUPS_ENAB there also stops useradd creating the user's own group,
# which the workflows chown to.
RUN printf 'Defaults umask=0022\nDefaults umask_override\n' > /etc/sudoers.d/ci-umask \
 && chmod 440 /etc/sudoers.d/ci-umask \
 && visudo -cf /etc/sudoers.d/ci-umask
