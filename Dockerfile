FROM node:18
WORKDIR /home
# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 3000

RUN npm run build

CMD node --enable-source-maps --experimental-specifier-resolution=node --no-warnings --loader ts-node/esm ./dist/server.js