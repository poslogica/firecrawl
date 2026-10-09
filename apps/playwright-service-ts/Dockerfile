# Debian 13 (trixie) base, digest-pinned.
FROM node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright dependencies
RUN pnpm exec playwright install --with-deps --only-shell chromium

RUN pnpm run build
RUN pnpm prune --prod --ignore-scripts

# Collect Chromium's runtime: the headless shell's shared-library closure plus
# libraries it dlopens (NSS) and their own dependencies (e.g. libsoftokn3 needs
# libsqlite3; without it the browser aborts on the first TLS handshake), and
# font data, copied as whole Debian packages with
# their dpkg records so the final image inventory stays accurate. Packages the
# distroless base already provides are skipped.
FROM build AS collect
RUN set -eu; \
  HS=$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell \
             "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-*/chrome-linux/headless_shell 2>/dev/null | head -n1); \
  test -n "$HS"; \
  nsslibs=$(dpkg -L libnss3 | grep '\.so'); \
  closure=$(ldd "$HS" $nsslibs | awk '/=>/{print $3}' | xargs -r readlink -f | xargs -r dpkg -S 2>/dev/null | cut -d: -f1); \
  fonts=$(dpkg-query -W -f '${Package}\n' | grep -E '^fonts-'); \
  skip=" libc6 libgcc-s1 libstdc++6 zlib1g libzstd1 libssl3t64 gcc-14-base libgomp1 base-files ca-certificates tzdata tzdata-legacy netbase media-types "; \
  mkdir -p /out/root /out/status.d; \
  for p in $(printf '%s\n' $closure libnss3 libnspr4 fontconfig-config $fonts | sort -u); do \
    case "$skip" in *" $p "*) continue;; esac; \
    dpkg-query -s "$p" > "/out/status.d/$p"; \
    dpkg -L "$p" | while read -r f; do \
      case "$f" in /usr/share/doc/*|/usr/share/man/*|/usr/share/lintian/*|/usr/share/bug/*) continue;; esac; \
      if [ -f "$f" ] || [ -L "$f" ]; then mkdir -p "/out/root$(dirname "$f")"; cp -a "$f" "/out/root$f"; fi; \
    done; \
  done; \
  printf '%s\n' 'PRETTY_NAME="Debian GNU/Linux 13 (trixie) (distroless)"' 'NAME="Debian GNU/Linux"' 'ID=debian' 'VERSION_ID="13"' 'VERSION="13 (trixie)"' 'VERSION_CODENAME=trixie' 'HOME_URL="https://github.com/GoogleContainerTools/distroless"' > /out/os-release; \
  ls /out/status.d | tr '\n' ' '

# Runtime: distroless Node (no shell, package manager or userland tools).
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:5ef534d3db0ac0c43bee379af4ae49cfbfc0ef38a46c94c52d87c68f32f34d8a AS runtime
COPY --from=collect /out/root/ /
COPY --from=collect /out/status.d/ /var/lib/dpkg/status.d/
# Distroless's os-release omits VERSION_CODENAME and names itself "Distroless", which
# stops scanners from matching Debian advisories (a false "0 CVEs"). This is the
# accurate identification of the trixie packages the image contains.
COPY --from=collect /out/os-release /etc/os-release
COPY --from=collect /out/os-release /usr/lib/os-release
COPY --from=build --chown=65532:65532 /usr/src/app /usr/src/app
COPY --from=build /usr/local/share/playwright /usr/local/share/playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
WORKDIR /usr/src/app

ARG PORT
ENV PORT=${PORT}
EXPOSE ${PORT}

USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/api.js"]
