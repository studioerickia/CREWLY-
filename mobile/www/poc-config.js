// ── FLAG DE ATIVAÇÃO DA POC ────────────────────────────────────────────────
// Fonte única de verdade, compartilhada entre mobile/www/index.html (decide
// se mostra o botão DEV) e mobile/www/azul-login-poc.html (decide se a
// funcionalidade roda). Existe só nesta pasta isolada — nunca é carregado
// pelo index.html principal da Vercel.
//
// Uso exclusivamente local/dev. Nunca deve ser true em qualquer build
// distribuído a usuários reais.
const POC_ATIVA = true;
