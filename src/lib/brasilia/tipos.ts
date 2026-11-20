/**
 * Forma do arquivo `brasilia/semana.json` (ramo `dados` deste repositório) e o leitor que o valida.
 *
 * O arquivo é gerado pelo robô `scripts/robos/brasilia.ts` (GitHub Actions, de hora em hora em dias
 * úteis): votações do Plenário da Câmara e do Senado dos últimos 7 dias, já agrupadas por proposição,
 * com a camada didática escrita pela IA e conferida (números, regras editoriais), mais as decisões do
 * Plenário do STF lidas das notícias oficiais do Supremo.
 *
 * Módulo puro, sem import: roda no navegador, no servidor e no robô (Node lê o .ts direto).
 * Regra do leitor: nada é confiado sem checar. Pauta malformada sai da lista; texto da IA malformado
 * vira `null` (a tela usa o título tirado da ementa); só o arquivo sem `geradoEm` ou sem `pautas`
 * vira `null`. Nenhum valor de reserva é inventado aqui.
 */

export const VERSAO_SEMANA = 1;

export type Casa = "Câmara" | "Senado" | "Congresso";
export type Resultado = "aprovado" | "rejeitado" | "outro";
export type Placar = { sim: number; nao: number; abstencao: number };
export type TermoGlossario = { termo: string; explicacao: string; fonte: "curado" | "ia" };

/** Camada didática gerada pela IA a partir só do texto oficial (ementa, indexação, resultado). */
export type TextoDidatico = {
  /** Resumo do que a pauta representa, sem sigla. */
  titulo: string;
  /** 1 a 2 frases: primeiro o efeito prático, depois o que foi decidido. */
  abertura: string;
  /** Explicação técnica curta. */
  detalhes: string;
};

/** Uma votação (ou etapa) dentro da pauta, com o texto oficial da Casa. */
export type Etapa = { data: string; descricao: string; placar: Placar | null };

export type Pauta = {
  /** "camara:<id da proposição>" ou "senado:<código da matéria>". */
  id: string;
  casa: Casa;
  /** Data (AAAA-MM-DD) da última votação da pauta na semana. */
  data: string;
  sigla: string;
  numero: number;
  ano: number;
  /** "MPV 1398/2026". */
  identificacao: string;
  /** Nome oficial do tipo ("Medida Provisória"), quando a fonte informa. */
  tipo: string | null;
  /** Apelido oficial ("Ajuste fiscal"), quando a Casa dá um. */
  apelido: string | null;
  ementa: string;
  /** Página oficial da proposição na Casa. */
  url: string;
  urlInteiroTeor: string | null;
  resultado: Resultado;
  /** Frase oficial do resultado ("Aprovada a Medida Provisória nº 1.398, de 2026."). */
  resultadoTexto: string;
  /** Para onde vai, como a Casa escreveu ("A matéria vai à sanção."), quando escreveu. */
  destino: string | null;
  /** Placar da votação principal, só quando ela foi nominal e é uma só. */
  placar: Placar | null;
  etapas: Etapa[];
  /** Título de reserva: a ementa oficial encurtada (usado quando `texto` é null). */
  tituloEmenta: string;
  texto: TextoDidatico | null;
  glossario: TermoGlossario[];
  /** Impressão digital da entrada da IA; o robô reaproveita o texto se ela não mudou. */
  hash: string;
};

export type DecisaoSTF = {
  /** "stf:<id da notícia>". */
  id: string;
  data: string;
  /** "decidido" (julgamento concluído) ou "maioria" (maioria formada, julgamento ainda aberto). */
  situacao: "decidido" | "maioria";
  /** Classe e número do processo, como a notícia escreve ("ADI 7654"), quando escreve. */
  processo: string | null;
  /** Título da notícia oficial do STF. */
  tituloOficial: string;
  url: string;
  texto: TextoDidatico | null;
  glossario: TermoGlossario[];
  hash: string;
};

