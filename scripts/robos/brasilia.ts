// Robô "O que Brasília decidiu": gera brasilia/semana.json para o ramo `dados`.
//
//   node scripts/robos/brasilia.ts --saida <arquivo.json> [--anterior <arquivo.json>] [--sem-ia] [--hoje AAAA-MM-DD]
//
// Node 22.18+ (lê TypeScript direto). Sem dependência: fetch, node:fs, node:crypto.
// Fontes oficiais, sem chave:
//  - Câmara: /api/v2/votacoes (Plenário, órgão 180), /votacoes/{id}, /votacoes/{id}/votos, /proposicoes/{id}
//  - Senado: /dadosabertos/plenario/resultado/{AAAAMMDD}, /dadosabertos/processo?codigoMateria=, /processo/{id}
//  - STF: notícias oficiais (WordPress do noticias.stf.jus.br, tipo "postsnoticias")
// IA: Claude Haiku 5.5 pela API da Anthropic (ANTHROPIC_API_KEY). Sem chave, publica sem a camada
// didática (título vem da ementa). Texto já gerado é reaproveitado se a entrada da pauta não mudou.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRINCIPAIS, agruparCamara, agruparSenado, placarDosVotos, tipoDeVotacao, ordenarPautas,
  type ItemSenado, type PropCamara, type VotacaoCamara,
} from "../../src/lib/brasilia/agrupar.ts";
import { conferirTexto, explicacaoConfere, tituloDaEmenta } from "../../src/lib/brasilia/editorial.ts";
import { escolherGlossario, textosDaPauta } from "../../src/lib/brasilia/glossario.ts";
import { lerSemana, VERSAO_SEMANA, type DecisaoSTF, type EstadoFonte, type Pauta, type Semana, type TextoDidatico } from "../../src/lib/brasilia/tipos.ts";
import { REGRAS_EDITORIAIS } from "../../src/lib/regras.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Solto = any;

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CAMARA = "https://dadosabertos.camara.leg.br/api/v2";
const SENADO = "https://legis.senado.leg.br/dadosabertos";
const STF = "https://noticias.stf.jus.br/wp-json/wp/v2/postsnoticias";
const UA = "observatorio-ranking-dos-politicos (robo de dados abertos)";
const MODELO = process.env["BRASILIA_MODELO"] ?? "claude-haiku-5-5";
const ESFORCO = process.env["BRASILIA_ESFORCO"] ?? "medium";
/** Mude quando o prompt mudar: força reescrever os textos já gerados. */
const VERSAO_PROMPT = "2026-11-20.5";

/* ---------------- argumentos e ambiente ---------------- */

const args = process.argv.slice(2);
const arg = (nome: string) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : undefined; };
const SAIDA = arg("--saida");
if (!SAIDA) { console.error("uso: node scripts/robos/brasilia.ts --saida <arquivo.json> [--anterior <arquivo>] [--sem-ia]"); process.exit(2); }
const ANTERIOR = arg("--anterior") ?? SAIDA;
const SEM_IA = args.includes("--sem-ia");

/** Carrega a chave do .env.local (só na máquina local; no Actions ela vem do segredo). Nunca imprime. */
function carregarEnvLocal() {
  const arquivo = resolve(RAIZ, ".env.local");
  if (process.env["ANTHROPIC_API_KEY"] || !existsSync(arquivo)) return;
  for (const linha of readFileSync(arquivo, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/);
    if (m) process.env["ANTHROPIC_API_KEY"] = m[1]!.replace(/^["']|["']$/g, "");
  }
}
carregarEnvLocal();
const CHAVE = SEM_IA ? undefined : process.env["ANTHROPIC_API_KEY"];

const hojeBR = arg("--hoje") ?? new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const diaMenos = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const INICIO = diaMenos(hojeBR, 7);
const FIM = hojeBR;

/* ---------------- rede ---------------- */

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
class ErroDefinitivo extends Error {}

async function pegar(url: string, tipo: "json" | "texto" = "json", tentativas = 4): Promise<Solto> {
  let ultimo: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, { headers: { accept: tipo === "json" ? "application/json" : "*/*", "user-agent": UA }, signal: AbortSignal.timeout(40_000) });
      if (r.ok) {
        if (tipo === "texto") return await r.text();
        const corpo = await r.text();
        try { return JSON.parse(corpo); } catch { throw new Error(`não é JSON: ${url}`); }
      }
      if (r.status === 404 || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new ErroDefinitivo(`${r.status} ${url}`);
      ultimo = new Error(`${r.status} ${url}`);
    } catch (e) {
      if (e instanceof ErroDefinitivo) throw e;
      ultimo = e;
    }
    await esperar(1500 * 2 ** i);
  }
  throw ultimo instanceof Error ? ultimo : new Error(String(ultimo));
}

