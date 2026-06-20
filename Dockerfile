# `orchestrator` container: the Node infrastructure (webhook, gate, working copy,
# E2E execution, reporting). The agentic generation runs in the separate
# `agents` container (see docker-compose.yml + agents/Dockerfile).
#
# Base = the official Playwright image (Node + browsers preinstalled): this is
# where the agent-generated E2E tests RUN, against DEV.
# NOTE: The PW v1.60.0-noble image ships Node 20; we replace it with Node 24 below
# so undici >=8.4.1 and better-sqlite3 12.10.1 (ABI v137 prebuilt) are both satisfied.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# --- Explicit Node 24 layer -----------------------------------------------
# The Playwright image ships Node 20, which is below undici 8.4.1's engine floor
# and below better-sqlite3 12.10.1's prebuilt ABI (v137 = Node 24). Install Node 24
# via NodeSource so the orchestrator process and npm ci both use it.
# better-sqlite3 12.10.1 ships a linux-x64 prebuilt for ABI v137 (Node 24) — no
# source compile needed on amd64. On arm64 (Apple-silicon dev, Graviton CI) there is
# no matching prebuilt, so npm install COMPILES it from source — build-essential and
# python3 are installed below (the same toolchain code-mode needs), so the build succeeds.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# git: to clone/check out the working copies of the watched repos.
# Code-mode runtimes: the orchestrator runs the watched repo's own test suite
# (Python/pytest, Go, Rust/Cargo, Maven, Gradle) for code-mode apps. These run
# in the orchestrator process, NOT in the agents container — see code-runner.ts.
# noble (Ubuntu 24.04) package-name audit: python3/python3-pip/python3-venv/cargo/rustc/
# maven/gradle/build-essential are all present in noble under the same names.
# Go is NOT installed from apt (the noble `golang` package is 1.22 and would lag); we
# install the upstream tarball below.
# JDK (NOT just a JRE): the `maven`/`gradle` packages only pull a headless JRE, which has `java`
# but NOT `javac`. `mvn test-compile`/`mvn test` then fail with "No compiler is provided in this
# environment. Perhaps you are running on a JRE rather than a JDK?" — turning EVERY Java code-mode
# run into an inconclusive infra-error. `default-jdk-headless` puts `javac` on PATH (via
# update-alternatives) and `java-common` provides the arch-independent /usr/lib/jvm/default-java.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    default-jdk-headless \
    python3 python3-pip python3-venv \
    cargo rustc \
    maven \
    gradle \
  && rm -rf /var/lib/apt/lists/*
# Maven/Gradle and many JVM tools consult JAVA_HOME; point it at the arch-independent symlink
# java-common installs, so the same line works on amd64 and arm64.
ENV JAVA_HOME=/usr/lib/jvm/default-java

# --- Go upstream tarball install ------------------------------------------
# apt-get install golang on noble gives Go 1.22 (lagging); use the upstream tarball
# for a current release. go1.26.4 is the pinned target (latest 1.26.x stable, verified
# present on go.dev/dl). Update the version variable to bump Go.
# Arch-aware: derive the Debian arch (amd64/arm64) so the image builds on both x86_64 and
# arm64 hosts (Apple-silicon dev machines, Graviton CI) instead of hardcoding linux-amd64.
ENV GO_VERSION=1.26.4
RUN GOARCH="$(dpkg --print-architecture)" \
  && case "$GOARCH" in \
       amd64|arm64) : ;; \
       *) echo "unsupported arch for Go tarball: $GOARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://dl.google.com/go/go${GO_VERSION}.linux-${GOARCH}.tar.gz" \
  | tar -C /usr/local -xz \
  && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
  && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# Unprivileged user for executing UNTRUSTED code-mode commands (the watched repo's own
# install/test/coverage). The orchestrator runs as root and DROPS to this user for those spawns
# (src/qa/code-runner.ts → resolveSandbox), so untrusted code cannot read the root-owned API token
# (config/.api_token, 0600), tamper with the orchestrator's files (/app/src, node_modules), or write
# sibling repos under /app/.mirrors. The user owns a writable home for toolchain caches (~/.m2,
# ~/.gradle, ~/.cache, ~/.cargo). NOBLE drift: Ubuntu 24.04 ships a default `ubuntu` user at uid 1000,
# which pushed the Playwright image's `pwuser` to uid 1001 (it was 1000 on jammy). So `sandbox` uses
# uid 1002 (the next free id) — docker-compose sets CODE_SANDBOX_UID=1002 so code-runner.ts matches.
RUN useradd --create-home --uid 1002 --shell /usr/sbin/nologin sandbox

WORKDIR /app

COPY package.json package-lock.json* ./
# Install ALL deps (not --omit=dev): the service runs TypeScript directly via
# `tsx` at runtime (no build step), and tsx is a devDependency.
RUN npm install

COPY . .

# The e2e tooling (Playwright runner + eslint + tsc) is NOT installed here: it
# lives in each repo's `e2e/`, and the orchestrator runs `npm ci` there per run
# (qa/setup.ts). The image already ships the Playwright browsers.

# Service entry point: webhook + sequential queue.
CMD ["npm", "run", "start"]
