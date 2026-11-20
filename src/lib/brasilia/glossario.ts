/**
 * Glossário do "O que Brasília decidiu": termos do processo legislativo e do STF com explicação
 * curada (escrita e conferida aqui, não pela IA). O curado sempre vence o texto da IA para o mesmo
 * termo; a IA só completa com termos de assunto (ex.: "honorários advocatícios") que aparecem no texto.
 *
 * Módulo puro, sem import: usado pelo robô (Node lê o .ts direto) e pela tela.
 */
import type { Etapa, TermoGlossario, TextoDidatico } from "./tipos.ts";

export type Verbete = {
  termo: string;
  /** Formas que aparecem no texto. Em minúsculas, comparadas sem diferenciar maiúsculas. */
  formas: string[];
  /** Siglas: comparadas respeitando maiúsculas, para "PL" não casar com "pl". */
  siglas?: string[];
  explicacao: string;
};

export const GLOSSARIO_CURADO: Verbete[] = [
  // ---- Tipos de proposta ----
  { termo: "Projeto de lei", formas: ["projeto de lei ordinária", "projeto de lei", "projetos de lei"], siglas: ["PL"], explicacao: "Proposta de lei comum (ordinária). É aprovada pela maioria dos votos, desde que a maioria dos membros da Casa esteja presente." },
  { termo: "Projeto de lei complementar", formas: ["projeto de lei complementar"], siglas: ["PLP"], explicacao: "Proposta de lei complementar, o tipo de lei que a Constituição exige para certos temas, como finanças públicas e impostos. Precisa do voto de mais da metade de todos os membros da Casa: 257 deputados ou 41 senadores." },
  { termo: "Lei complementar", formas: ["lei complementar", "leis complementares"], explicacao: "Tipo de lei que a Constituição exige para certos temas, como finanças públicas e impostos. Só é aprovada com o voto de mais da metade de todos os membros de cada Casa." },
  { termo: "Proposta de emenda à Constituição", formas: ["proposta de emenda à constituição", "propostas de emenda à constituição"], siglas: ["PEC"], explicacao: "Proposta que muda o texto da Constituição. Precisa de três quintos dos votos, em dois turnos, na Câmara (308 deputados) e no Senado (49 senadores). Não vai à sanção: é promulgada pelo próprio Congresso." },
  { termo: "Emenda constitucional", formas: ["emenda constitucional", "emendas constitucionais"], siglas: ["EC"], explicacao: "Mudança no texto da Constituição, já aprovada pelo Congresso e promulgada." },
  { termo: "Medida provisória", formas: ["medida provisória", "medidas provisórias"], siglas: ["MPV", "MP"], explicacao: "Norma com força de lei editada pelo presidente da República. Vale desde a publicação, mas perde a validade se o Congresso não a aprovar em até 120 dias." },
  { termo: "Projeto de lei de conversão", formas: ["projeto de lei de conversão"], siglas: ["PLV"], explicacao: "O texto de uma medida provisória com as mudanças feitas pelo Congresso. Se aprovado, segue para sanção no lugar da medida original." },
  { termo: "Projeto de decreto legislativo", formas: ["projeto de decreto legislativo", "decreto legislativo"], siglas: ["PDL"], explicacao: "Trata de assuntos que só o Congresso decide, como aprovar tratados internacionais ou sustar atos do governo. Não passa pela sanção do presidente." },
  { termo: "Projeto de resolução", formas: ["projeto de resolução"], siglas: ["PRC", "PRS"], explicacao: "Regula assuntos internos da própria Casa, como regras de funcionamento, cargos e homenagens. Não passa pela sanção do presidente." },
  { termo: "Requerimento", formas: ["requerimento", "requerimentos"], siglas: ["REQ", "RQS"], explicacao: "Pedido formal de parlamentares, líderes ou comissões, por exemplo para acelerar, adiar ou juntar projetos. Sozinho, não muda nenhuma lei." },

  // ---- Etapas da votação ----
  { termo: "Plenário", formas: ["plenário", "plenários"], explicacao: "Reunião de todos os deputados, ou de todos os senadores. É onde acontecem as votações finais de cada Casa." },
  { termo: "Redação final", formas: ["redação final"], explicacao: "Texto definitivo, já com todas as mudanças aprovadas. Votar a redação final só confere a forma do texto; o conteúdo já foi decidido antes." },
  { termo: "Substitutivo", formas: ["substitutivo", "substitutivos", "emenda substitutiva"], explicacao: "Nova versão completa do projeto, escrita pelo relator, que toma o lugar do texto original." },
  { termo: "Destaque", formas: ["destaque", "destaques", "destacado", "destacada", "destacados", "destacadas"], explicacao: "Pedido para votar em separado um trecho do texto ou uma emenda. Primeiro se vota o texto principal; depois, cada destaque." },
  { termo: "Emenda", formas: ["emenda", "emendas", "subemenda", "subemendas"], explicacao: "Proposta de mudança em um trecho do texto que está sendo analisado." },
  { termo: "Turno suplementar", formas: ["turno suplementar"], explicacao: "Nova rodada de votação, feita quando o Plenário aprova um substitutivo, para votar as emendas apresentadas a esse novo texto." },
  { termo: "Turno único", formas: ["turno único"], explicacao: "Quando a proposta é votada uma única vez no Plenário daquela Casa." },
  { termo: "Regime de urgência", formas: ["regime de urgência", "urgência"], explicacao: "Regime que acelera a tramitação: o projeto dispensa prazos e etapas e pode ser votado direto no Plenário." },
  { termo: "Tramitação conjunta", formas: ["tramitação conjunta", "tramitar em conjunto", "apensado", "apensados", "apensada"], explicacao: "Quando projetos sobre o mesmo assunto passam a ser analisados juntos, como se fossem um só." },
  { termo: "Prejudicada", formas: ["prejudicada", "prejudicadas", "prejudicado", "prejudicados"], explicacao: "Proposta que deixa de ser votada porque perdeu o sentido, por exemplo quando outro texto sobre o mesmo ponto já foi aprovado." },
  { termo: "Relator", formas: ["relator", "relatora", "relatores"], explicacao: "Parlamentar (ou ministro, no STF) encarregado de analisar o caso e propor como decidir." },
  { termo: "Parecer", formas: ["parecer", "pareceres"], explicacao: "Opinião formal do relator ou de uma comissão sobre a proposta, que orienta a votação." },
  { termo: "Comissão mista", formas: ["comissão mista"], explicacao: "Comissão formada por deputados e senadores. Entre outras tarefas, analisa as medidas provisórias antes do Plenário." },
  { termo: "Pressupostos constitucionais", formas: ["pressupostos constitucionais"], explicacao: "Os dois requisitos que a Constituição exige de uma medida provisória: relevância e urgência. Sem eles, a medida nem é analisada." },
  { termo: "Quórum", formas: ["quórum", "quorum"], explicacao: "Número mínimo de parlamentares presentes, ou de votos, para uma votação valer." },
  { termo: "Votação simbólica", formas: ["votação simbólica", "votações simbólicas"], explicacao: "Votação sem registro individual: o presidente pede que quem concorda permaneça como está e anuncia o resultado. Não se sabe como cada parlamentar votou." },
  { termo: "Votação nominal", formas: ["votação nominal", "votações nominais"], explicacao: "Cada parlamentar vota no painel eletrônico, e o voto de cada um fica registrado e público." },
  { termo: "Sanção", formas: ["sanção", "sancionar", "sancionado", "sancionada"], explicacao: "Aprovação do projeto pelo presidente da República, que o transforma em lei. O presidente tem 15 dias úteis para sancionar ou vetar." },
  { termo: "Veto", formas: ["veto", "vetos", "vetado", "vetada"], explicacao: "Recusa do presidente da República a um projeto aprovado, no todo ou em parte. O Congresso pode derrubar o veto com o voto de 257 deputados e 41 senadores." },
  { termo: "Promulgação", formas: ["promulgação", "promulgada", "promulgado"], explicacao: "Ato que declara a lei ou a emenda constitucional pronta e oficial, antes da publicação." },

  // ---- Contas públicas ----
  { termo: "Crédito extraordinário", formas: ["crédito extraordinário", "créditos extraordinários"], explicacao: "Autorização de gasto fora do Orçamento aprovado, permitida só para despesas urgentes e imprevisíveis, como calamidades. É aberto por medida provisória." },
  { termo: "Benefício fiscal", formas: ["benefício fiscal", "benefícios fiscais", "incentivo fiscal", "incentivos fiscais", "benefício tributário", "benefícios tributários"], explicacao: "Redução ou isenção de imposto dada a um setor, região ou atividade. Na prática, é dinheiro que o governo deixa de arrecadar." },
  { termo: "Arcabouço fiscal", formas: ["arcabouço fiscal", "regime fiscal sustentável"], explicacao: "Conjunto de regras criado pela Lei Complementar 200, de 2023, que limita o crescimento dos gastos do governo federal e fixa metas para as contas públicas." },
  { termo: "Meta fiscal", formas: ["meta fiscal", "metas fiscais"], explicacao: "Resultado que o governo se compromete a entregar nas contas do ano (economia ou limite de déficit), sem contar os juros da dívida." },
  { termo: "Resultado primário", formas: ["resultado primário", "superávit primário", "déficit primário"], explicacao: "Diferença entre o que o governo arrecada e o que gasta, sem contar os juros da dívida. Positivo é superávit; negativo, déficit." },

  // ---- STF ----
  { termo: "Ação direta de inconstitucionalidade", formas: ["ação direta de inconstitucionalidade"], siglas: ["ADI"], explicacao: "Ação que pede ao STF para declarar que uma lei ou norma contraria a Constituição." },
  { termo: "Ação declaratória de constitucionalidade", formas: ["ação declaratória de constitucionalidade"], siglas: ["ADC"], explicacao: "Ação que pede ao STF para confirmar que uma lei está de acordo com a Constituição." },
  { termo: "Arguição de descumprimento de preceito fundamental", formas: ["arguição de descumprimento de preceito fundamental"], siglas: ["ADPF"], explicacao: "Ação que pede ao STF que corrija um ato do poder público que fere princípios básicos da Constituição." },
  { termo: "Repercussão geral", formas: ["repercussão geral"], explicacao: "Quando o STF decide que um caso importa além das partes, a tese aprovada passa a valer para todos os processos iguais no país." },
  { termo: "Plenário virtual", formas: ["plenário virtual"], explicacao: "Sessão em que os ministros do STF votam por um sistema eletrônico, ao longo de alguns dias, sem reunião presencial." },
  { termo: "Pedido de vista", formas: ["pedido de vista", "pediu vista"], explicacao: "Pedido de um ministro para ter mais tempo de analisar o caso; o julgamento fica suspenso até ele devolver o processo." },
  { termo: "Inconstitucional", formas: ["inconstitucional", "inconstitucionais", "inconstitucionalidade"], explicacao: "Contrário à Constituição. Uma norma declarada inconstitucional pelo STF deixa de valer." },
  { termo: "Liminar", formas: ["liminar", "liminares", "medida cautelar", "cautelar"], explicacao: "Decisão provisória e urgente, tomada antes do julgamento final, para evitar um dano." },
  { termo: "Modulação dos efeitos", formas: ["modulação dos efeitos", "modulação de efeitos"], explicacao: "Quando o STF define a partir de quando a sua decisão passa a valer, para não desfazer situações já consolidadas." },
  { termo: "Tese", formas: ["tese de repercussão geral", "tese"], explicacao: "Frase que resume o entendimento do STF e orienta as decisões de todos os juízes em casos iguais." },
  { termo: "Trânsito em julgado", formas: ["trânsito em julgado", "transitou em julgado"], explicacao: "Quando não cabe mais recurso e a decisão se torna definitiva." },
];