/** Roda `fn` sobre os itens com no máximo `n` ao mesmo tempo (a Câmara dá 504 em rajada). */
async function emLotes<T, R>(itens: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(itens.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length) { const k = i++; out[k] = await fn(itens[k]!); }
  }));
  return out;
}

const lista = (x: unknown): Solto[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const hash = (x: unknown) => createHash("sha256").update(VERSAO_PROMPT + JSON.stringify(x)).digest("hex").slice(0, 32);

/* ---------------- Câmara ---------------- */

type EntradaIA = Record<string, unknown>;
type Bruta = Omit<Pauta, "texto" | "glossario" | "hash" | "tituloEmenta"> & { entrada: EntradaIA };

const prop = (p: Solto): PropCamara => ({ id: Number(p?.id), siglaTipo: String(p?.siglaTipo ?? ""), numero: Number(p?.numero), ano: Number(p?.ano), ementa: String(p?.ementa ?? "") });

async function camara(): Promise<Bruta[]> {
  const brutas: Solto[] = [];
  let url: string | undefined = `${CAMARA}/votacoes?dataInicio=${INICIO}&dataFim=${FIM}&idOrgao=180&itens=100`;
  for (let pag = 0; url && pag < 20; pag++) {
    const r = await pegar(url);
    brutas.push(...lista(r?.dados));
    url = lista(r?.links).find((l) => l?.rel === "next")?.href;
  }
  console.log(`Câmara: ${brutas.length} votações no Plenário de ${INICIO} a ${FIM}`);
  const votacoes: VotacaoCamara[] = await emLotes(brutas, 2, async (v) => {
    const det = await pegar(`${CAMARA}/votacoes/${v.id}`).then((r) => r?.dados ?? {}).catch(() => ({}));
    return {
      id: String(v.id), data: String(v.data ?? "").slice(0, 10), dataHora: String(v.dataHoraRegistro ?? v.data ?? ""),
      descricao: String(v.descricao ?? det.descricao ?? "").trim(), aprovacao: typeof v.aprovacao === "number" ? v.aprovacao : null,
      afetadas: lista(det.proposicoesAfetadas).map(prop), objetos: lista(det.objetosPossiveis).map(prop), placar: null,
    };
  });
  const grupos = agruparCamara(votacoes);
  console.log(`Câmara: ${grupos.length} pautas com votação de conteúdo`);
  const out: Bruta[] = [];
  for (const g of grupos) {
    const ficha = await pegar(`${CAMARA}/proposicoes/${g.proposicaoId}`).then((r) => r?.dados).catch(() => null);
    if (!ficha || !PRINCIPAIS.has(ficha.siglaTipo)) continue;
    // Placar de cada etapa nominal (votos vazios = votação simbólica).
    const formas = new Map<string, "nominal" | "simbólica">();
    await emLotes(g.votacoes.filter((v) => tipoDeVotacao(v.descricao) === "etapa"), 2, async (v) => {
      const votos = await pegar(`${CAMARA}/votacoes/${v.id}/votos`).then((r) => lista(r?.dados)).catch(() => null);
      if (votos == null) return;
      v.placar = placarDosVotos(votos);
      formas.set(v.id, v.placar ? "nominal" : "simbólica");
    });
    const etapas = g.votacoes.map((v) => ({ data: v.data, descricao: v.descricao, placar: v.placar }));
    const st = ficha.statusProposicao ?? {};
    const situacao = [st.descricaoSituacao, st.descricaoTramitacao, st.despacho].filter((x) => typeof x === "string" && x.trim()).join(" · ") || null;
    const data = g.votacoes.reduce((m, v) => (v.data > m ? v.data : m), "");
    const base = {
      id: `camara:${g.proposicaoId}`, casa: "Câmara" as const, data, sigla: ficha.siglaTipo, numero: Number(ficha.numero), ano: Number(ficha.ano),
      identificacao: `${ficha.siglaTipo} ${ficha.numero}/${ficha.ano}`, tipo: ficha.descricaoTipo ?? null, apelido: null,
      ementa: String(ficha.ementa ?? "").trim(), url: `https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=${g.proposicaoId}`,
      urlInteiroTeor: typeof ficha.urlInteiroTeor === "string" ? ficha.urlInteiroTeor.replace(/^http:/, "https:") : null,
      resultado: g.resultado, resultadoTexto: g.principal.descricao, destino: null, placar: g.principal.placar, etapas,
    };
    out.push({
      ...base,
      entrada: {
        casa: "Câmara dos Deputados", identificacao: base.identificacao, tipo: base.tipo, ementa: base.ementa,
        explicacaoOficial: ficha.ementaDetalhada ?? null, palavrasChave: ficha.keywords ? String(ficha.keywords).slice(0, 1200) : null,
        situacaoAtual: situacao,
        votacoes: g.votacoes.map((v) => ({ data: v.data, descricao: v.descricao, forma: formas.get(v.id) ?? null, placar: v.placar })),
        resultado: base.resultadoTexto,
      },
    });
  }
  return out;
}

/* ---------------- Senado ---------------- */

async function senado(): Promise<Bruta[]> {
  const itens: ItemSenado[] = [];
  let falhas = 0;
  for (let d = INICIO; d <= FIM; d = diaMenos(d, -1)) {
    const r = await pegar(`${SENADO}/plenario/resultado/${d.replaceAll("-", "")}`).catch((e) => { falhas++; console.warn(`Senado ${d}: ${e.message}`); return null; });
    for (const s of lista(r?.ResultadoPlenario?.Sessoes?.Sessao)) {
      for (const it of lista(s?.Itens?.Item)) {
        itens.push({
          data: d, casa: String(s.siglaCasa ?? "SF"), codigoMateria: Number(it.codigoMateria), sigla: String(it.siglaMateria ?? ""),
          numero: Number(it.numeroMateria), ano: Number(it.anoMateria), ementa: String(it.ementaPapeleta ?? "").trim(),
          apelido: typeof it.cabecalho === "string" ? it.cabecalho.replace(/[()]/g, "").trim() || null : null,
          deliberacao: String(it.descricaoDeliberacao ?? ""), textoResultado: String(it.textoResultado ?? ""),
        });
      }
    }
  }
  if (falhas > 4) throw new Error("Senado não respondeu na maior parte dos dias");
  const grupos = agruparSenado(itens);
  console.log(`Senado: ${itens.length} itens de pauta, ${grupos.length} pautas apreciadas`);
  const out: Bruta[] = [];
  for (const g of grupos) {
    const resumo = await pegar(`${SENADO}/processo?codigoMateria=${g.codigoMateria}`).then((r) => lista(r)[0] ?? null).catch(() => null);
    const ficha = resumo?.id ? await pegar(`${SENADO}/processo/${resumo.id}`).catch(() => null) : null;
    const it = g.item;
    const ementaOficial = String(ficha?.conteudo?.ementa ?? resumo?.ementa ?? it.ementa).trim();
    const ementa = ementaOficial.charAt(0).toLocaleUpperCase("pt-BR") + ementaOficial.slice(1);
    const deliberacao = ficha?.deliberacao?.tipoDeliberacao as string | undefined;
    const resultadoTexto = g.temResultadoMateria || !deliberacao ? g.resultadoTexto : `${deliberacao}.`;
    const destinoFicha = typeof ficha?.deliberacao?.destino === "string" ? `Destino: ${ficha.deliberacao.destino.replace(/^À/, "à")}.` : null;
    const base = {
      id: `senado:${g.codigoMateria}`, casa: (it.casa === "CN" ? "Congresso" : "Senado") as Pauta["casa"], data: it.data,
      sigla: it.sigla, numero: it.numero, ano: it.ano, identificacao: `${it.sigla} ${it.numero}/${it.ano}`,
      tipo: ficha?.descricaoSigla ?? resumo?.tipoDocumento ?? null, apelido: it.apelido ?? resumo?.apelido ?? null, ementa,
      url: `https://www25.senado.leg.br/web/atividade/materias/-/materia/${g.codigoMateria}`,
      urlInteiroTeor: typeof resumo?.urlDocumento === "string" ? resumo.urlDocumento.replace(/^http:/, "https:") : null,
      resultado: g.temResultadoMateria || !deliberacao ? g.resultado : /aprovad/i.test(deliberacao) ? "aprovado" as const : /rejeitad/i.test(deliberacao) ? "rejeitado" as const : g.resultado,
      resultadoTexto, destino: g.destino ?? destinoFicha, placar: g.placar, etapas: g.etapas,
    };
    out.push({
      ...base,
      entrada: {
        casa: base.casa === "Congresso" ? "Congresso Nacional (sessão conjunta)" : "Senado Federal", identificacao: base.identificacao, tipo: base.tipo,
        apelidoOficial: base.apelido, ementa, ...(it.ementa && it.ementa !== ementaOficial ? { ementaNaPautaDoDia: it.ementa } : {}), palavrasChaveDaIndexacao: ficha?.documento?.indexacao ? String(ficha.documento.indexacao).replace(/\s+/g, " ").slice(0, 1500) : null,
        situacaoAtual: ficha?.situacaoAtual ?? resumo?.situacaoAtual ?? null,
        // Sem placar e com decisão ("Aprovado...", "Rejeitada...") = simbólica; retirada de destaque não foi votação.
        votacoes: g.etapas.map((e) => ({ data: e.data, descricao: e.descricao, forma: e.placar ? "nominal" : /(^|: )(Aprovad|Rejeitad)/.test(e.descricao) ? "simbólica" : null, placar: e.placar })),
        resultado: resultadoTexto, destino: base.destino,
      },
    });
  }
  return out;
}

/* ---------------- IA ---------------- */

let tokensEntrada = 0, tokensSaida = 0, chamadas = 0;

const GLOSSARIO_SCHEMA = {
  type: "array",
  items: { type: "object", properties: { termo: { type: "string" }, explicacao: { type: "string" } }, required: ["termo", "explicacao"], additionalProperties: false },
};
const SCHEMA_PAUTA = {
  type: "object",
  properties: { titulo: { type: "string" }, abertura: { type: "string" }, detalhes: { type: "string" }, glossario: GLOSSARIO_SCHEMA },
  required: ["titulo", "abertura", "detalhes", "glossario"],
  additionalProperties: false,
};
const SCHEMA_STF = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: ["decidido", "maioria", "outro"] },
    processo: { type: "string" },
    ...SCHEMA_PAUTA.properties,
  },
  required: ["tipo", "processo", ...SCHEMA_PAUTA.required],
  additionalProperties: false,
};

