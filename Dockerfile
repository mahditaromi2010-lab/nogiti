FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Reproducible install from the lockfile; dev tooling is not shipped.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
RUN mkdir -p uploads/covers uploads/private && chown -R node:node /app/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are versioned, transactional and serialised by an advisory lock, so running them on start is safe.
CMD ["sh", "-c", "node scripts/migrate.js && exec node src/server.js"]
