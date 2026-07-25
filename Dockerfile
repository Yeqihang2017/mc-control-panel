FROM alpine:3.20

RUN apk add --no-cache nodejs docker-cli docker-cli-compose zip unzip

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV PANEL_HOST=0.0.0.0
ENV PANEL_PORT=8787
ENV PANEL_DATA_DIR=/data

EXPOSE 8787

CMD ["node", "server.js"]