const REGRAS_DE_ESCRITA = `Escreva em português do Brasil, para quem não acompanha política: frases curtas, voz ativa, palavras do dia a dia, sem juridiquês.

titulo
- Uma manchete clara e neutra que diga o que a decisão faz na vida real. No máximo 12 palavras.
- Comece pelo efeito concreto: quem ganha, quem paga, o que passa a valer ou deixa de valer, quanto custa.
- Se houver apelido oficial (ex.: "Ajuste fiscal"), é assim que o assunto é conhecido: use-o no título ou na abertura.
- Proibido no título: sigla (PL, PEC, MP, ADI...), número de lei ou de processo, "nº", as palavras "projeto", "proposta", "texto" e "matéria", o nome de quem votou e verbos de tramitação ("avança", "aprova", "passa na Câmara").
- Verbo no presente. Exemplos do TOM (não copie o conteúdo): "Governo recebe R$ 300 milhões extras para socorrer cidades em emergência"; "Escolas poderão mudar o calendário por causa da Copa".
- Decisão sobre uma lei de um estado ou de uma cidade: diga qual estado ou cidade. Nunca generalize para o país.

abertura (no máximo 2 frases e 45 palavras)
- Primeira frase: o efeito prático que mais pesa para o cidadão, o centro do assunto, sem repetir o título com outras palavras. Quando os dados mostram impostos, benefícios fiscais, gasto público, dívida, custo do Estado, burocracia ou regras para trabalhar ou para empreender, esse efeito vem primeiro.
- Segunda frase: quem decidiu, o que decidiu e o próximo passo, se os dados disserem (sanção, a outra Casa, promulgação).
- Na abertura não cite data, número de proposta, forma de votação, relator nem etapa interna.

detalhes (2 a 4 frases)
- Mais técnico, ainda simples: o que muda (cite a lei alterada, se os dados citarem), como foi a votação (simbólica ou nominal, placar, destaques, emendas, redação final) e para onde segue.

Como usar os dados
- Quando a ementa for vaga ("novos instrumentos de gestão", "para o fim que especifica"), as palavras-chave da indexação e a explicação oficial mostram o conteúdo real: use-as no título e na abertura para dizer de forma concreta o que muda, em vez de repetir a ementa (ex.: ementa "novos instrumentos de gestão" com palavras-chave "redução, benefício fiscal, limitação, despesa" = "reduz benefícios fiscais e limita despesas").
- Nada de lugar, data, nome ou fato que não esteja escrito nos dados, mesmo que você saiba (ex.: a cidade-sede de um tribunal).
- Nunca fale dos dados em si: nada de "a fonte", "a ementa", "os dados", "as palavras-chave", "a indexação", "os termos oficiais". Escreva direto sobre o assunto. O que os dados não dizem, simplesmente não aparece.
- Termos internos de tramitação ("autógrafos", "DCD", "encaminhamento", "publicação intermediária", "desapensação") não entram. Traduza só o próximo passo que importa: vai ao Senado, vai à Câmara, vai à sanção.

glossario
- Até 4 termos técnicos que uma pessoa comum não conhece e que aparecem EXATAMENTE como você escreveu no titulo, abertura ou detalhes (ex.: "crédito extraordinário", "honorários de sucumbência", "subvenção econômica"). Nada de palavra comum ("ressalva", "mobilização", "sigilo"). Uma frase simples cada, sem números.

Proibido inventar: efeito, valor, número, prazo, beneficiado, motivo, autor de ideia ou opinião que não esteja nos dados. Não diga que algo é polêmico, gerou debate, foi criticado ou comemorado.
Números: só os que estão nos dados. Valor grande vira forma curta com no máximo uma casa decimal, ARREDONDANDO (não cortando): "R$ 6.494.296.446,00" vira "R$ 6,5 bilhões"; "R$ 924.985.960,00" vira "R$ 925 milhões"; "R$ 300.000.000,00" vira "R$ 300 milhões".`;