/* ---------------- busca de termos no texto ---------------- */

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BORDA_ANTES = "(?<![\\p{L}\\p{N}])";
const BORDA_DEPOIS = "(?![\\p{L}\\p{N}])";
const normal = (s: string) => s.normalize("NFC").trim().toLocaleLowerCase("pt-BR");

/** Verbete curado cujo termo, forma ou sigla é igual ao termo dado (sem diferenciar maiúsculas). */
export function verbeteCurado(termo: string): Verbete | null {
  const t = normal(termo);
  return GLOSSARIO_CURADO.find((v) => normal(v.termo) === t || v.formas.includes(t) || (v.siglas ?? []).some((s) => normal(s) === t)) ?? null;
}

type Achado = { inicio: number; fim: number; termo: string };

/** Todas as ocorrências de um termo (curado: todas as formas e siglas; da IA: o próprio termo). */
function ocorrencias(texto: string, termo: string): Achado[] {
  const v = verbeteCurado(termo);
  const formas = v ? v.formas : [normal(termo)];
  const siglas = v?.siglas ?? [];
  const achados: Achado[] = [];
  const procurar = (padrao: string, flags: string) => {
    const re = new RegExp(`${BORDA_ANTES}(?:${padrao})${BORDA_DEPOIS}`, flags);
    for (const m of texto.matchAll(re)) achados.push({ inicio: m.index, fim: m.index + m[0].length, termo: v?.termo ?? termo });
  };
  const ordenadas = [...formas].sort((a, b) => b.length - a.length).map(escapar);
  if (ordenadas.length) procurar(ordenadas.join("|"), "giu");
  if (siglas.length) procurar(siglas.map(escapar).join("|"), "gu");
  return achados;
}

