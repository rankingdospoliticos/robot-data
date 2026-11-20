/**
 * Funções puras do robô `scripts/robos/brasilia.ts` que valem teste: histórico de 90 dias, número do
 * processo do STF, contagem da composição por partido e leitura da composição do STF no portal.
 *
 * Módulo puro, sem import de rede ou de Node: o robô importa direto (Node lê o .ts) e o Vitest testa.
 */

import type { MinistroSTF } from "./tipos.ts";

/* ---------------- histórico ---------------- */

export type Cobertura = { inicio: string; fim: string };

const diaMenos = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

/**
 * Precisa da carga longa quando não há histórico, quando ele não começa até `hoje − historicoDias`
 * ou quando ficou um buraco entre o fim dele e o começo da janela curta (robô parado por dias).
 */
export function precisaCarga(cobertura: Cobertura | null, hoje: string, historicoDias: number, inicioCurto: string): boolean {
  if (!cobertura) return true;
  return cobertura.inicio > diaMenos(hoje, historicoDias) || cobertura.fim < inicioCurto;
}

/** Junta por `id` (o novo vence), descarta o que tem `data` antes de `desde`. A ordem fica com quem chama. */
export function juntarPorId<T extends { id: string; data: string }>(antigos: T[], novos: T[], desde: string): T[] {
  const porId = new Map<string, T>();
  for (const x of antigos) porId.set(x.id, x);
  for (const x of novos) porId.set(x.id, x);
  return [...porId.values()].filter((x) => x.data >= desde);
}

/* ---------------- processo do STF ---------------- */

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Acha na notícia o processo que a IA leu ("ADI 7654") tolerando o formato da notícia: "ADI 7.654",
 * "ADI nº 7654", "(ADI) 7654", "ADIs 7654", maiúsculas. Devolve como a notícia escreve
 * ("ADI 7.654"), ou null se a classe com esse número não aparece no texto. Nunca aceita número
 * que não esteja na notícia.
 */
export function processoNaNoticia(processo: string, texto: string): string | null {
  const m = processo.trim().match(/^(\p{L}{1,12})\s*(?:n\.?\s*[º°]?\.?\s*)?(\d[\d.\s]*)/iu);
  if (!m) return null;
  const classe = m[1]!, digitos = m[2]!.replace(/\D/g, "");
  // Entre os dígitos a notícia pode pôr ponto ou espaço ("7.654", "1 234"); depois, nenhum dígito a mais.
  const numero = digitos.split("").join("[.\\s]?");
  const re = new RegExp(`(?<!\\p{L})(${escapar(classe)})s?\\)?\\s*(?:n\\.?\\s*[º°]?\\.?\\s*)?(${numero})(?!\\d|[.\\s]\\d)`, "iu");
  const achado = texto.replace(/\s+/g, " ").match(re);
  return achado ? `${achado[1]} ${achado[2]}` : null;
}

/* ---------------- composição por partido ---------------- */

/** Conta cadeiras por sigla, do maior para o menor (empate: ordem alfabética). Sigla vazia vira "Sem partido". */
export function contarPartidos(siglas: unknown[]): { sigla: string; n: number }[] {
  const cont = new Map<string, number>();
  for (const s of siglas) {
    const sigla = typeof s === "string" && s.trim() ? s.trim() : "Sem partido";
    cont.set(sigla, (cont.get(sigla) ?? 0) + 1);
  }
  return [...cont].map(([sigla, n]) => ({ sigla, n })).sort((a, b) => b.n - a.n || a.sigla.localeCompare(b.sigla, "pt-BR"));
}

/* ---------------- composição do STF (portal.stf.jus.br/ostf/) ---------------- */

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " };
const linhas = (h: string) => h
  .replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, "\n")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m)
  .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