const SISTEMA_PAUTA = `${REGRAS_EDITORIAIS}

Sua tarefa: explicar uma decisão do Plenário da Câmara ou do Senado. Você recebe SÓ dados oficiais da Casa: ementa, explicação oficial e palavras-chave (quando houver), situação atual, cada votação com o texto oficial e o resultado. Use só isso.
"forma": "simbólica" quer dizer que não houve registro de voto de cada parlamentar; "nominal" traz o placar.

${REGRAS_DE_ESCRITA}`;

const SISTEMA_STF = `${REGRAS_EDITORIAIS}

Sua tarefa: ler uma notícia oficial do Supremo Tribunal Federal (STF) e, se ela relatar uma decisão do PLENÁRIO do STF, explicá-la.
tipo
- "decidido": a notícia relata julgamento concluído pelo Plenário (sessão presencial ou Plenário virtual).
- "maioria": a notícia relata que já há maioria formada no Plenário, mas o julgamento ainda não terminou.
- "outro": decisão individual de um ministro (monocrática), de Turma, ação nova, pauta, julgamento sem maioria, evento, nota ou qualquer outra coisa. Nesse caso deixe titulo, abertura, detalhes e processo vazios e glossario como lista vazia.
processo: classe e número exatamente como escritos na notícia (ex.: "ADI 7654"), ou "" se a notícia não disser.
Com "maioria", o título deixa claro que o julgamento não terminou (ex.: "Maioria do STF ...").

${REGRAS_DE_ESCRITA.replace("o próximo passo, se os dados disserem (sanção, a outra Casa, promulgação)", "o que vale a partir de agora, ou o que falta para o julgamento terminar")}`;

