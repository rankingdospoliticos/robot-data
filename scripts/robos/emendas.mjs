#!/usr/bin/env node
/**
 * Robô das emendas parlamentares. Baixa o arquivo completo do Portal da Transparência (sem chave),
 * soma o que foi pago por município (código IBGE de 7 dígitos) e por ano, e escreve arquivos
 * pequenos por UF para o ramo `dados` do repositório:
 *
 *   <saida>/emendas/indice.json   anos disponíveis, data da fonte, qualidade do casamento
 *   <saida>/emendas/<UF>.json     um por estado (e DF), com todos os municípios e anos
 *
 * Fonte: https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/UNICO
 * (ZIP, CSV latin1 com ";", atualizado todo dia). A regra de agregação está em
 * src/lib/emendas/agregar.ts e o formato de saída em src/lib/emendas/formato.ts.
 *
 * Uso:
 *   node scripts/robos/emendas.mjs --saida ../dados
 *   node scripts/robos/emendas.mjs --saida ./dados --zip caminho/EmendasParlamentares.zip   (sem baixar)
 *
 * Node 22.18+ (lê os .ts direto). Precisa do `unzip` no PATH (o runner ubuntu tem). Sem dependências.
 * Se qualquer parte falhar, sai com erro e não escreve nada: o ramo `dados` mantém o último bom.
 */
import { spawn } from "node:child_process";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GRUPOS_LOCAIS,
  TIPOS_DE_EMENDA,
  areaPorEmenda,
  dividirLinhaCsv,
  maiores,
  montarMapa,
  novoResultado,
  numeroBR,
  somarPagamento,
} from "../../src/lib/emendas/agregar.ts";

const URL_FONTE = "https://portaldatransparencia.gov.br/download-de-dados/emendas-parlamentares/UNICO";
const URL_IBGE = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado";
const ARQ_FAVORECIDO = "EmendasParlamentares_PorFavorecido.csv";
const ARQ_EMENDAS = "EmendasParlamentares.csv";
const UA = { "user-agent": "ObservatorioRanking/1.0 (dados publicos; robo de emendas)" };
const MAX_AUTORES = 5;
const MAX_AREAS = 6;

