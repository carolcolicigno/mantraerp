// Troca nomes de marcas reais dos dados de exemplo por nomes genéricos (aplicado uma vez em bancos já criados).
const TROCAS = [
  ["Natal Natura", "Projeto Exemplo Natal"], ["Vivo 5G verão", "Projeto Exemplo Lançamento"],
  ["Campanha Verão", "Projeto Exemplo Campanha"], ["campanha Verão", "Projeto Exemplo Campanha"], ["filme Verão", "filme Projeto Exemplo Campanha"],
  ["CreativeSync Hub", "Projeto Exemplo WebApp"], ["Performance Q4", "Projeto Exemplo Conteúdo"], ["Cartão Ultravioleta", "Projeto Exemplo Lançamento B"],
  ["Licenças Creative Cloud", "Licenças de software"], ["Creative Cloud", "software"],
  ["Studio Lumen (produtora)", "Produtora Exemplo"], ["Studio Lumen", "Produtora Exemplo"], ["lumen.tv", "produtora-exemplo.com.br"],
  ["Meta Ads", "Veículo Exemplo (mídia digital)"], ["ads@meta.com", "midia@veiculo-exemplo.com.br"],
  ["br@adobe.com", "contato@software-exemplo.com.br"], ["Adobe", "Software Exemplo"],
  ["marketing@natura.com", "marketing@cliente-a.com.br"], ["brand@vivo.com.br", "marca@cliente-b.com.br"], ["juridico@vivo.com.br", "juridico@cliente-b.com.br"],
  ["mkt@havaianas.com", "mkt@cliente-c.com.br"], ["brand@nubank.com.br", "marca@cliente-d.com.br"],
  ["exemplo-natura", "exemplo-cliente-a"],
  ["Banco Aurora", "Prospect Exemplo 1"], ["Lumi Cosméticos", "Prospect Exemplo 2"], ["Viva Saúde", "Prospect Exemplo 3"],
  ["Natura", "Cliente Exemplo A"], ["Vivo", "Cliente Exemplo B"], ["Havaianas", "Cliente Exemplo C"], ["Nubank", "Cliente Exemplo D"],
  ["71.673.990/0001-77", "11.111.111/0001-91"], ["02.558.157/0001-62", "22.222.222/0001-91"], ["61.079.117/0001-05", "33.333.333/0001-91"],
  ["18.236.120/0001-58", "44.444.444/0001-91"], ["11.222.333/0001-81", "55.555.555/0001-91"], ["13.347.016/0001-17", "66.666.666/0001-91"],
  ["02.343.442/0001-66", "77.777.777/0001-91"], ["45.723.174/0001-10", "88.888.888/0001-91"],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const RE = TROCAS.map(([de, para]) => [new RegExp(`(?<![\\wÀ-ú])${esc(de)}(?![\\wÀ-ú])`, "g"), para]);
const trocar = (txt) => RE.reduce((t, [re, para]) => t.replace(re, para), txt);
module.exports = { trocar };