async function chamarIA(sistema: string, conteudo: string, schema: object): Promise<Solto> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": CHAVE!, "anthropic-version": "2026-10-21", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO, max_tokens: 8000, system: sistema,
        output_config: { effort: ESFORCO, format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: conteudo }],
      }),
      signal: AbortSignal.timeout(180_000),
    }).catch((e: Error) => e);
    if (r instanceof Error || r.status === 429 || r.status >= 500) { await esperar(5000 * 2 ** i); continue; }
    const j: Solto = await r.json();
    if (!r.ok) throw new ErroDefinitivo(`IA ${r.status}: ${j?.error?.message ?? ""}`);
    chamadas++; tokensEntrada += j?.usage?.input_tokens ?? 0; tokensSaida += j?.usage?.output_tokens ?? 0;
    if (j.stop_reason !== "end_turn") throw new Error(`IA parou por ${j.stop_reason}`);
    const texto = lista(j.content).find((b) => b?.type === "text")?.text;
    return JSON.parse(texto);
  }
  throw new Error("IA indisponível");
}

type Escrito = { texto: TextoDidatico | null; glossario: { termo: string; explicacao: string }[]; extra?: Solto };

/** Gera e confere; regenera uma vez com a lista de problemas; na segunda falha, devolve sem texto. */
async function escrever(sistema: string, schema: object, entrada: EntradaIA | string, fonte: string[], rotulo: string): Promise<Escrito> {
  if (!CHAVE) return { texto: null, glossario: [] };
  const dados = typeof entrada === "string" ? entrada : JSON.stringify(entrada, null, 1);
  let pedido = `Dados oficiais:\n${dados}`;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    let r: Solto;
    try { r = await chamarIA(sistema, pedido, schema); } catch (e) {
      console.warn(`  IA falhou em ${rotulo}: ${(e as Error).message}`);
      if (e instanceof ErroDefinitivo) throw e;
      return { texto: null, glossario: [] };
    }
    if (r?.tipo === "outro") return { texto: null, glossario: [], extra: r };
    const texto: TextoDidatico = { titulo: String(r?.titulo ?? "").trim(), abertura: String(r?.abertura ?? "").trim(), detalhes: String(r?.detalhes ?? "").trim() };
    const problemas = !texto.titulo || !texto.abertura || !texto.detalhes ? ["campo vazio"] : conferirTexto(texto, fonte);
    if (!problemas.length) {
      const glossario = lista(r?.glossario).filter((g) => typeof g?.explicacao === "string" && explicacaoConfere(g.explicacao, fonte));
      return { texto, glossario, extra: r };
    }
    console.warn(`  ${rotulo}: tentativa ${tentativa} recusada (${problemas.join("; ")})`);
    pedido = `Dados oficiais:\n${dados}\n\nSua resposta anterior foi recusada pela conferência automática: ${problemas.join("; ")}. Escreva de novo corrigindo isso. Resposta recusada:\n${JSON.stringify({ titulo: texto.titulo, abertura: texto.abertura, detalhes: texto.detalhes })}`;
  }
  return { texto: null, glossario: [] };
}

