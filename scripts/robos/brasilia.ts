// Robô "O que Brasília decidiu": gera, no diretório do --saida (brasilia/ no ramo `dados`):
//  - semana.json: votações e decisões dos últimos JANELA_DIAS dias (o contrato de /resumo e do Pergunte);
//  - historico.json: mesma forma, últimos HISTORICO_DIAS dias, mais `cobertura` (período já lido sem
//    falha) e `stfIgnoradas`. Cada execução busca só a janela curta e junta ao histórico por `id`; sem
//    histórico que cubra os 90 dias (ou com buraco), faz UMA carga de 90 dias;
//  - composicao.json: cadeiras por partido na Câmara e no Senado;
//  - stf.json: ministros do STF (no máximo 1 leitura por dia) e a pauta do Plenário mais recente.
//
//   node scripts/robos/brasilia.ts --saida <dir>/semana.json [--anterior <arquivo.json>] [--sem-ia] [--hoje AAAA-MM-DD]
//
// Node 22.18+ (lê TypeScript direto). Sem dependência: fetch, node:fs, node:crypto.
// Fontes oficiais, sem chave:
//  - Câmara: /api/v2/votacoes (Plenário, órgão 180), /votacoes/{id}, /votacoes/{id}/votos, /proposicoes/{id}, /deputados
//  - Senado: /dadosabertos/plenario/resultado/{AAAAMMDD}, /dadosabertos/processo?codigoMateria=, /processo/{id}, /senador/lista/atual
//  - STF: notícias oficiais (WordPress do noticias.stf.jus.br, tipo "postsnoticias") e a página
//    institucional portal.stf.jus.br/ostf/ (composição do Plenário)
// IA: Claude Haiku 5.5 pela API da Anthropic (ANTHROPIC_API_KEY). Sem chave, publica sem a camada
// didática (título vem da ementa). Texto já gerado (na semana ou no histórico) é reaproveitado se a
// entrada da pauta não mudou.
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
import {
  lerComposicao, lerSemana, lerSTFExtra, VERSAO_COMPOSICAO, VERSAO_SEMANA, VERSAO_STF,
  type Bancada, type Composicao, type DecisaoSTF, type EstadoFonte, type ItemPautaSTF, type Pauta, type PautaSTF, type Semana, type STFExtra, type TextoDidatico,
} from "../../src/lib/brasilia/tipos.ts";
import { conferirItemPauta, contarPartidos, juntarPorId, lerMinistrosDoPortal, precisaCarga, processoNaNoticia, type Cobertura } from "../../src/lib/brasilia/coleta.ts";
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
/** Chamadas de IA ao mesmo tempo (a carga de 90 dias faz centenas; uma por vez passaria de 1 hora). */
const IA_PARALELO = 4;

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
/** Dias de semana.json. */
const JANELA_DIAS = 7;
/** Dias de historico.json. */
const HISTORICO_DIAS = 90;
/** A busca curta volta 1 dia a mais que a janela (votação registrada depois da meia-noite, fuso). */
const FOLGA_DIAS = 1;
const INICIO = diaMenos(hojeBR, JANELA_DIAS);
const INICIO_HISTORICO = diaMenos(hojeBR, HISTORICO_DIAS);
const INICIO_CURTO = diaMenos(hojeBR, JANELA_DIAS + FOLGA_DIAS);
const FIM = hojeBR;
const DIR = dirname(resolve(SAIDA));
const ARQ_HISTORICO = resolve(DIR, "historico.json");
const ARQ_COMPOSICAO = resolve(DIR, "composicao.json");
const ARQ_STF = resolve(DIR, "stf.json");
const PORTAL_STF = "https://portal.stf.jus.br/ostf/";

/* ---------------- rede ---------------- */

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
class ErroDefinitivo extends Error {}
/** Requisições HTTP às fontes (cada tentativa conta), para o resumo no fim. */
let requisicoes = 0;