function args() {
  const a = process.argv.slice(2);
  const pega = (nome) => {
    const i = a.indexOf(nome);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return { saida: resolve(pega("--saida") ?? "./dados"), zip: pega("--zip") };
}

async function comTentativas(rotulo, fn, vezes = 3) {
  let erro;
  for (let i = 1; i <= vezes; i++) {
    try {
      return await fn();
    } catch (e) {
      erro = e;
      console.error(`${rotulo}: tentativa ${i}/${vezes} falhou (${e instanceof Error ? e.message : e})`);
      if (i < vezes) await new Promise((r) => setTimeout(r, 4000 * i));
    }
  }
  throw erro;
}

async function listaDoIbge() {
  const bruto = await comTentativas("IBGE", async () => {
    const res = await fetch(URL_IBGE, { headers: UA, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`IBGE ${res.status}`);
    return res.json();
  });
  const lista = (Array.isArray(bruto) ? bruto : [])
    .map((m) => ({ id: String(m["municipio-id"] ?? ""), nome: String(m["municipio-nome"] ?? ""), uf: String(m["UF-sigla"] ?? "") }))
    .filter((m) => /^\d{7}$/.test(m.id) && m.nome && /^[A-Z]{2}$/.test(m.uf));
  if (lista.length < 5500) throw new Error(`IBGE devolveu só ${lista.length} municípios`);
  return lista;
}

/** Baixa o ZIP para a pasta temporária e devolve o caminho e a data de atualização da fonte. */
async function baixarZip(pasta) {
  const destino = join(pasta, "emendas.zip");
  const atualizadoEm = await comTentativas("download", async () => {
    const res = await fetch(URL_FONTE, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destino));
    const lm = res.headers.get("last-modified");
    return lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString().slice(0, 10) : null;
  });
  const { size } = await stat(destino);
  if (size < 1_000_000) throw new Error(`ZIP pequeno demais (${size} bytes)`);
  return { zip: destino, atualizadoEm };
}

/** Lê um CSV de dentro do ZIP (latin1, ";") e chama `linha(campos, indice)` para cada registro. */
async function lerCsv(zip, nome, linha) {
  const filho = spawn("unzip", ["-p", zip, nome], { stdio: ["ignore", "pipe", "inherit"] });
  const saiu = new Promise((ok, falha) => {
    filho.on("error", falha);
    filho.on("close", (cod) => (cod === 0 ? ok() : falha(new Error(`unzip ${nome} saiu com ${cod}`))));
  });
  filho.stdout.setEncoding("latin1");
  const rl = createInterface({ input: filho.stdout, crlfDelay: Infinity });
  let indice = null;
  let n = 0;
  for await (const l of rl) {
    if (!l) continue;
    const campos = dividirLinhaCsv(l);
    if (!indice) {
      indice = Object.fromEntries(campos.map((c, i) => [c.trim(), i]));
      continue;
    }
    n++;
    linha(campos, indice);
  }
  await saiu;
  if (!indice || n === 0) throw new Error(`${nome} sem linhas`);
  return n;
}

function exigir(indice, nome, colunas) {
  const falta = colunas.filter((c) => !(c in indice));
  if (falta.length) throw new Error(`${nome}: colunas ausentes: ${falta.join(" | ")}`);
}

const reais = (v) => Math.round(v);

function montarArquivoUF(uf, municipios, resultado, autores, areas, atualizadoEm) {
  const idsAutor = new Map();
  const idsArea = new Map();
  const posicao = (mapa, lista, nome) => {
    let i = mapa.get(nome);
    if (i === undefined) {
      i = lista.length;
      lista.push(nome);
      mapa.set(nome, i);
    }
    return i;
  };
  const saida = {};
  for (const m of municipios) {
    const porAno = resultado.celulas.get(m.id);
    if (!porAno) continue;
    const anos = {};
    for (const ano of [...porAno.keys()].sort((a, b) => a - b)) {
      const c = porAno.get(ano);
      if (!(c.total > 0)) continue;
      anos[ano] = {
        t: reais(c.total),
        p: TIPOS_DE_EMENDA.map((t) => reais(c.porTipo[t] ?? 0)),
        q: GRUPOS_LOCAIS.map((g) => reais(c.porGrupo[g] ?? 0)),
        g: reais(Math.max(0, c.porGrupo.gov ?? 0)),
        a: maiores(c.autores, MAX_AUTORES).map(([nome, v]) => [posicao(idsAutor, autores, nome), reais(v)]),
        f: maiores(c.areas, MAX_AREAS).map(([nome, v]) => [posicao(idsArea, areas, nome), reais(v)]),
      };
    }
    if (Object.keys(anos).length) saida[m.id] = { nome: m.nome, anos };
  }
  return { v: 1, uf, fonteAtualizadaEm: atualizadoEm, autores, areas, municipios: saida };
}

async function main() {
  const { saida, zip: zipLocal } = args();
  const lista = await listaDoIbge();
  const mapa = montarMapa(lista);
  console.log(`IBGE: ${lista.length} municípios (${mapa.ambiguas.size} nomes ambíguos)`);

  const pasta = await mkdtemp(join(tmpdir(), "emendas-"));
  try {
    let zip = zipLocal;
    let atualizadoEm = null;
    if (zip) {
      if (!existsSync(zip)) throw new Error(`ZIP não encontrado: ${zip}`);
      atualizadoEm = new Date((await stat(zip)).mtime).toISOString().slice(0, 10);
    } else {
      ({ zip, atualizadoEm } = await baixarZip(pasta));
    }
    atualizadoEm ??= new Date().toISOString().slice(0, 10);
    console.log(`Fonte atualizada em ${atualizadoEm}`);

    // 1) área de cada emenda (arquivo principal)
    const funcoes = [];
    await lerCsv(zip, ARQ_EMENDAS, (c, i) => {
      exigir(i, ARQ_EMENDAS, ["Código da Emenda", "Nome Função"]);
      funcoes.push({ emenda: c[i["Código da Emenda"]], funcao: c[i["Nome Função"]] });
    });
    const areas = areaPorEmenda(funcoes);
    funcoes.length = 0;

    // 2) pagamentos por favorecido
    const res = novoResultado();
    const obrigatorias = ["Código da Emenda", "Nome do Autor da Emenda", "Tipo de Emenda", "Ano/Mês", "Tipo Favorecido", "Natureza Jurídica", "UF Favorecido", "Município Favorecido", "Valor Recebido"];
    let anoMesMax = "";
    const linhas = await lerCsv(zip, ARQ_FAVORECIDO, (c, i) => {
      exigir(i, ARQ_FAVORECIDO, obrigatorias);
      const anoMes = c[i["Ano/Mês"]];
      if (/^\d{6}$/.test(anoMes) && anoMes > anoMesMax) anoMesMax = anoMes;
      somarPagamento(
        res,
        mapa,
        {
          emenda: c[i["Código da Emenda"]],
          autor: c[i["Nome do Autor da Emenda"]],
          tipoEmenda: c[i["Tipo de Emenda"]],
          anoMes,
          tipoFavorecido: c[i["Tipo Favorecido"]],
          naturezaJuridica: c[i["Natureza Jurídica"]],
          uf: c[i["UF Favorecido"]],
          municipio: c[i["Município Favorecido"]],
          valor: numeroBR(c[i["Valor Recebido"]]),
        },
        (e) => areas.get(e) ?? null,
      );
    });
    const q = res.qualidade;
    if (linhas < 100000 || res.celulas.size < 3000) throw new Error(`resultado pequeno demais: ${linhas} linhas, ${res.celulas.size} municípios`);

    // 3) arquivos
    const porUF = new Map();
    for (const m of lista) {
      if (!porUF.has(m.uf)) porUF.set(m.uf, []);
      porUF.get(m.uf).push(m);
    }
    const pastaSaida = join(saida, "emendas");
    await mkdir(pastaSaida, { recursive: true });
    const anosComPagamento = new Set();
    const arquivos = {};
    for (const [uf, municipios] of [...porUF.entries()].sort()) {
      municipios.sort((a, b) => a.id.localeCompare(b.id));
      const doc = montarArquivoUF(uf, municipios, res, [], [], atualizadoEm);
      for (const m of Object.values(doc.municipios)) for (const a of Object.keys(m.anos)) anosComPagamento.add(Number(a));
      const json = JSON.stringify(doc);
      await writeFile(join(pastaSaida, `${uf}.json`), json);
      arquivos[uf] = { municipios: Object.keys(doc.municipios).length, bytes: Buffer.byteLength(json) };
    }

    const naoCasaram = [...q.naoCasaram.entries()]
      .map(([chave, v]) => ({ chave, linhas: v.linhas, valor: reais(v.valor) }))
      .sort((a, b) => b.valor - a.valor);
    const indice = {
      v: 1,
      fonteAtualizadaEm: atualizadoEm,
      ultimoMes: anoMesMax ? `${anoMesMax.slice(0, 4)}-${anoMesMax.slice(4)}` : null,
      anos: [...anosComPagamento].sort((a, b) => b - a),
      ufs: [...porUF.keys()].sort(),
      fonte: { nome: "Portal da Transparência (CGU): emendas parlamentares, por favorecido", url: "https://portaldatransparencia.gov.br/emendas" },
      criterio:
        "Soma dos pagamentos (Valor Recebido) à prefeitura e a entidades sem fins lucrativos com sede no município, no ano do pagamento. Empresas, pessoas físicas, governo estadual e federal e estatais ficam fora do total, porque a sede de quem recebe não diz onde o dinheiro foi usado. Favorecidos sem identificação não entram.",
      qualidade: {
        linhasLidas: q.linhas,
        valorLido: reais(q.valorLido),
        semFavorecidoIdentificado: { linhas: q.linhasSemFavorecidoIdentificado, valor: reais(q.valorSemFavorecidoIdentificado) },
        semMunicipio: { linhas: q.linhasSemMunicipio, valor: reais(q.valorSemMunicipio) },
        municipioSemCodigo: { nomes: naoCasaram.length, linhas: naoCasaram.reduce((s, x) => s + x.linhas, 0), valor: naoCasaram.reduce((s, x) => s + x.valor, 0), maiores: naoCasaram.slice(0, 40) },
        linhasSemTipoDeEmenda: q.linhasSemTipoDeEmenda,
        municipiosComPagamento: res.celulas.size,
      },
      arquivos,
    };
    await writeFile(join(pastaSaida, "indice.json"), JSON.stringify(indice, null, 1));
    const maior = Object.entries(arquivos).sort((a, b) => b[1].bytes - a[1].bytes)[0];
    console.log(`OK: ${linhas} linhas, ${res.celulas.size} municípios com pagamento, maior arquivo ${maior[0]} (${(maior[1].bytes / 1024).toFixed(0)} KB)`);
    console.log(`Nomes sem código IBGE: ${naoCasaram.length} (${indice.qualidade.municipioSemCodigo.linhas} linhas)`);
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("Falha no robô de emendas:", e instanceof Error ? e.message : e);
  process.exit(1);
});
