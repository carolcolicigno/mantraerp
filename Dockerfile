FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci --omit=dev
ENV PORT=3000 DB_PATH=/data/mantra.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
