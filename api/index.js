// Função da Vercel: todas as rotas /api/* passam pelo mesmo handler do servidor.
module.exports = require("../server/server").handler;
