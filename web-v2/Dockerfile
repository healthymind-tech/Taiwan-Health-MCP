# Admin console v2: Vite build → static files served by nginx.
# nginx also proxies the backend surface (BACKEND_UPSTREAM, e.g. app:8000), so
# this container can act as a self-contained front door.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
ENV BACKEND_UPSTREAM=app:8000
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html/admin
EXPOSE 80
