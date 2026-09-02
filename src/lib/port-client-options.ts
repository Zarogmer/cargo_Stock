// Sementes de portos/clientes conhecidos do sistema. Usadas em dois lugares:
// - Aba Navios: ComboBox do cadastro (combinadas com os navios já salvos);
// - Financeiro › filtro de navios: opções de Porto/Cliente (combinadas com
//   jobs + navios cadastrados), pra nenhum porto/cliente da operação sumir do
//   filtro só porque não tem navio na lista atual.
// Valor novo digitado num navio vira opção em todo lugar assim que salvo.
export const DEFAULT_PORTS = ["Santos", "Paranaguá", "São Francisco do Sul"];
export const DEFAULT_CLIENTS = ["Deep", "Transatlântica", "Continental", "Wilson"];