/* ---------------- STF ---------------- */

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", ndash: "–", mdash: "—", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", ordm: "º", ordf: "ª" };
const semHtml = (h: string) => h
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|h\d|li|div)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

const RE_DECISAO = /(decide|derruba|invalida|valida|mant[ée]m|declara|confirma|rejeita|anula|maioria|suspende|garante|reconhece|julga|afasta|define|fixa|autoriza|pro[íi]be|veda|condena|absolve|nega|referenda|inconstitucional|constitucional)/i;
const RE_NAO_DECISAO = /^(Confira|Nota|Informe|Podcast|Supremo na Semana|Direito sem|Projeto|Relator|Ministr[oa]|Presidente)|questiona|aciona|pede ao STF|vai julgar|inaugura|recebe|lança|sedia|propõe|encontro|campanha|audiência/i;

async function stf(anterior: Semana | null, ignoradasAntes: Set<string>): Promise<{ decisoes: DecisaoSTF[]; ignoradas: string[] }> {
  const posts = lista(await pegar(`${STF}?per_page=100&after=${INICIO}T00:00:00&_fields=id,date,link,title,content`));
  const candidatos = posts
    .map((p) => ({ id: Number(p.id), data: String(p.date ?? "").slice(0, 10), url: String(p.link ?? ""), titulo: semHtml(String(p?.title?.rendered ?? "")), corpo: semHtml(String(p?.content?.rendered ?? "")).slice(0, 14_000) }))
    .filter((p) => p.id && p.url.startsWith("https://") && RE_DECISAO.test(p.titulo) && !RE_NAO_DECISAO.test(p.titulo));
  console.log(`STF: ${posts.length} notícias na semana, ${candidatos.length} com cara de decisão`);
  const antes = new Map((anterior?.stf ?? []).map((d) => [d.id, d]));
  const decisoes: DecisaoSTF[] = [];
  const ignoradas: string[] = [];
  for (const p of candidatos) {
    const h = hash({ t: p.titulo, c: p.corpo });
    const id = `stf:${p.id}`;
    const velho = antes.get(id);
    if (velho && velho.hash === h && velho.texto) { decisoes.push(velho); continue; }
    if (ignoradasAntes.has(h)) { ignoradas.push(h); continue; }
    if (!CHAVE) continue; // sem IA não dá para separar decisão do Plenário de decisão individual
    const fonte = [p.titulo, p.corpo];
    const r = await escrever(SISTEMA_STF, SCHEMA_STF, `Título: ${p.titulo}\nData: ${p.data}\n\n${p.corpo}`, fonte, id);
    const tipo = r.extra?.tipo;
    if (tipo !== "decidido" && tipo !== "maioria") { if (r.extra) ignoradas.push(h); continue; }
    const processo = String(r.extra?.processo ?? "").trim();
    const processoConfere = processo && p.corpo.replace(/\s+/g, " ").includes(processo) ? processo : null;
    const textos = r.texto ? [r.texto.abertura, r.texto.detalhes] : [];
    decisoes.push({
      id, data: p.data, situacao: tipo, processo: processoConfere, tituloOficial: p.titulo, url: p.url, texto: r.texto,
      glossario: escolherGlossario(r.glossario, textos), hash: h,
    });
  }
  decisoes.sort((a, b) => b.data.localeCompare(a.data));
  return { decisoes, ignoradas };
}

