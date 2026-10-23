# Apify Node.js 22 base image
FROM apify/actor-node:22

# Copy package files first for Docker layer caching
COPY --chown=myuser:myuser package*.json ./

# Install production dependencies only
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && rm -r ~/.npm

# Copy the source code
COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