/**
 * Glossário final de um bloco: o curado vence a IA no mesmo termo; a IA completa com termos que não
 * estão no curado; só entra termo que aparece de fato nos textos (senão não há onde pôr o "?").
 * Ordem: a da primeira aparição no texto.
 */
export function escolherGlossario(daIA: { termo: string; explicacao: string }[], textos: string[]): TermoGlossario[] {
  const candidatos = new Map<string, TermoGlossario>();
  for (const v of GLOSSARIO_CURADO) candidatos.set(normal(v.termo), { termo: v.termo, explicacao: v.explicacao, fonte: "curado" });
  for (const t of daIA) {
    const termo = typeof t?.termo === "string" ? t.termo.trim() : "", explicacao = typeof t?.explicacao === "string" ? t.explicacao.trim() : "";
    if (!termo || !explicacao || termo.length > 60 || explicacao.length > 400) continue;
    if (verbeteCurado(termo) || candidatos.has(normal(termo))) continue; // o curado vence
    candidatos.set(normal(termo), { termo, explicacao, fonte: "ia" });
  }
  // Fica só o que a tela vai de fato marcar, na mesma ordem em que ela percorre os textos.
  const lista = [...candidatos.values()];
  const marcados = new Set<string>();
  const ordem: TermoGlossario[] = [];
  for (const t of textos) for (const tr of marcarTermos(t, lista, marcados)) if (tr.termo) ordem.push(tr.termo);
  return ordem;
}

