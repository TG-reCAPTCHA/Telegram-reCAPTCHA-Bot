FROM node:10-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock index.js ./
RUN yarn install && yarn cache clean

CMD ["node", "index.js"]