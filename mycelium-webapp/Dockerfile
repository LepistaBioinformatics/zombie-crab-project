# ==============================================================================
# mycelium-webapp -- built via a fresh git fetch, same posture as
# ../mycelium/Dockerfile.standalone: no local mycelium-webapp checkout is
# copied into the build context, the whole image is reproducible from the
# git ref alone.
#
# Unlike the gateway, this is a Vite/React SPA: `VITE_MYCELIUM_API_URL` is
# baked in at build time, so it must be set to wherever *the browser* can
# reach mycelium-gateway (its published host port), not the internal Docker
# DNS name -- see docker-compose.yaml's build args for this service.
#
# Pin with --build-arg MYCELIUM_WEBAPP_GIT_REF=<commit-sha> to move to a
# newer revision; the default below is the commit this stack was validated
# against.
# ==============================================================================

ARG MYCELIUM_WEBAPP_GIT_URL=https://github.com/LepistaBioinformatics/mycelium-webapp.git
ARG MYCELIUM_WEBAPP_GIT_REF=776336db80a62f0ae0430a89db5d06f7a19f0156

# ? ----------------------------------------------------------------------------
# ? Build stage
# ? ----------------------------------------------------------------------------
FROM node:22-alpine AS builder

ARG MYCELIUM_WEBAPP_GIT_URL
ARG MYCELIUM_WEBAPP_GIT_REF

RUN apk add --no-cache git

RUN git init /app \
    && cd /app \
    && git remote add origin "${MYCELIUM_WEBAPP_GIT_URL}" \
    && git fetch --depth 1 origin "${MYCELIUM_WEBAPP_GIT_REF}" \
    && git checkout FETCH_HEAD

WORKDIR /app

RUN corepack enable && yarn install --frozen-lockfile

ARG VITE_MYCELIUM_API_URL=http://localhost:8080
ENV VITE_MYCELIUM_API_URL=${VITE_MYCELIUM_API_URL}

RUN yarn build

# ? ----------------------------------------------------------------------------
# ? Runtime stage
# ? ----------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runner

RUN rm -rf /usr/share/nginx/html/*

COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