const dataBR = (s: string): string | null => {
  const m = s.match(/^\((\d{2})\/(\d{2})\/(\d{4})\)$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/**
 * Lê o quadro "Composição do Plenário do STF" da página institucional: "Ministro", nome, cargo
 * opcional ("Presidente") e a data entre parênteses (posse no STF; para o Presidente, a página mostra
 * a data da posse na Presidência). O Vice-Presidente sai do quadro "Gestão" ("Min. Fulano" seguido de
 * "Vice-Presidente"). Só entra nome que aparece literalmente no texto da página. A página não diz quem
 * indicou: `indicadoPor` fica null.
 */
export function lerMinistrosDoPortal(html: string): MinistroSTF[] {
  const ls = linhas(html);
  const ini = ls.findIndex((l) => /^Composição do Plenário do STF$/i.test(l));
  if (ini < 0) return [];
  const fim = ls.findIndex((l, i) => i > ini && /TURMA$/i.test(l));
  const bloco = ls.slice(ini + 1, fim > ini ? fim : undefined);
  const out: MinistroSTF[] = [];
  for (let i = 0; i < bloco.length - 1; i++) {
    if (!/^Ministr[oa]$/.test(bloco[i]!)) continue;
    const nome = bloco[i + 1]!;
    if (!/^[A-ZÀ-Ú][A-Za-zÀ-ú'.\- ]{2,60}$/.test(nome)) continue;
    let k = i + 2, cargo: MinistroSTF["cargo"] = null;
    if (bloco[k] === "Presidente") { cargo = "Presidente"; k++; }
    const d = bloco[k] ? dataBR(bloco[k]!) : null;
    out.push({ nome, cargo, posse: cargo === "Presidente" ? null : d, cargoDesde: cargo === "Presidente" ? d : null, indicadoPor: null });
  }
  const vi = ls.findIndex((l, i) => l === "Vice-Presidente" && /^Min\. /.test(ls[i - 1] ?? ""));
  const vice = vi > 0 ? ls[vi - 1]!.replace(/^Min\. /, "") : null;
  const m = vice ? out.find((x) => x.nome === vice) : undefined;
  if (m && !m.cargo) m.cargo = "Vice-Presidente";
  const textoTodo = ls.join("\n");
  return out.filter((x) => textoTodo.includes(x.nome));
}

/* ---------------- pauta do Plenário do STF ---------------- */

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const simples = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Confere um item da pauta lido pela IA contra o texto do post: o processo precisa estar no texto
 * (`processoNaNoticia`) e o relator também, literalmente (sem "Ministro"/"Min.", ignorando maiúsculas
 * e acentos; devolve o nome como o post escreve). A data só fica se o dia e o mês aparecem no texto
 * ("25/11" ou "25 de novembro"); senão vira null. Item que não confere devolve null.
 */
export function conferirItemPauta(item: { data?: unknown; processo?: unknown; tema?: unknown; relator?: unknown }, texto: string): { data: string | null; processo: string; relator: string } | null {
  const processo = typeof item.processo === "string" ? processoNaNoticia(item.processo, texto) : null;
  const rel = typeof item.relator === "string" ? item.relator.replace(/^\s*(ministr[oa]|min\.)\s+/i, "").trim() : "";
  if (!processo || rel.length < 4) return null;
  const plano = texto.replace(/\s+/g, " ").trim();
  const i = simples(plano).indexOf(simples(rel));
  // simples() só tira acento e espaço repetido: o índice vale para o texto já com espaço único.
  if (i < 0) return null;
  const relator = plano.slice(i, i + rel.length);
  let data: string | null = null;
  const m = typeof item.data === "string" ? item.data.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (m) {
    const dia = Number(m[3]), mes = Number(m[2]);
    const re = new RegExp(`(?<!\d)0?${dia}(?:/0?${mes}(?!\d)|º? de ${MESES[mes - 1]})`, "i");
    if (mes >= 1 && mes <= 12 && re.test(plano)) data = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return { data, processo, relator };
}