/* ---------------- montagem ---------------- */

async function didatica(b: Bruta, anterior: Map<string, Pauta>): Promise<Pauta> {
  const { entrada, ...base } = b;
  const h = hash(entrada);
  const tituloEmenta = tituloDaEmenta(base.ementa);
  const velha = anterior.get(base.id);
  let texto: TextoDidatico | null = null;
  let daIA: { termo: string; explicacao: string }[] = [];
  if (velha && velha.hash === h && velha.texto) {
    texto = velha.texto;
    daIA = velha.glossario.filter((g) => g.fonte === "ia");
  } else {
    const r = await escrever(SISTEMA_PAUTA, SCHEMA_PAUTA, entrada, [JSON.stringify(entrada)], base.id);
    texto = r.texto;
    daIA = r.glossario;
  }
  // A tela percorre nesta ordem (e marca o "?" na primeira vez que o termo aparece).
  const textos = textosDaPauta(texto, base);
  return { ...base, tituloEmenta, texto, glossario: escolherGlossario(daIA, textos), hash: h };
}

async function fonte<T>(nome: string, f: () => Promise<T>): Promise<{ estado: EstadoFonte; valor: T | null }> {
  try { return { estado: "ok", valor: await f() }; } catch (e) {
    console.error(`${nome} falhou: ${(e as Error).message}`);
    return { estado: "falhou", valor: null };
  }
}

