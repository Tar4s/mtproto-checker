FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY check.js ./

EXPOSE 8080

CMD ["node", "check.js"]
