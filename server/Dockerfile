# Cloudy all-in-one image: PostgreSQL 17 + LibreOffice (office previews) + Cloudy server in one container.
FROM node:24-trixie-slim
ARG APP_VERSION=
LABEL org.opencontainers.image.title="Cloudy" org.opencontainers.image.description="Self-hosted files, sharing, office previews, calendar and contacts"

# PostgreSQL 17 from Debian; no default cluster (the entrypoint creates its own in DB_DIR).
# The optional LLVM JIT (~145 MB) is removed; the entrypoint runs PostgreSQL with jit=off.
RUN mkdir -p /etc/postgresql-common/createcluster.d \
 && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/cloudy.conf \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      postgresql-17 tini ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* /usr/lib/postgresql/17/lib/llvmjit* /usr/lib/*-linux-gnu/libLLVM*.so* /usr/lib/*-linux-gnu/libz3.so*

# LibreOffice without GUI, for read-only office previews (documents are converted to PDF on demand).
# Carlito/Caladea/Liberation match the metrics of Microsoft's Calibri/Cambria/Arial/Times; Noto covers other scripts.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-draw-nogui \
      fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production APP_VERSION=$APP_VERSION DATA_DIR=/data DB_DIR=/var/lib/cloudy/db LC_CTYPE=C.UTF-8
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/cloudy-entrypoint
COPY docker/pg_hba.conf /etc/cloudy/pg_hba.conf
RUN chmod 755 /usr/local/bin/cloudy-entrypoint \
 && mkdir -p /data /var/lib/cloudy/db /run/cloudy && chown node:node /data /var/lib/cloudy/db /run/cloudy

VOLUME ["/data", "/var/lib/cloudy/db"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS http://127.0.0.1:8080/status >/dev/null || exit 1
# The entrypoint prepares as root, then runs tini (process 1) and everything else as PUID:PGID.
ENTRYPOINT ["cloudy-entrypoint"]