async function main() {
  const anteriorBruto = existsSync(ANTERIOR) ? JSON.parse(readFileSync(ANTERIOR, "utf8")) : null;
  const anterior = lerSemana(anteriorBruto);
  const pautasAntes = new Map((anterior?.pautas ?? []).map((p) => [p.id, p]));
  const ignoradasAntes = new Set<string>(lista(anteriorBruto?.stfIgnoradas).filter((x) => typeof x === "string"));
  if (!CHAVE) console.warn(SEM_IA ? "IA desligada (--sem-ia)." : "ANTHROPIC_API_KEY ausente: publica sem a camada didática.");

  const [cam, sen] = [await fonte("Câmara", camara), await fonte("Senado", senado)];
  const st = await fonte("STF", () => stf(anterior, ignoradasAntes));

  // Fonte que falhou: mantém as pautas dela da última leitura boa que ainda estão na semana.
  const daCasa = (casas: Pauta["casa"][]) => (anterior?.pautas ?? []).filter((p) => casas.includes(p.casa) && p.data >= INICIO);
  const pautas: Pauta[] = [];
  for (const b of [...(cam.valor ?? []), ...(sen.valor ?? [])]) pautas.push(await didatica(b, pautasAntes));
  if (!cam.valor) pautas.push(...daCasa(["Câmara"]));
  if (!sen.valor) pautas.push(...daCasa(["Senado", "Congresso"]));

  const semana: Semana & { stfIgnoradas: string[] } = {
    versao: VERSAO_SEMANA,
    geradoEm: new Date().toISOString(),
    periodo: { inicio: INICIO, fim: FIM },
    fontes: { camara: cam.estado, senado: sen.estado, stf: st.estado },
    modelo: CHAVE ? MODELO : (anterior?.modelo ?? null),
    pautas: ordenarPautas(pautas),
    stf: st.valor?.decisoes ?? (anterior?.stf ?? []).filter((d) => d.data >= INICIO),
    stfIgnoradas: st.valor?.ignoradas ?? [...ignoradasAntes],
  };
  // Sem mudança de conteúdo, mantém o geradoEm anterior (o ramo dados não ganha commit à toa).
  const semData = (x: Solto) => JSON.stringify({ ...x, geradoEm: "" });
  if (anteriorBruto && semData(anteriorBruto) === semData(semana)) semana.geradoEm = anteriorBruto.geradoEm;

  mkdirSync(dirname(resolve(SAIDA!)), { recursive: true });
  writeFileSync(resolve(SAIDA!), JSON.stringify(semana, null, 1) + "\n");
  const semTexto = semana.pautas.filter((p) => !p.texto).length;
  console.log(`Gravado ${SAIDA}: ${semana.pautas.length} pautas (${semTexto} sem texto da IA), ${semana.stf.length} decisões do STF.`);
  console.log(`IA: ${chamadas} chamadas, ${tokensEntrada} tokens de entrada, ${tokensSaida} de saída (${MODELO}, esforço ${ESFORCO}).`);
  if (cam.estado === "falhou" && sen.estado === "falhou") process.exitCode = 1;
}

await main();
