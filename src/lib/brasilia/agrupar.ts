/**
 * Agrupamento das votações do Plenário por proposição: várias votações (requerimento, parecer,
 * emenda, destaque, texto principal, redação final) viram UMA pauta. Requerimento de procedimento
 * (urgência, retirada de pauta, adiamento) só entra como etapa de uma pauta que teve votação de
 * conteúdo; sozinho, é descartado.
 *
 * Módulo puro, sem import de rede: o robô `scripts/robos/brasilia.ts` busca, normaliza e chama.
 */
import type { Etapa, Pauta, Placar, Resultado } from "./tipos.ts";

/** Tipos de proposição que viram pauta (o resto, como REQ, EMC, RQS, só entra como etapa). */
export const PRINCIPAIS = new Set(["PL", "PLP", "PEC", "MPV", "PDL", "PLV", "PRC", "PRS", "PLN", "PDC", "PLC", "PLS", "PDS", "VET"]);

/* ======================= Câmara ======================= */

export type PropCamara = { id: number; siglaTipo: string; numero: number; ano: number; ementa: string };

export type VotacaoCamara = {
  /** "2648616-28": o número antes do hífen é a proposição em que a votação foi registrada. */
  id: string;
  data: string;
  dataHora: string;
  descricao: string;
  /** 1 aprovado, 0 rejeitado, null sem indicação. */
  aprovacao: number | null;
  /** `proposicoesAfetadas` do detalhe da votação. */
  afetadas: PropCamara[];
  /** `objetosPossiveis` do detalhe da votação. */
  objetos: PropCamara[];
  placar: Placar | null;
};

export type TipoVotacao = "ruido" | "procedimento" | "etapa";

/** Ruído (efeito automático), procedimento (requerimento) ou etapa de conteúdo. */
export function tipoDeVotacao(descricao: string): TipoVotacao {
  const d = descricao.trim();
  if (/^Altera[çc][ãa]o do Regime de Tramita[çc][ãa]o/i.test(d) || /^Realizar o encaminhamento/i.test(d)) return "ruido";
  if (/\brequerimento\b/i.test(d) || /retirad[oa] de pauta|adiamento d|encerramento da discuss|invers[ãa]o d[ae] pauta/i.test(d)) return "procedimento";
  return "etapa";
}

/** A proposição principal a que a votação se refere (id da Câmara), ou null. */
export function alvoDaVotacao(v: VotacaoCamara): number | null {
  const prefixo = Number(v.id.split("-")[0]);
  const principal = (p: PropCamara) => PRINCIPAIS.has(p.siglaTipo);
  const achada =
    v.afetadas.find(principal) ??
    [...v.afetadas, ...v.objetos].find((p) => p.id === prefixo && principal(p)) ??
    v.objetos.find(principal);
  if (achada) return achada.id;
  // Sem detalhe (ou só REQ/EMC no detalhe): vale o prefixo, que o robô confere na ficha.
  const soAcessorios = [...v.afetadas, ...v.objetos].some((p) => p.id === prefixo);
  return !soAcessorios && Number.isInteger(prefixo) && prefixo > 0 ? prefixo : null;
}

const RE_TEXTO_PRINCIPAL = /^(Aprovad|Rejeitad)[oa]s?,?\s(?:[^,]*,\s)?(?:o|a)\s(Projeto|Proposta de Emenda|Medida Provis|Substitutivo|Emenda Substitutiva|Subemenda Substitutiva)/i;
const RE_REDACAO_FINAL = /reda[çc][ãa]o final/i;

export type GrupoCamara = {
  proposicaoId: number;
  /** Ordem cronológica. Ruído fica de fora; procedimento entra como etapa. */
  votacoes: VotacaoCamara[];
  principal: VotacaoCamara;
  resultado: Resultado;
};

/** A votação que decide a pauta: o texto principal; senão a redação final; senão a última etapa. */
export function votacaoPrincipal(vs: VotacaoCamara[]): { v: VotacaoCamara; decisiva: boolean } | null {
  const etapas = vs.filter((v) => tipoDeVotacao(v.descricao) === "etapa");
  const ultima = <T,>(xs: T[]) => xs[xs.length - 1];
  const texto = ultima(etapas.filter((v) => RE_TEXTO_PRINCIPAL.test(v.descricao)));
  if (texto) return { v: texto, decisiva: true };
  const redacao = ultima(etapas.filter((v) => RE_REDACAO_FINAL.test(v.descricao)));
  if (redacao) return { v: redacao, decisiva: true };
  const qualquer = ultima(etapas);
  return qualquer ? { v: qualquer, decisiva: false } : null;
}