export type Trecho = { texto: string; termo?: TermoGlossario };

/**
 * Parte o texto em trechos, marcando a primeira ocorrência de cada termo do glossário que ainda não
 * foi marcado no bloco. `jaMarcados` é atualizado (o bloco marca cada termo uma vez só).
 */
export function marcarTermos(texto: string, glossario: TermoGlossario[], jaMarcados: Set<string> = new Set()): Trecho[] {
  const achados: (Achado & { item: TermoGlossario })[] = [];
  for (const item of glossario) {
    if (jaMarcados.has(normal(item.termo))) continue;
    for (const a of ocorrencias(texto, item.termo)) achados.push({ ...a, item });
  }
  // Sem sobreposição: na mesma posição, o trecho mais longo ganha; cada termo só na primeira vez livre.
  achados.sort((a, b) => a.inicio - b.inicio || b.fim - b.inicio - (a.fim - a.inicio));
  const trechos: Trecho[] = [];
  let cursor = 0;
  for (const a of achados) {
    if (a.inicio < cursor || jaMarcados.has(normal(a.item.termo))) continue;
    if (a.inicio > cursor) trechos.push({ texto: texto.slice(cursor, a.inicio) });
    trechos.push({ texto: texto.slice(a.inicio, a.fim), termo: a.item });
    jaMarcados.add(normal(a.item.termo));
    cursor = a.fim;
  }
  if (cursor < texto.length) trechos.push({ texto: texto.slice(cursor) });
  return trechos;
}

/** Marca uma sequência de textos de um mesmo bloco (cada termo é marcado uma vez, no primeiro texto em que aparece). */
export function marcarBloco(textos: string[], glossario: TermoGlossario[]): Trecho[][] {
  const marcados = new Set<string>();
  return textos.map((t) => marcarTermos(t, glossario, marcados));
}

/** Os textos de uma pauta na ordem em que a tela os mostra (o título não leva "?"). */
export function textosDaPauta(texto: TextoDidatico | null, p: { resultadoTexto: string; etapas: Etapa[] }): string[] {
  return [...(texto ? [texto.abertura, texto.detalhes] : []), p.resultadoTexto, ...p.etapas.map((e) => e.descricao)];
}