async function pegar(url: string, tipo: "json" | "texto" = "json", tentativas = 4): Promise<Solto> {
  let ultimo: unknown;
  for (let i = 0; i < tentativas; i++) {
    requisicoes++;
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

async function camara(inicio: string): Promise<Bruta[]> {
  const brutas: Solto[] = [];
  // A API recusa intervalo maior que 3 meses: busca em trechos de 30 dias, até 20 páginas de 100 cada.
  for (let ini = inicio; ini <= FIM;) {
    const fim = diaMenos(ini, -29) < FIM ? diaMenos(ini, -29) : FIM;
    let url: string | undefined = `${CAMARA}/votacoes?dataInicio=${ini}&dataFim=${fim}&idOrgao=180&itens=100`;
    for (let pag = 0; url && pag < 20; pag++) {
      const r = await pegar(url);
      brutas.push(...lista(r?.dados));
      url = lista(r?.links).find((l) => l?.rel === "next")?.href;
    }
    if (url) throw new Error(`Câmara: mais de 2.000 votações entre ${ini} e ${fim}`);
    ini = diaMenos(fim, -1);
  }
  console.log(`Câmara: ${brutas.length} votações no Plenário de ${inicio} a ${FIM}`);
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

/** Dias em que o resultado do Senado não respondeu nesta execução (o histórico não marca o período como lido). */
let senadoDiasFalhos = 0;

async function senado(inicio: string): Promise<Bruta[]> {
  const itens: ItemSenado[] = [];
  const dias: string[] = [];
  for (let d = inicio; d <= FIM; d = diaMenos(d, -1)) dias.push(d);
  // Uma chamada por dia (a API não tem intervalo); 2 por vez, na ordem dos dias.
  const respostas = await emLotes(dias, 2, (d) => pegar(`${SENADO}/plenario/resultado/${d.replaceAll("-", "")}`).catch((e) => { senadoDiasFalhos++; console.warn(`Senado ${d}: ${e.message}`); return null; }));
  for (const [k, r] of respostas.entries()) {
    const d = dias[k]!;
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
  if (senadoDiasFalhos > dias.length / 2) throw new Error("Senado não respondeu na maior parte dos dias");
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

type PostSTF = { id: number; data: string; url: string; titulo: string; corpo: string };
const postSTF = (p: Solto): PostSTF => ({ id: Number(p.id), data: String(p.date ?? "").slice(0, 10), url: String(p.link ?? ""), titulo: semHtml(String(p?.title?.rendered ?? "")), corpo: semHtml(String(p?.content?.rendered ?? "")).slice(0, 14_000) });

/** Lê as notícias desde `inicio`, página a página (100 por página, até 30 páginas). */
async function postsDesde(inicio: string): Promise<Solto[]> {
  const posts: Solto[] = [];
  for (let pag = 1; pag <= 30; pag++) {
    const r = await pegar(`${STF}?per_page=100&page=${pag}&after=${inicio}T00:00:00&_fields=id,date,link,title,content`).catch((e) => {
      // Passar da última página dá 400 no WordPress: acabou.
      if (pag > 1 && e instanceof ErroDefinitivo && e.message.startsWith("400")) return [];
      throw e;
    });
    posts.push(...lista(r));
    if (lista(r).length < 100) return posts;
  }
  throw new Error(`STF: mais de 3.000 notícias desde ${inicio}`);
}

async function stf(inicio: string, decisoesAntes: DecisaoSTF[], ignoradasAntes: Set<string>): Promise<{ decisoes: DecisaoSTF[]; ignoradas: string[] }> {
  const posts = await postsDesde(inicio);
  const candidatos = posts.map(postSTF)
    .filter((p) => p.id && p.url.startsWith("https://") && RE_DECISAO.test(p.titulo) && !RE_NAO_DECISAO.test(p.titulo));
  console.log(`STF: ${posts.length} notícias desde ${inicio}, ${candidatos.length} com cara de decisão`);
  const antes = new Map(decisoesAntes.map((d) => [d.id, d]));
  const decisoes: DecisaoSTF[] = [];
  const ignoradas: string[] = [];
  // A carga de 90 dias passa de 100 notícias: IA_PARALELO por vez (a ordem final vem do sort).
  await emLotes(candidatos, IA_PARALELO, async (p) => {
    const h = hash({ t: p.titulo, c: p.corpo });
    const id = `stf:${p.id}`;
    const velho = antes.get(id);
    if (velho && velho.hash === h && velho.texto) { decisoes.push(velho); return; }
    if (ignoradasAntes.has(h)) { ignoradas.push(h); return; }
    if (!CHAVE) return; // sem IA não dá para separar decisão do Plenário de decisão individual
    const fonte = [p.titulo, p.corpo];
    const r = await escrever(SISTEMA_STF, SCHEMA_STF, `Título: ${p.titulo}\nData: ${p.data}\n\n${p.corpo}`, fonte, id);
    const tipo = r.extra?.tipo;
    if (tipo !== "decidido" && tipo !== "maioria") { if (r.extra) ignoradas.push(h); return; }
    const processo = String(r.extra?.processo ?? "").trim();
    const processoConfere = processo ? processoNaNoticia(processo, `${p.titulo}\n${p.corpo}`) : null;
    const textos = r.texto ? [r.texto.abertura, r.texto.detalhes] : [];
    decisoes.push({
      id, data: p.data, situacao: tipo, processo: processoConfere, tituloOficial: p.titulo, url: p.url, texto: r.texto,
      glossario: escolherGlossario(r.glossario, textos), hash: h,
    });
  });
  decisoes.sort((a, b) => b.data.localeCompare(a.data));
  return { decisoes, ignoradas };
}

/** Ministros do portal do STF; no máximo 1 leitura por dia. Fora de 9 a 11 nomes, fica o anterior. */
async function ministrosSTF(antes: STFExtra["ministros"]): Promise<STFExtra["ministros"]> {
  const diaBR = (iso: string) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
  if (antes && diaBR(antes.lidoEm) === hojeBR) return antes;
  const html = await pegar(PORTAL_STF, "texto").catch((e) => { console.warn(`STF ministros: ${e.message}`); return null; });
  const lista = html ? lerMinistrosDoPortal(String(html)) : [];
  if (lista.length < 9 || lista.length > 11) {
    if (html) console.warn(`STF ministros: a página trouxe ${lista.length} nomes; mantém a leitura anterior.`);
    return antes;
  }
  console.log(`STF: ${lista.length} ministros no portal`);
  return { lista, fonte: "Portal do STF — Composição do Plenário", url: PORTAL_STF, lidoEm: new Date().toISOString() };
}

const SCHEMA_PAUTA_STF = {
  type: "object",
  properties: {
    itens: {
      type: "array",
      items: {
        type: "object",
        properties: { data: { type: "string" }, processo: { type: "string" }, tema: { type: "string" }, relator: { type: "string" } },
        required: ["data", "processo", "tema", "relator"], additionalProperties: false,
      },
    },
  },
  required: ["itens"], additionalProperties: false,
};

const SISTEMA_PAUTA_STF = `${REGRAS_EDITORIAIS}

Sua tarefa: ler uma notícia oficial do Supremo Tribunal Federal (STF) que apresenta a pauta de julgamentos do PLENÁRIO e listar cada processo que a notícia diz que o Plenário vai julgar.
Para cada processo:
- processo: classe e número exatamente como escritos na notícia (ex.: "ADI 7654", "RE 1.234.567").
- relator: nome do ministro relator exatamente como escrito na notícia, sem "ministro". Se a notícia não disser o relator daquele processo, não inclua o processo.
- data: dia do julgamento em AAAA-MM-DD, só se a notícia disser o dia; senão "".
- tema: em até 20 palavras simples, do que trata o processo, só com o que a notícia diz; sem número que não esteja nela.
Processo de Turma, de sessão já realizada ou só citado como exemplo não entra. Se a notícia não for uma pauta do Plenário, devolva itens vazio.`;

/** Post mais recente das notícias do STF que apresenta a pauta do Plenário; itens lidos pela IA e conferidos no texto. */
async function pautaSTF(antes: PautaSTF | null): Promise<PautaSTF | null> {
  const r = await pegar(`${STF}?search=pauta&orderby=date&order=desc&per_page=20&_fields=id,date,link,title,content`).catch((e) => { console.warn(`STF pauta: ${e.message}`); return null; });
  if (r == null) return antes;
  const post = lista(r).map(postSTF).find((p) => p.url.startsWith("https://") && /\bpauta/i.test(p.titulo) && /plen[áa]rio|supremo|stf/i.test(`${p.titulo} ${p.corpo.slice(0, 600)}`) && !/turma/i.test(p.titulo));
  if (!post) { console.log("STF: nenhum post recente com a pauta do Plenário."); return null; }
  const h = hash({ t: post.titulo, c: post.corpo });
  if (antes && antes.hash === h) return antes;
  if (!CHAVE) return antes; // sem IA não há como separar os itens; mantém o que havia
  const textoTodo = `${post.titulo}\n${post.corpo}`;
  let lidos: Solto;
  try { lidos = await chamarIA(SISTEMA_PAUTA_STF, `Título: ${post.titulo}\nData: ${post.data}\n\n${post.corpo}`, SCHEMA_PAUTA_STF); } catch (e) {
    console.warn(`STF pauta: IA falhou (${(e as Error).message})`);
    return antes;
  }
  const itens: ItemPautaSTF[] = [];
  for (const it of lista(lidos?.itens)) {
    const ok = conferirItemPauta(it, textoTodo);
    if (!ok || itens.some((x) => x.processo === ok.processo)) continue;
    const tema = typeof it?.tema === "string" && it.tema.trim() && explicacaoConfere(it.tema, [textoTodo]) ? it.tema.trim() : null;
    itens.push({ ...ok, tema });
  }
  console.log(`STF pauta: "${post.titulo}" (${post.data}), ${lista(lidos?.itens).length} itens lidos, ${itens.length} conferidos no texto.`);
  return itens.length ? { titulo: post.titulo, url: post.url, data: post.data, itens, hash: h } : null;
}

/* ---------------- composição por partido ---------------- */

async function bancadaCamara(): Promise<Bancada> {
  const siglas: unknown[] = [];
  let url: string | undefined = `${CAMARA}/deputados?itens=100`;
  for (let pag = 0; url && pag < 20; pag++) {
    const r = await pegar(url);
    for (const d of lista(r?.dados)) siglas.push(d?.siglaPartido);
    url = lista(r?.links).find((l) => l?.rel === "next")?.href;
  }
  if (siglas.length < 400) throw new Error(`Câmara: só ${siglas.length} deputados na lista`);
  return { total: siglas.length, partidos: contarPartidos(siglas), fonte: "Câmara dos Deputados — Dados Abertos", url: `${CAMARA}/deputados`, lidoEm: new Date().toISOString() };
}

async function bancadaSenado(): Promise<Bancada> {
  const url = `${SENADO}/senador/lista/atual.json`;
  const r = await pegar(url);
  const siglas = lista(r?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar).map((p) => p?.IdentificacaoParlamentar?.SiglaPartidoParlamentar);
  if (siglas.length < 70) throw new Error(`Senado: só ${siglas.length} senadores na lista`);
  return { total: siglas.length, partidos: contarPartidos(siglas), fonte: "Senado Federal — Dados Abertos", url, lidoEm: new Date().toISOString() };
}

/** Casa que falhou mantém a anterior; contagem igual à anterior mantém a anterior (com o `lidoEm` dela). */
async function composicao(antes: Composicao | null): Promise<Composicao> {
  const ler = async (nome: string, f: () => Promise<Bancada>, velha: Bancada | null) => {
    try {
      const nova = await f();
      console.log(`${nome}: ${nova.total} cadeiras, ${nova.partidos.length} partidos`);
      return velha && velha.total === nova.total && JSON.stringify(velha.partidos) === JSON.stringify(nova.partidos) ? velha : nova;
    } catch (e) { console.warn(`Composição ${nome} falhou: ${(e as Error).message}`); return velha; }
  };
  return {
    versao: VERSAO_COMPOSICAO, geradoEm: new Date().toISOString(),
    camara: await ler("Câmara", bancadaCamara, antes?.camara ?? null),
    senado: await ler("Senado", bancadaSenado, antes?.senado ?? null),
  };
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

const lerJson = (arq: string): Solto => { try { return existsSync(arq) ? JSON.parse(readFileSync(arq, "utf8")) : null; } catch { return null; } };
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const lerCobertura = (v: Solto): Cobertura | null => (DATA_ISO.test(v?.inicio) && DATA_ISO.test(v?.fim) ? { inicio: v.inicio, fim: v.fim } : null);
const porData = (a: { data: string; id: string }, b: { data: string; id: string }) => b.data.localeCompare(a.data) || a.id.localeCompare(b.id);

/** Grava; sem mudança de conteúdo, mantém o geradoEm anterior (o ramo dados não ganha commit à toa). */
function gravar(arq: string, novo: Solto, anteriorBruto: Solto) {
  const semData = (x: Solto) => JSON.stringify({ ...x, geradoEm: "" });
  if (anteriorBruto && semData(anteriorBruto) === semData(novo)) novo.geradoEm = anteriorBruto.geradoEm;
  mkdirSync(dirname(arq), { recursive: true });
  const corpo = JSON.stringify(novo, null, 1) + "\n";
  writeFileSync(arq, corpo);
  console.log(`Gravado ${arq} (${(Buffer.byteLength(corpo) / 1024).toFixed(0)} KB)`);
}

async function main() {
  const t0 = Date.now();
  const anteriorBruto = lerJson(ANTERIOR);
  const anterior = lerSemana(anteriorBruto);
  const historicoBruto = lerJson(ARQ_HISTORICO);
  const historico = lerSemana(historicoBruto);
  const cobertura = historico ? lerCobertura(historicoBruto?.cobertura) : null;
  // No máximo uma tentativa de carga longa por dia: se uma fonte seguir falhando (bloqueio, dia do
  // Senado com erro), as outras execuções do dia buscam só a janela curta, sem martelar as APIs.
  const cargaTentadaEm = typeof historicoBruto?.cargaTentadaEm === "string" ? historicoBruto.cargaTentadaEm : null;
  const carga = precisaCarga(cobertura, hojeBR, HISTORICO_DIAS, INICIO_CURTO) && cargaTentadaEm !== hojeBR;
  const inicioBusca = carga ? INICIO_HISTORICO : INICIO_CURTO;
  console.log(carga ? `Carga de ${HISTORICO_DIAS} dias (${inicioBusca} a ${FIM}): histórico ausente, curto ou com buraco.` : `Janela curta: ${inicioBusca} a ${FIM}.`);

  // Cache de IA e base da junção: o que já havia na semana e no histórico (o histórico vence).
  const pautasAntigas = juntarPorId(anterior?.pautas ?? [], historico?.pautas ?? [], INICIO_HISTORICO);
  const stfAntigas = juntarPorId(anterior?.stf ?? [], historico?.stf ?? [], INICIO_HISTORICO);
  const pautasAntes = new Map(pautasAntigas.map((p) => [p.id, p]));
  const ignoradasAntes = new Set<string>([...lista(historicoBruto?.stfIgnoradas), ...lista(anteriorBruto?.stfIgnoradas)].filter((x) => typeof x === "string"));
  if (!CHAVE) console.warn(SEM_IA ? "IA desligada (--sem-ia)." : "ANTHROPIC_API_KEY ausente: publica sem a camada didática.");

  const [cam, sen] = [await fonte("Câmara", () => camara(inicioBusca)), await fonte("Senado", () => senado(inicioBusca))];
  const st = await fonte("STF", () => stf(inicioBusca, stfAntigas, ignoradasAntes));

  // Junta ao que já havia: fonte que falhou não apaga nada dela; o dado novo vence pelo id.
  const novas = await emLotes([...(cam.valor ?? []), ...(sen.valor ?? [])], IA_PARALELO, (b) => didatica(b, pautasAntes));
  const pautas = ordenarPautas(juntarPorId(pautasAntigas, novas, INICIO_HISTORICO));
  const decisoes = juntarPorId(stfAntigas, st.valor?.decisoes ?? [], INICIO_HISTORICO).sort(porData);
  const ignoradas = [...new Set([...(st.valor?.ignoradas ?? []), ...ignoradasAntes])].slice(0, 5000);

  // O período só conta como lido quando as três fontes responderam por inteiro.
  const tudoOk = !!cam.valor && !!sen.valor && !!st.valor && senadoDiasFalhos === 0;
  const novaCobertura = tudoOk && (carga || cobertura) ? { inicio: carga ? INICIO_HISTORICO : cobertura!.inicio, fim: FIM } : cobertura;
  const base = { versao: VERSAO_SEMANA, geradoEm: new Date().toISOString(), fontes: { camara: cam.estado, senado: sen.estado, stf: st.estado }, modelo: CHAVE ? MODELO : (historico?.modelo ?? anterior?.modelo ?? null) };
  const hist: Semana & { cobertura: Cobertura | null; cargaTentadaEm: string | null; stfIgnoradas: string[] } = {
    ...base, periodo: { inicio: INICIO_HISTORICO, fim: FIM }, pautas, stf: decisoes, cobertura: novaCobertura,
    cargaTentadaEm: carga ? hojeBR : cargaTentadaEm, stfIgnoradas: ignoradas,
  };
  const semana: Semana & { stfIgnoradas: string[] } = {
    ...base, periodo: { inicio: INICIO, fim: FIM },
    pautas: pautas.filter((p) => p.data >= INICIO), stf: decisoes.filter((d) => d.data >= INICIO),
    stfIgnoradas: st.valor?.ignoradas ?? [...ignoradasAntes],
  };

  // Composição por partido e o extra do STF (ministros e pauta do Plenário).
  const compBruto = lerJson(ARQ_COMPOSICAO), stfBruto = lerJson(ARQ_STF);
  const comp = await composicao(lerComposicao(compBruto));
  const extraAntes = lerSTFExtra(stfBruto);
  const extra: STFExtra = {
    versao: VERSAO_STF, geradoEm: new Date().toISOString(),
    ministros: await ministrosSTF(extraAntes?.ministros ?? null),
    pauta: await pautaSTF(extraAntes?.pauta ?? null),
  };

  gravar(resolve(SAIDA!), semana, anteriorBruto);
  gravar(ARQ_HISTORICO, hist, historicoBruto);
  gravar(ARQ_COMPOSICAO, comp, compBruto);
  gravar(ARQ_STF, extra, stfBruto);
  const conta = (ps: Pauta[], c: Pauta["casa"][]) => ps.filter((p) => c.includes(p.casa)).length;
  for (const [nome, x] of [["semana", semana], ["histórico", hist]] as const) {
    console.log(`${nome}: ${x.pautas.length} pautas (Câmara ${conta(x.pautas, ["Câmara"])}, Senado/Congresso ${conta(x.pautas, ["Senado", "Congresso"])}; ${x.pautas.filter((p) => !p.texto).length} sem texto da IA), ${x.stf.length} decisões do STF.`);
  }
  console.log(`Cobertura do histórico: ${novaCobertura ? `${novaCobertura.inicio} a ${novaCobertura.fim}` : "nenhuma"}.`);
  console.log(`Rede: ${requisicoes} requisições. Duração: ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
  console.log(`IA: ${chamadas} chamadas, ${tokensEntrada} tokens de entrada, ${tokensSaida} de saída (${MODELO}, esforço ${ESFORCO}).`);
  if (cam.estado === "falhou" && sen.estado === "falhou") process.exitCode = 1;
}

await main();
