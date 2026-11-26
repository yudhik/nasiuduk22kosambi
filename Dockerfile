# Stage 1: Build React + Vite frontend
FROM docker.io/library/node:22-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Build Rust Axum + SQLite backend for Linux
FROM docker.io/library/rust:1-bookworm AS backend-builder
WORKDIR /app/backend

# Limit parallel rustc jobs by default so builds also succeed on 2 GB RAM hosts
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}

# Pre-build dependencies for better Docker layer caching
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir -p src migrations \
    && echo "fn main() {}" > src/main.rs \
    && echo "" > src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src

# Build actual application with embedded migrations
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN touch src/main.rs src/lib.rs \
    && cargo build --release --locked \
    && strip target/release/nota-digital-backend

# Stage 3: Minimal Linux runtime image
FROM docker.io/library/debian:bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app

COPY --from=backend-builder /app/backend/target/release/nota-digital-backend /app/nota-digital-backend
COPY --from=frontend-builder /app/frontend/dist /app/static

ENV PORT=3000 \
    DATABASE_URL=sqlite:///app/data/nota_digital.db?mode=rwc \
    STATIC_DIR=/app/static \
    TZ=Asia/Jakarta \
    RUST_LOG=nota_digital_backend=info,tower_http=info

VOLUME ["/app/data"]
EXPOSE 3000

USER appuser
CMD ["/app/nota-digital-backend"]