function resultadoDe(v: VotacaoCamara, decisiva: boolean): Resultado {
  if (!decisiva) return "outro";
  if (v.aprovacao === 1 || /^Aprovad/i.test(v.descricao)) return "aprovado";
  if (v.aprovacao === 0 || /^Rejeitad/i.test(v.descricao)) return "rejeitado";
  return "outro";
}

/** Agrupa as votações da Câmara por proposição; descarta grupos só de procedimento. */
export function agruparCamara(votacoes: VotacaoCamara[]): GrupoCamara[] {
  const grupos = new Map<number, VotacaoCamara[]>();
  const vistos = new Set<string>();
  for (const v of votacoes) {
    if (vistos.has(v.id) || tipoDeVotacao(v.descricao) === "ruido") continue;
    vistos.add(v.id);
    const alvo = alvoDaVotacao(v);
    if (alvo == null) continue;
    grupos.set(alvo, [...(grupos.get(alvo) ?? []), v]);
  }
  const out: GrupoCamara[] = [];
  for (const [proposicaoId, vs] of grupos) {
    const ordenadas = [...vs].sort((a, b) => a.dataHora.localeCompare(b.dataHora));
    const p = votacaoPrincipal(ordenadas);
    if (!p) continue; // só requerimento: sem pauta, descarta
    out.push({ proposicaoId, votacoes: ordenadas, principal: p.v, resultado: resultadoDe(p.v, p.decisiva) });
  }
  return out.sort((a, b) => b.principal.dataHora.localeCompare(a.principal.dataHora));
}

/** Placar a partir dos votos nominais da Câmara (lista vazia = votação simbólica = null). */
export function placarDosVotos(votos: { tipoVoto?: unknown }[]): Placar | null {
  if (!votos.length) return null;
  const conta = (t: string) => votos.filter((x) => x.tipoVoto === t).length;
  const placar = { sim: conta("Sim"), nao: conta("Não"), abstencao: conta("Abstenção") };
  return placar.sim + placar.nao + placar.abstencao > 0 ? placar : null;
}

/* ======================= Senado ======================= */

/** Um item do resultado da sessão plenária (`/plenario/resultado/{data}`), já normalizado. */
export type ItemSenado = {
  data: string;
  /** "SF" (Senado) ou "CN" (sessão do Congresso). */
  casa: string;
  codigoMateria: number;
  sigla: string;
  numero: number;
  ano: number;
  ementa: string;
  /** Apelido que a pauta dá à matéria, sem parênteses ("Ajuste fiscal"). */
  apelido: string | null;
  /** `descricaoDeliberacao`: "Apreciado", "Retirado", "Adiado"... */
  deliberacao: string;
  textoResultado: string;
};

export type PassosSenado = {
  etapas: Etapa[];
  /** Frase do "Resultado da matéria", quando há. */
  resultadoMateria: string | null;
  destino: string | null;
  /** Placar do "Resultado da matéria", só se ele foi votação nominal. */
  placarMateria: Placar | null;
};

const REQUERIMENTOS = new Set(["RQS", "REQ", "RQN", "RQE", "RQI"]);

/** Lê o `textoResultado` do Senado: etapas (objeto, resultado, placar), resultado da matéria e destino. */
export function passosDoSenado(texto: string, data: string): PassosSenado {
  type Atual = { objeto?: string; descricao?: string; principal?: boolean; nominal?: boolean; votos: Record<string, number> };
  const etapas: Etapa[] = [];
  let resultadoMateria: string | null = null, destino: string | null = null, placarMateria: Placar | null = null;
  let atual: Atual | null = null;
  const fecha = () => {
    if (!atual?.descricao) return void (atual = null);
    const v = atual.votos;
    const placar = atual.nominal && v["sim"] != null && v["nao"] != null ? { sim: v["sim"], nao: v["nao"], abstencao: v["abstencao"] ?? 0 } : null;
    const generico = /requerimento|reda[çc][ãa]o final/i.test(atual.descricao) && atual.objeto;
    const descricao = generico ? `${atual.objeto!.replace(/[.\s]+$/, "")}: ${atual.descricao}` : atual.descricao;
    etapas.push({ data, descricao, placar });
    if (atual.principal) { resultadoMateria = atual.descricao; placarMateria = placar; }
    atual = null;
  };
  const CHAVES: Record<string, string> = { sim: "sim", não: "nao", nao: "nao", abstenção: "abstencao", abstencao: "abstencao" };
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha) continue;
    let m: RegExpMatchArray | null;
    if ((m = linha.match(/^Objeto da delibera[çc][ãa]o:\s*(.*)$/i))) { fecha(); atual = { objeto: m[1]!, votos: {} }; continue; }
    if ((m = linha.match(/^Resultado da mat[ée]ria:\s*(.*)$/i))) { fecha(); atual = { descricao: m[1]!.trim(), principal: true, votos: {} }; continue; }
    if ((m = linha.match(/^Resultado:\s*(.*)$/i))) { atual ??= { votos: {} }; atual.descricao = m[1]!.trim(); continue; }
    if (/^Vota[çc][ãa]o nominal/i.test(linha)) { if (atual) atual.nominal = true; continue; }
    const votos = [...linha.matchAll(/(Sim|N[ãa]o|Absten[çc][ãa]o)\s*:\s*(\d+)/gi)];
    if (votos.length && atual?.nominal) {
      for (const [, k, n] of votos) atual.votos[CHAVES[k!.toLocaleLowerCase("pt-BR")]!] = Number(n);
      continue;
    }
    if (/\bv(ai|ão) (à|ao|a) /i.test(linha) || /^(À|A) promulga[çc][ãa]o/i.test(linha)) destino = linha;
  }
  fecha();
  return { etapas, resultadoMateria, destino, placarMateria };
}