export type EstadoFonte = "ok" | "falhou";

export type Semana = {
  versao: number;
  geradoEm: string;
  periodo: { inicio: string; fim: string };
  fontes: { camara: EstadoFonte; senado: EstadoFonte; stf: EstadoFonte };
  /** Modelo que escreveu a camada didática. */
  modelo: string | null;
  pautas: Pauta[];
  stf: DecisaoSTF[];
};

/* ---------------- leitor tolerante ---------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Solto = any;

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const texto = (v: unknown, max = 4000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const inteiroOk = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const data = (v: unknown): string | null => (typeof v === "string" && DATA.test(v) ? v : null);
/**
 * Só link https de domínio oficial (.leg.br, .jus.br, .gov.br). Os arquivos vêm de um repositório
 * público: se um deles for adulterado, não consegue pôr na tela link para site de terceiro.
 */
const LINK_OFICIAL = /^https:\/\/(?:[a-z0-9-]+\.)+(?:leg|jus|gov)\.br(?::\d+)?(?:[/?#]\S*)?$/i;
const url = (v: unknown): string | null => (typeof v === "string" && LINK_OFICIAL.test(v) ? v : null);
const lista = (v: unknown): Solto[] => (Array.isArray(v) ? v : []);

export function lerPlacar(v: Solto): Placar | null {
  const sim = inteiroOk(v?.sim), nao = inteiroOk(v?.nao), abstencao = inteiroOk(v?.abstencao);
  if (sim == null || nao == null || abstencao == null || sim + nao + abstencao === 0) return null;
  return { sim, nao, abstencao };
}

export function lerTexto(v: Solto): TextoDidatico | null {
  const titulo = texto(v?.titulo, 200), abertura = texto(v?.abertura, 800), detalhes = texto(v?.detalhes, 1600);
  return titulo && abertura && detalhes ? { titulo, abertura, detalhes } : null;
}

export function lerGlossario(v: unknown): TermoGlossario[] {
  const out: TermoGlossario[] = [];
  for (const t of lista(v)) {
    const termo = texto(t?.termo, 60), explicacao = texto(t?.explicacao, 400);
    if (termo && explicacao) out.push({ termo, explicacao, fonte: t?.fonte === "curado" ? "curado" : "ia" });
  }
  return out;
}

const CASAS: Casa[] = ["Câmara", "Senado", "Congresso"];
const RESULTADOS: Resultado[] = ["aprovado", "rejeitado", "outro"];

export function lerPauta(p: Solto): Pauta | null {
  const id = texto(p?.id, 80), casa = CASAS.find((c) => c === p?.casa), d = data(p?.data);
  const sigla = texto(p?.sigla, 12), numero = inteiroOk(p?.numero), ano = inteiroOk(p?.ano);
  const ementa = texto(p?.ementa), link = url(p?.url), resultadoTexto = texto(p?.resultadoTexto, 1200);
  const tituloEmenta = texto(p?.tituloEmenta, 300) ?? ementa;
  if (!id || !casa || !d || !sigla || numero == null || ano == null || !ementa || !link || !resultadoTexto || !tituloEmenta) return null;
  const etapas: Etapa[] = [];
  for (const e of lista(p?.etapas)) {
    const de = data(e?.data), desc = texto(e?.descricao, 1200);
    if (de && desc) etapas.push({ data: de, descricao: desc, placar: lerPlacar(e?.placar) });
  }
  return {
    id, casa, data: d, sigla, numero, ano,
    identificacao: texto(p?.identificacao, 40) ?? `${sigla} ${numero}/${ano}`,
    tipo: texto(p?.tipo, 80), apelido: texto(p?.apelido, 120), ementa, url: link,
    urlInteiroTeor: url(p?.urlInteiroTeor),
    resultado: RESULTADOS.find((r) => r === p?.resultado) ?? "outro",
    resultadoTexto, destino: texto(p?.destino, 300), placar: lerPlacar(p?.placar), etapas,
    tituloEmenta, texto: lerTexto(p?.texto), glossario: lerGlossario(p?.glossario), hash: texto(p?.hash, 128) ?? "",
  };
}

export function lerDecisao(s: Solto): DecisaoSTF | null {
  const id = texto(s?.id, 80), d = data(s?.data), tituloOficial = texto(s?.tituloOficial, 300), link = url(s?.url);
  const situacao = s?.situacao === "decidido" || s?.situacao === "maioria" ? s.situacao : null;
  if (!id || !d || !tituloOficial || !link || !situacao) return null;
  return { id, data: d, situacao, processo: texto(s?.processo, 60), tituloOficial, url: link, texto: lerTexto(s?.texto), glossario: lerGlossario(s?.glossario), hash: texto(s?.hash, 128) ?? "" };
}

const estado = (v: unknown): EstadoFonte => (v === "ok" ? "ok" : "falhou");

/**
 * Valida o arquivo inteiro; null se não tem `geradoEm` ou `pautas`. Serve para `semana.json` (últimos
 * 7 dias) e para `historico.json` (mesma forma, últimos 90 dias; os campos a mais do robô, como
 * `cobertura` e `stfIgnoradas`, são ignorados aqui).
 */
export function lerSemana(bruto: Solto): Semana | null {
  const geradoEm = texto(bruto?.geradoEm, 40);
  if (!geradoEm || Number.isNaN(Date.parse(geradoEm)) || !Array.isArray(bruto?.pautas)) return null;
  const inicio = data(bruto?.periodo?.inicio), fim = data(bruto?.periodo?.fim);
  if (!inicio || !fim) return null;
  const pautas = lista(bruto.pautas).map(lerPauta).filter((p): p is Pauta => p !== null);
  const stf = lista(bruto.stf).map(lerDecisao).filter((s): s is DecisaoSTF => s !== null);
  return {
    versao: inteiroOk(bruto.versao) ?? 0,
    geradoEm,
    periodo: { inicio, fim },
    fontes: { camara: estado(bruto?.fontes?.camara), senado: estado(bruto?.fontes?.senado), stf: estado(bruto?.fontes?.stf) },
    modelo: texto(bruto.modelo, 80),
    pautas,
    stf,
  };
}

/* ---------------- brasilia/composicao.json ---------------- */

export const VERSAO_COMPOSICAO = 1;

/** Cadeiras por partido numa Casa, contadas da lista oficial de parlamentares em exercício. */
export type Bancada = {
  total: number;
  /** Do maior para o menor. */
  partidos: { sigla: string; n: number }[];
  fonte: string;
  url: string;
  /** Leitura (ISO) que trouxe esta contagem; o robô relê a cada execução e só troca quando a contagem muda. */
  lidoEm: string;
};

/** Casa que nunca respondeu fica null; se falhar depois, o robô mantém o valor anterior dela. */
export type Composicao = { versao: number; geradoEm: string; camara: Bancada | null; senado: Bancada | null };

export function lerBancada(v: Solto): Bancada | null {
  const total = inteiroOk(v?.total), fonteB = texto(v?.fonte, 120), link = url(v?.url), lidoEm = texto(v?.lidoEm, 40);
  if (!total || !fonteB || !link || !lidoEm || Number.isNaN(Date.parse(lidoEm))) return null;
  const partidos: { sigla: string; n: number }[] = [];
  for (const p of lista(v?.partidos)) {
    const sigla = texto(p?.sigla, 30), n = inteiroOk(p?.n);
    if (sigla && n) partidos.push({ sigla, n });
  }
  if (!partidos.length || partidos.reduce((s, p) => s + p.n, 0) !== total) return null;
  return { total, partidos: partidos.sort((a, b) => b.n - a.n), fonte: fonteB, url: link, lidoEm };
}

/** null se não tem `geradoEm`; Casa malformada vira null. */
export function lerComposicao(bruto: Solto): Composicao | null {
  const geradoEm = texto(bruto?.geradoEm, 40);
  if (!geradoEm || Number.isNaN(Date.parse(geradoEm))) return null;
  return { versao: inteiroOk(bruto?.versao) ?? 0, geradoEm, camara: lerBancada(bruto?.camara), senado: lerBancada(bruto?.senado) };
}

/* ---------------- brasilia/stf.json ---------------- */

export const VERSAO_STF = 1;

export type MinistroSTF = {
  /** Como o portal do STF escreve ("Cármen Lúcia"). */
  nome: string;
  cargo: "Presidente" | "Vice-Presidente" | null;
  /** Posse no STF (AAAA-MM-DD), quando a página mostra. Para o Presidente a página mostra só `cargoDesde`. */
  posse: string | null;
  /** Posse no cargo de Presidente, quando a página mostra. */
  cargoDesde: string | null;
  /** Quem indicou. A página oficial usada hoje não traz: fica null. */
  indicadoPor: string | null;
};

/** Item da pauta do Plenário. `processo` e `relator` aparecem no texto do post. */
export type ItemPautaSTF = { data: string | null; processo: string; tema: string | null; relator: string };

export type PautaSTF = {
  /** Título, endereço e data do post de notícias do STF que apresenta a pauta. */
  titulo: string;
  url: string;
  data: string;
  itens: ItemPautaSTF[];
  hash: string;
};

export type STFExtra = {
  versao: number;
  geradoEm: string;
  ministros: { lista: MinistroSTF[]; fonte: string; url: string; lidoEm: string } | null;
  pauta: PautaSTF | null;
};

const CARGOS = ["Presidente", "Vice-Presidente"] as const;

export function lerMinistro(v: Solto): MinistroSTF | null {
  const nome = texto(v?.nome, 80);
  if (!nome) return null;
  return { nome, cargo: CARGOS.find((c) => c === v?.cargo) ?? null, posse: data(v?.posse), cargoDesde: data(v?.cargoDesde), indicadoPor: texto(v?.indicadoPor, 80) };
}

export function lerItemPautaSTF(v: Solto): ItemPautaSTF | null {
  const processo = texto(v?.processo, 60), relator = texto(v?.relator, 80);
  return processo && relator ? { data: data(v?.data), processo, tema: texto(v?.tema, 600), relator } : null;
}

/** null se não tem `geradoEm`; parte malformada vira null (ministros fora de 9 a 11 nomes também). */
export function lerSTFExtra(bruto: Solto): STFExtra | null {
  const geradoEm = texto(bruto?.geradoEm, 40);
  if (!geradoEm || Number.isNaN(Date.parse(geradoEm))) return null;
  const m = bruto?.ministros;
  const listaM = lista(m?.lista).map(lerMinistro).filter((x): x is MinistroSTF => x !== null);
  const fonteM = texto(m?.fonte, 120), urlM = url(m?.url), lidoEm = texto(m?.lidoEm, 40);
  const ministros = listaM.length >= 9 && listaM.length <= 11 && fonteM && urlM && lidoEm ? { lista: listaM, fonte: fonteM, url: urlM, lidoEm } : null;
  const p = bruto?.pauta;
  const tituloP = texto(p?.titulo, 300), urlP = url(p?.url), dataP = data(p?.data);
  const itens = lista(p?.itens).map(lerItemPautaSTF).filter((x): x is ItemPautaSTF => x !== null);
  const pauta = tituloP && urlP && dataP && itens.length ? { titulo: tituloP, url: urlP, data: dataP, itens, hash: texto(p?.hash, 128) ?? "" } : null;
  return { versao: inteiroOk(bruto?.versao) ?? 0, geradoEm, ministros, pauta };
}