export type GrupoSenado = {
  codigoMateria: number;
  item: ItemSenado;
  etapas: Etapa[];
  resultadoTexto: string;
  /** false quando não houve "Resultado da matéria" (o robô usa a deliberação da ficha, se houver). */
  temResultadoMateria: boolean;
  resultado: Resultado;
  destino: string | null;
  placar: Placar | null;
};

export function resultadoDoTexto(t: string): Resultado {
  if (/^(Aprovad|Mantid)/i.test(t.trim())) return "aprovado";
  if (/^Rejeitad/i.test(t.trim())) return "rejeitado";
  return "outro";
}

/** Agrupa os itens do Senado por matéria; só ficam os apreciados que não são requerimento solto. */
export function agruparSenado(itens: ItemSenado[]): GrupoSenado[] {
  const grupos = new Map<number, ItemSenado[]>();
  for (const it of itens) {
    if (REQUERIMENTOS.has(it.sigla)) continue;
    const apreciado = /^apreciad/i.test(it.deliberacao) || /Resultado( da mat[ée]ria)?:\s*(Aprovad|Rejeitad)/i.test(it.textoResultado);
    if (!apreciado) continue;
    grupos.set(it.codigoMateria, [...(grupos.get(it.codigoMateria) ?? []), it]);
  }
  const out: GrupoSenado[] = [];
  for (const [codigoMateria, its] of grupos) {
    const ordenados = [...its].sort((a, b) => a.data.localeCompare(b.data));
    const ultimo = ordenados[ordenados.length - 1]!;
    const etapas: Etapa[] = [];
    let materia: PassosSenado | null = null;
    let destino: string | null = null;
    for (const it of ordenados) {
      const p = passosDoSenado(it.textoResultado, it.data);
      etapas.push(...p.etapas);
      if (p.resultadoMateria) materia = p;
      destino = p.destino ?? destino;
    }
    if (!etapas.length) continue;
    // Sem "Resultado da matéria" (ex.: votação por partes), vale a última etapa ("...: Aprovada a redação final.").
    const resultadoTexto = materia?.resultadoMateria ?? etapas[etapas.length - 1]!.descricao;
    const frase = materia ? resultadoTexto : resultadoTexto.split(": ").pop()!;
    out.push({
      codigoMateria, item: ultimo, etapas, resultadoTexto, temResultadoMateria: materia !== null,
      resultado: materia || /reda[çc][ãa]o final/i.test(resultadoTexto) ? resultadoDoTexto(frase) : "outro",
      destino, placar: materia?.placarMateria ?? null,
    });
  }
  return out.sort((a, b) => b.item.data.localeCompare(a.item.data));
}

/* ======================= Ordem na tela ======================= */

/** Peso pelo alcance do tipo de norma (PEC muda a Constituição; resolução só a vida interna da Casa). */
const PESO_TIPO: Record<string, number> = { PEC: 5, PLP: 4, MPV: 3, PLV: 3, PL: 3, PLN: 3, VET: 3, PDL: 2, PRC: 1, PRS: 1 };

/**
 * Ordem da semana sem opinião sobre o mérito: tipo de norma, votação disputada (algum placar
 * nominal com pelo menos 10% de "não"), apelido dado pela própria Casa e decisão final; depois a data.
 */
export function pesoDaPauta(p: Pauta): number {
  let peso = PESO_TIPO[p.sigla] ?? 2;
  if (p.etapas.some((e) => e.placar && e.placar.nao >= 0.1 * (e.placar.sim + e.placar.nao))) peso += 2;
  if (p.apelido) peso += 1;
  if (p.resultado === "outro") peso -= 1;
  return peso;
}

export function ordenarPautas(ps: Pauta[]): Pauta[] {
  return [...ps].sort((a, b) => pesoDaPauta(b) - pesoDaPauta(a) || b.data.localeCompare(a.data) || a.id.localeCompare(b.id));
}
